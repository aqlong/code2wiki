import fs from "node:fs";
import type { Candidate } from "../types.js";

/**
 * Manually-bumped prompt version stamp. Bump this whenever the SYSTEM_PROMPT
 * or USER_PROMPT_TEMPLATE materially changes (anything that could shift
 * generated output). Used by:
 *   - audit log: every `generate` + `retried` entry's `details.promptVersion`
 *     records which prompt produced (or failed to produce) that page,
 *     so future replays + edit-back analyses can attribute drift to a
 *     specific prompt version
 *   - `code2wiki replay --since-version v3`: filters the audit log to
 *     entries from prompt v3 forward; the workflow is "edit prompt,
 *     bump PROMPT_VERSION, run replay, see what changes for entries
 *     produced under the OLD version"
 *
 * Format: `v<integer>`. Monotonic. NEVER reuse a version number; once
 * you've bumped, the old version's audit entries are sealed.
 *
 * Bump checklist:
 *   1. Edit SYSTEM_PROMPT / USER_PROMPT_TEMPLATE
 *   2. Increment PROMPT_VERSION (v4 → v5)
 *   3. Run `npm test` (the prompt-version test pins a regex to catch
 *      accidental rollbacks)
 *   4. Optionally `code2wiki replay` against a stable corpus to see the
 *      semantic delta before shipping
 */
export const PROMPT_VERSION = "v4" as const;

/**
 * The system prompt that anchors the LLM in our specific output schema.
 * Kept stable; changes here invalidate the prompt cache.
 */
export const SYSTEM_PROMPT = `You are code2wiki, a tool that turns source code into use-case documentation written for non-technical readers (business analysts, QA engineers, support staff, auditors).

You will be given:
1. A region of source code (a function, controller method, or page handler).
2. Coarse structural hints extracted by the parser (annotations, parameters, called functions, database tables, plugin events).
3. The path of the source file.

You will produce a single JSON object matching this schema:

{
  "title": "Imperative noun phrase, e.g. 'Register a New Pet Owner'",
  "actor": "Who or what initiates this, written as a role, not a class name",
  "summary": "1-3 sentences in plain English. NO technical vocabulary. NO class names.",
  "trigger": "The event that starts this flow",
  "preconditions": ["Bullet 1", "Bullet 2", "..."],
  "main_flow": [
    { "step": "Plain-English step", "footnote": "optional source-line citation" }
  ],
  "alternate_flows": [
    { "label": "Validation failure", "description": "..." }
  ],
  "postconditions": ["Bullet 1", "..."],
  "business_rules": [
    { "rule": "Plain-English rule", "footnote": "optional citation" }
  ],
  "test_scenarios": [
    { "label": "Happy path", "gwt": "Given X, when Y, then Z." }
  ],
  "related": [
    { "slug": "kebab-case-slug", "title": "Title Case" }
  ],
  "tags": ["short", "tag", "list"],
  "confidence": "high|medium|low",
  "confidence_reason": "Short justification"
}

CRITICAL RULES:
- Write for someone who does NOT read code. No method signatures, no class names in the body, no "the controller does X."
- Use the source file path and line citations only in footnotes and the source_files array; never in the prose.
- Test scenarios use Given/When/Then phrasing.
- Always include AT LEAST one alternate flow if the code has any conditional path beyond the happy case.
- Surface IMPLICIT business rules: annotations, init-binders, validators, fallthrough conditions. These are the highest-value items.
- If you are uncertain, mark confidence "low" and explain why; do not invent business meaning that is not in the code.

ACTOR: IDENTIFY THE BROADEST POSSIBLE CALLER:
- For HTTP endpoints, look for ANY authentication or authorization annotations on the method, the class, or referenced filters/middleware. If there are NONE, the actor MUST be described as including unauthenticated visitors or anonymous users.
- Do not default to "staff member" or "admin" unless the code or configuration actually restricts access to them.
- When in doubt about access, frame the actor as the SUPERSET (e.g. "Visitor or staff member") rather than guessing the intended user.
- For non-HTTP code (CFML component methods, background jobs, service classes), do NOT fall back to "internal service" or "internal caller." Instead, infer the actor from the function's domain and name. A publish/deploy method in a publisher or deployment component is invoked by an administrator or a scheduled deployment job; a processPayment method is invoked by a checkout workflow; a sendWelcomeEmail method is triggered by a user registration event. Name the real-world role that has the authority and context to invoke this function, not the technical layer.

BLAST RADIUS: SURFACE THE SCOPE OF SIDE EFFECTS:
- For every database write, file write, cache invalidation, event/notification, or environment-mutating operation, ask: does this affect ONLY the immediate target, or does it also affect other entities, users, sites, tenants, or services?
- Look for patterns that suggest broad blast radius: writes to tables/keys without a tenant or scope filter, "global" or "all" prefixed identifiers, cache flushes without a key, application-scope reloads.
- When the blast radius is broader than the immediate target, surface it as an EXPLICIT business rule with the word "all" (e.g. "This action reloads the application for all sites on the production server, not just the deployed one"). This is one of the highest-value findings to capture for compliance and operations.

OUTPUT FORMAT:
- Output ONLY the JSON object, no preamble or trailing prose.
- FOOTNOTES are for non-obvious details that would surprise a business reader, surprising fallback behavior, implicit constraints, edge cases not visible from the step description. Do NOT add a footnote to every main_flow step. Aim for 0-2 footnotes in main_flow; use more in business_rules where a line citation adds real value. A step like "The system validates the form" does not need a footnote; a step like "Any push mode other than the literal string 'changesOnly' silently triggers a full deployment" does.
- TEST SCENARIOS: aim for 7-10. The happy path counts as ONE. Cover every alternate flow listed in alternate_flows and every non-trivial business rule. Include an explicit "edge case" or "adversarial" scenario (e.g. tampered ID, typo in push-mode argument, empty search, concurrent call). Do not pad with near-duplicates of the happy path.
- SOURCE FILES: in the "related" and source_files fields, include not only the focus file but also any sibling files that are NAMED IN THE CODE (domain classes, repositories, configuration beans, view templates, event objects) whose behavior is load-bearing for this use case. Name them explicitly, do not list files you cannot infer from the source.
- PUNCTUATION: NEVER use the em dash character (U+2014) in any string field. Use a comma, colon, semicolon, or new sentence instead. This rule applies to every text field: title, summary, step descriptions, footnotes, rule text, confidence_reason, everything. Reviewers reject outputs containing em dashes.`;

export function buildUserPrompt(
  candidate: Candidate,
  projectName: string,
): string {
  const hintsSummary = formatHints(candidate);
  const fence = candidate.language === "cfml" ? "cfml" : "java";

  // Read the full file and include it as context. Cross-file business rules
  // (e.g. Spring @InitBinder on the class, validation annotations on
  // sibling DTOs) are CRITICAL for accurate use case extraction. Mark the
  // focus region clearly so the LLM knows which region is the use case.
  // Falls back gracefully to candidate.source for files that fail to read.
  let fullFileSection = "";
  try {
    const fullSource = fs.readFileSync(candidate.filePath, "utf-8");
    const lineCount = fullSource.split("\n").length;
    // Cap at ~3000 lines to keep token cost bounded; for larger files we'd
    // need smarter context selection (a future improvement).
    if (lineCount <= 3000) {
      fullFileSection = `## Full source file (for cross-region context)
The function/region you are documenting is at lines ${candidate.lineStart}-${candidate.lineEnd}.
Use the rest of the file ONLY to identify class-level annotations, @InitBinder,
validation rules, sibling helpers, and other invariants that affect the use case.
Do NOT document those other regions; document only the focus region.

\`\`\`${fence}
${fullSource}
\`\`\`
`;
    }
  } catch {
    // Fall back to region-only context.
  }

  return `## Project: ${projectName}
## Source file: ${candidate.relativePath}
## Focus region: ${candidate.name} (lines ${candidate.lineStart}-${candidate.lineEnd})
## Language: ${candidate.language}
## Kind: ${candidate.kind}

${hintsSummary ? `## Parser hints\n${hintsSummary}\n` : ""}
${fullFileSection}
## Focus region source

\`\`\`${fence}
${candidate.source}
\`\`\`

Produce the JSON use-case description per the schema above. Document ONLY the focus region.`;
}

function formatHints(c: Candidate): string {
  const lines: string[] = [];
  if (c.hints.annotations?.length) {
    lines.push(`Annotations: ${c.hints.annotations.join(", ")}`);
  }
  if (c.hints.httpRoute) {
    lines.push(
      `HTTP route: ${c.hints.httpRoute.method} ${c.hints.httpRoute.path || "(see source)"}`,
    );
  }
  if (c.hints.parameters?.length) {
    lines.push(
      `Parameters: ${c.hints.parameters
        .map((p) => `${p.name}${p.type ? ":" + p.type : ""}`)
        .join(", ")}`,
    );
  }
  if (c.hints.callees?.length) {
    lines.push(`Calls: ${c.hints.callees.slice(0, 15).join(", ")}`);
  }
  if (c.hints.databaseTables?.length) {
    lines.push(`DB tables touched: ${c.hints.databaseTables.join(", ")}`);
  }
  if (c.hints.notes?.length) {
    lines.push(`Notes: ${c.hints.notes.join("; ")}`);
  }
  return lines.join("\n");
}
