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
  if (flow.some((s) => !hasContent(s.step))) {
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
