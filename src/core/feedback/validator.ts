import {
  DEFAULT_MAX_MAIN_FLOW_STEPS,
  DEFAULT_TAG_JARGON_BLOCKLIST,
  type UseCase,
} from "../types.js";

/**
 * Structural validator for the `Partial<UseCase>` shape returned by the LLM.
 *
 * Pure pre-LLM check (zero LLM cost) that catches the malformed-output
 * class of failures: missing summary, empty main flow, no actor, single-step
 * "flow" that's actually just a placeholder. These are the issues that
 * historically slip past `Partial<UseCase>` typing because the LLM emits
 * the keys but with empty / boilerplate values.
 *
 * The chain-of-correction pattern (docs/self-learning.md, signal #6) wires
 * this validator into the extractor: if `validateUseCaseDraft` returns any
 * issues, the extractor re-prompts the LLM ONCE with the issue list as
 * additional context and re-validates. Two-step retry, not full learning;
 * eliminates a class of bad outputs at extract time instead of letting
 * them reach the renderer or audit log.
 *
 * Soft rule (docs/self-learning.md): "prefer string diff / regex / stat
 * over LLM calls." This validator is a stat-style check; countables and
 * presence checks, no model in the loop.
 */

export interface DraftIssue {
  /** Where the issue lives; used to direct the retry prompt. */
  field: keyof UseCase | "structure";
  /** Short human-readable hint suitable for embedding in a follow-up prompt. */
  message: string;
  /** Severity. "error" = MUST retry; "warn" = log but accept. */
  severity: "error" | "warn";
}

export interface ValidateOptions {
  /** Default: DEFAULT_MAX_MAIN_FLOW_STEPS (exported from types.ts). */
  maxMainFlowSteps?: number;
  /** Case-insensitive list of tag strings that warn when matched.
   *  Default: DEFAULT_TAG_JARGON_BLOCKLIST. Pass `[]` to disable. */
  tagJargonBlocklist?: string[];
}

/**
 * The minimum bar a draft must clear before we ship it. Everything that
 * causes a downstream renderer to produce a half-formed page lives here.
 *
 * Intentionally narrow: this validator only flags issues we can clearly
 * articulate to the model in a one-shot retry. Subjective quality (e.g.
 * "is the summary specific enough?") is left to the LLM's confidence
 * self-rating + the edit-back signal (signal #1) downstream.
 */
export function validateUseCaseDraft(
  draft: Partial<UseCase>,
  options: ValidateOptions = {},
): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const maxMainFlowSteps =
    options.maxMainFlowSteps ?? DEFAULT_MAX_MAIN_FLOW_STEPS;

  if (!hasContent(draft.title)) {
    issues.push({
      field: "title",
      severity: "error",
      message:
        "title is empty or whitespace; produce a concise 2-5 word name for this use case that a BA would recognize (e.g., 'Buyer checkout', 'Password reset', 'Order tracking').",
    });
  }

  if (!hasContent(draft.summary)) {
    issues.push({
      field: "summary",
      severity: "error",
      message:
        "summary is empty or whitespace; produce a 1-3 sentence plain-English description of what this use case does.",
    });
  }

  if (!hasContent(draft.actor)) {
    issues.push({
      field: "actor",
      severity: "error",
      message:
        "actor is empty; name the human or system that initiates this use case (e.g., 'Visitor', 'Authenticated buyer', 'CRON job').",
    });
  }

  if (!hasContent(draft.trigger)) {
    issues.push({
      field: "trigger",
      severity: "warn",
      message:
        "trigger is empty; describe what action or event causes this use case to begin (e.g., 'POST /owners/new is submitted from the registration form').",
    });
  }

  const flow = draft.main_flow ?? [];
  if (flow.length < 2) {
    issues.push({
      field: "main_flow",
      severity: "error",
      message: `main_flow has only ${flow.length} step(s); produce at least 2 ordered steps that walk a non-technical reader through the happy path.`,
    });
  }
  if (flow.some((s) => !s || !hasContent(s.step))) {
    // null/undefined entries (a malformed LLM JSON edge case where the
    // model emits `[null, {...}]`) count as "empty step" too. Without the
    // `!s ||` guard, accessing `s.step` would TypeError and crash the
    // entire extract run; the customer would see "Cannot read properties
    // of null" instead of an actionable validator warn.
    issues.push({
      field: "main_flow",
      severity: "error",
      message:
        "one or more main_flow steps have empty `step` text; every step must have a non-empty plain-English sentence.",
    });
  }
  if (flow.length > maxMainFlowSteps) {
    issues.push({
      field: "main_flow",
      severity: "warn",
      message: `main_flow has ${flow.length} steps; consider consolidating to <= ${maxMainFlowSteps} for BA readability (the reader has to take notes past that point).`,
    });
  }

  const post = draft.postconditions ?? [];
  if (post.length === 0) {
    issues.push({
      field: "postconditions",
      severity: "warn",
      message:
        "postconditions is empty; list at least one observable outcome of the happy path (e.g., 'A new Owner row is persisted with id, firstName, lastName').",
    });
  }

  // Tag-content check. Warn-severity (does NOT trigger retry): the
  // page is still publishable, but the audit log surfaces the warning
  // so the operator can see when the LLM is reaching for implementation
  // jargon. Surfaced 2026-05-16 from a ColdBox run that tagged a
  // navigation page with `["ssl","ses","query-string","jsonb"]`, the
  // network/protocol terms are noise for a BA filtering the wiki.
  // Empty blocklist disables the check entirely (a tech-audience
  // customer can opt out via config.validator.tagJargonBlocklist=[]).
  const blocklist = options.tagJargonBlocklist ?? DEFAULT_TAG_JARGON_BLOCKLIST;
  if (blocklist.length > 0) {
    const normalized = new Set(blocklist.map((t) => t.toLowerCase()));
    const tags = draft.tags ?? [];
    const offending = tags.filter(
      (t) => typeof t === "string" && normalized.has(t.toLowerCase()),
    );
    if (offending.length > 0) {
      issues.push({
        field: "tags",
        severity: "warn",
        message: `tags include implementation-detail terms (${offending.join(", ")}); rewrite as business-readable nouns a non-technical reader would recognize as filter criteria.`,
      });
    }
  }

  // Em-dash check (CLAUDE.md § Code style, ADR contract). Error-severity:
  // em dashes are prohibited everywhere (code, docs, prompts, generated
  // output). The SYSTEM_PROMPT forbids them, but this is the runtime
  // defense if the LLM slips. CI's source-file em-dash sweep catches
  // literals in .md/.ts; this catches them in generated markdown.
  const emDash = String.fromCodePoint(0x2014);
  const emDashRegex = new RegExp(emDash, "g");
  const allText = [
    draft.title,
    draft.summary,
    draft.actor,
    draft.trigger,
    draft.preconditions?.join(" "),
    draft.main_flow?.map((s) => [s?.step, s?.footnote].join(" ")).join(" "),
    draft.alternate_flows?.map((s) => [s?.label, s?.description].join(" ")).join(" "),
    draft.postconditions?.join(" "),
    draft.business_rules?.map((r) => [r?.rule, r?.footnote].join(" ")).join(" "),
    draft.test_scenarios?.map((s) => [s?.label, s?.gwt].join(" ")).join(" "),
    draft.related?.map((r) => [r?.title].join(" ")).join(" "),
    draft.confidence_reason,
  ]
    .filter((t) => typeof t === "string")
    .join(" ");

  if (emDashRegex.test(allText)) {
    issues.push({
      field: "structure",
      severity: "error",
      message:
        "output contains em dashes (U+2014); use comma, colon, semicolon, or start a new sentence instead. CLAUDE.md § Code style, ADR contract: em dashes are prohibited everywhere.",
    });
  }

  // Confidence field validation. Error-severity: the schema defines
  // confidence as z.enum(["high", "medium", "low"]), but the validator
  // catches invalid values the LLM might slip through before Zod sees it.
  const validConfidences = ["high", "medium", "low"];
  if (
    draft.confidence &&
    !validConfidences.includes(draft.confidence as string)
  ) {
    issues.push({
      field: "confidence",
      severity: "error",
      message: `confidence is "${draft.confidence}"; must be one of: high, medium, or low.`,
    });
  }

  return issues;
}

/**
 * True if any returned issue is severity "error". Callers use this to
 * decide whether to retry; "warn" issues don't trigger a retry but are
 * worth logging.
 */
export function hasErrors(issues: DraftIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/**
 * Build the additional context to inject on a retry. Returned string is
 * appended to the original prompt so the model has the validator's
 * specific complaint when it tries again.
 */
export function formatRetryHint(issues: DraftIssue[]): string {
  if (issues.length === 0) return "";
  const errorIssues = issues.filter((i) => i.severity === "error");
  const subject = errorIssues.length > 0 ? errorIssues : issues;
  const bullets = subject.map((i) => `- ${i.field}: ${i.message}`).join("\n");
  return `Your previous output had structural problems. Fix these specifically and emit the corrected JSON:\n\n${bullets}`;
}

function hasContent(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * For each compliance-critical parser note prefix (from prompts.ts v13 BLAST
 * RADIUS Notes enumeration), the keyword set that any reasonable English
 * description of the side effect would contain. The validator considers the
 * note "surfaced" if AT LEAST ONE keyword appears in the rendered draft text.
 *
 * Intentionally conservative: only the side-effect categories the v13 prompt
 * instructs the LLM to MUST surface. Auth-related notes (auth: X, roles: X,
 * before_action: X) drive actor inference rather than business_rules and are
 * NOT checked here. Same for low-blast-radius CFML notes (custom tags, ORM
 * function calls, dynamic component instantiation) -- those are informational
 * context, not load-bearing compliance signals.
 *
 * Prefix matching: the parser emits language-specific suffixes like "Sends
 * email (cfmail)" / "Sends email (ActionMailer)" / "Sends email" -- they all
 * share the "Sends email" prefix and the same keyword set applies.
 */
/**
 * Keywords the LLM output must contain for each compliance-critical note.
 * CRITICAL: all keywords MUST be lowercase. The haystack is .toLowerCase()'d
 * at validateNotesPropagated:270 before substring search, so mixed-case
 * keywords (e.g., "removeAll") become dead strings. See the removeAll
 * regression fixed in ac51473 + "matches each cache-mutation keyword in
 * isolation" test in validator.test.ts.
 *
 * Exported for test access only (compliance-keywords-are-lowercase test).
 */
export const NOTE_KEYWORDS: Record<string, string[]> = {
  "Sends email": ["email", "mail", "notification", "notify", "inbox"],
  "Makes outbound HTTP request": ["http", "external service", "external api", "outbound", "api call", "third-party", "request to", "remote", "dependency", "upstream", "external", "calls an"],
  "Enqueues background job": ["background", "asynchronous", "async", "queue", "later", "deferred", "scheduled", "out of band", "trigger"],
  "Publishes Spring application event": ["event", "publish", "subscriber", "listener"],
  "Sends message to broker": ["broker", "kafka", "rabbitmq", "rabbit", "jms", "amqp", "message queue", "topic"],
  "Executes database operations inside a transaction": ["transaction", "atomic", "rollback", "all-or-nothing", "succeed or fail", "all or nothing"],
  "Executes within a database transaction": ["transaction", "atomic", "rollback", "all-or-nothing", "succeed or fail", "all or nothing"],
  "Calls stored procedure": ["stored procedure", "stored-procedure", "sproc", "stored proc"],
  "Writes to file system": ["file", "disk", "filesystem", "upload", "saves", "persisted to", "writes to", "export", "log", "report", "download"],
  // All keywords MUST be lowercase: the haystack is `.toLowerCase()`'d at
  // validateNotesPropagated() before `haystack.includes(k)` runs, so a
  // mixed-case keyword (e.g. `removeAll`) is dead string and never matches.
  // 5b009e5 originally shipped `removeAll` here; the accompanying test
  // false-passed because "cache" was also in every test rule, masking the
  // bug. See the "matches each cache-mutation keyword in isolation" test.
  "Mutates application cache": ["cache", "invalidate", "stale", "evict", "clear", "flush", "removeall", "delete_matched", "delete_pattern"],
  "Executes external process": ["process", "command", "shell", "external program", "binary", "spawns", "invoke"],
};

/**
 * Derived from NOTE_KEYWORDS so it can never drift from the map. Exported
 * solely so the prompt-validator contract test (src/core/llm/prompts.test.ts)
 * can pin that every prefix this validator watches is still mentioned in
 * SYSTEM_PROMPT. A prompt simplification that drops a BLAST RADIUS category
 * without also pruning NOTE_KEYWORDS would silently desync the
 * parser-prompt-validator triangle.
 */
export const COMPLIANCE_NOTE_PREFIXES: readonly string[] =
  Object.keys(NOTE_KEYWORDS);

function findKeywordsFor(note: string): string[] | undefined {
  for (const [prefix, keywords] of Object.entries(NOTE_KEYWORDS)) {
    if (note.startsWith(prefix)) return keywords;
  }
  return undefined;
}

/**
 * Verify that compliance-critical side-effect notes extracted by the parser
 * actually surface in the LLM's output. The v13 BLAST RADIUS prompt instructs
 * the LLM to surface each note as a business rule, main_flow step, or
 * postcondition; this validator closes the loop by checking that the rendered
 * output contains at least one keyword associated with the note category.
 *
 * Severity is "warn" by default so the issue logs into the audit-entry
 * `firstIssues` / `retriedIssues` lists (visible on the /dashboard/audit
 * "Validator-flagged fields" surface) without forcing a retry. Bump to
 * "error" in a future cycle once the keyword sets prove themselves stable.
 */
export function validateNotesPropagated(
  draft: Partial<UseCase>,
  parserNotes: readonly string[] | undefined,
): DraftIssue[] {
  if (!parserNotes || parserNotes.length === 0) return [];
  const haystackParts: string[] = [];
  // Each loop guards against null/undefined entries before dereferencing.
  // Realistic LLM-malformed-JSON failure mode: token-budget overrun or
  // tool-use response stitching can leave entries like `[null, {...}]` in
  // the array. Without the `if (!x) continue` guards, the spread operator
  // in extractor.ts would TypeError and abort the entire generate run with
  // an opaque "Cannot read properties of null" instead of degrading to a
  // warn on the missing compliance signal.
  for (const r of draft.business_rules ?? []) {
    if (!r) continue;
    haystackParts.push(r.rule ?? "", r.footnote ?? "");
  }
  for (const s of draft.main_flow ?? []) {
    if (!s) continue;
    haystackParts.push(s.step ?? "", s.footnote ?? "");
  }
  for (const p of draft.postconditions ?? []) {
    if (typeof p === "string") haystackParts.push(p);
  }
  for (const a of draft.alternate_flows ?? []) {
    if (!a) continue;
    haystackParts.push(a.label ?? "", a.description ?? "");
  }
  const haystack = haystackParts.join(" ").toLowerCase();

  const issues: DraftIssue[] = [];
  for (const note of parserNotes) {
    const keywords = findKeywordsFor(note);
    if (!keywords) continue; // not a compliance-critical note category
    const found = keywords.some((k) => haystack.includes(k));
    if (found) continue;
    issues.push({
      field: "business_rules",
      severity: "warn",
      message: `parser hint note "${note}" was not surfaced in business_rules, main_flow, or postconditions; add a sentence covering this compliance signal so audit / ops readers see it.`,
    });
  }
  return issues;
}
