import type { Candidate, Config, UseCase } from "./types.js";
import { extractWithLLM } from "./llm/client.js";
import {
  formatRetryHint,
  hasErrors,
  validateNotesPropagated,
  validateUseCaseDraft,
  type DraftIssue,
} from "./feedback/validator.js";
import { slugify, stableId } from "./util/slug.js";

/**
 * Injectable LLM seam; defaults to the real client. Tests pass a
 * deterministic stub instead of mocking the entire `llm/client.js`
 * module. Also lets the retry path drive a different invocation
 * without a separate import surface.
 */
export type LlmFn = (opts: {
  candidate: Candidate;
  projectName: string;
  config: Config;
  retryHint?: string;
}) => Promise<unknown>;

const defaultLlmFn: LlmFn = (opts) =>
  extractWithLLM({
    candidate: opts.candidate,
    projectName: opts.projectName,
    config: opts.config,
    retryHint: opts.retryHint,
  });

/**
 * Optional record of what happened in the chain-of-correction retry path.
 * Caller (e.g. `cli/commands/generate.ts`) writes a `retried` audit-log
 * entry when this is non-null, so the customer can see how often the
 * retry helps and which fields most often failed validation. Read by
 * future feedback-loop tooling per `docs/self-learning.md` signals #1
 * (edit-back) and #4 (replay-and-improve).
 */
export interface RetryRecord {
  firstIssues: DraftIssue[];
  retriedIssues: DraftIssue[];
  /** "recovered" = retry produced fewer errors and we kept it.
   *  "no_help" = retry did not reduce errors; we kept the original. */
  outcome: "recovered" | "no_help";
}

export interface ExtractResult {
  useCase: UseCase;
  /** Non-null when the validator flagged the first draft and a retry
   *  fired. Null when the first draft passed validation. */
  retry: RetryRecord | null;
}

/**
 * Run the full extraction pipeline for one candidate:
 *   parser hints -> LLM (or mock) -> validated UseCase.
 *
 * The LLM result is JSON matching the prompt schema; we shape it into
 * the strict UseCase type and add deterministic fields (id, slug, source_files).
 *
 * Chain-of-correction: the LLM draft is run through a structural
 * validator (docs/self-learning.md, signal #6). If the validator
 * reports any error-level issues, we re-prompt ONCE with the issue
 * list as additional context and re-validate. This eliminates the
 * common malformed-output failure mode (empty summary, single-step
 * main_flow, missing actor) before the bad draft ever reaches the
 * renderer or audit log. Bounded one-shot retry; never loops, never
 * exceeds 2 LLM calls per candidate.
 *
 * Returns both the use case AND the retry record so the caller can
 * persist a `retried` audit entry alongside the `generate` entry.
 */
export async function extractUseCase(
  candidate: Candidate,
  projectName: string,
  config: Config,
  meta: { commit: string; generatedAt: string },
  llmFn: LlmFn = defaultLlmFn,
): Promise<ExtractResult> {
  let llmResult = (await llmFn({
    candidate,
    projectName,
    config,
  })) as Partial<UseCase> & {
    title?: string;
    actor?: string;
    summary?: string;
    trigger?: string;
    preconditions?: string[];
    main_flow?: Array<{ step: string; footnote?: string }>;
    alternate_flows?: Array<{ label: string; description: string }>;
    postconditions?: string[];
    business_rules?: Array<{ rule: string; footnote?: string }>;
    test_scenarios?: Array<{ label: string; gwt: string }>;
    related?: Array<{ slug: string; title: string }>;
    tags?: string[];
    confidence?: "high" | "medium" | "low";
    confidence_reason?: string;
  };

  // Chain-of-correction: validate the draft; if errors, retry once with
  // the validator's complaint embedded.
  let retry: RetryRecord | null = null;
  const firstIssues = [
    ...validateUseCaseDraft(llmResult, {
      maxMainFlowSteps: config.validator.maxMainFlowSteps,
      tagJargonBlocklist: config.validator.tagJargonBlocklist,
    }),
    // Verify the parser's compliance-critical side-effect notes (email, HTTP,
    // jobs, transactions, cache, filesystem, process) actually surfaced in
    // the LLM output. Warn-level only -- logged into the audit `firstIssues`
    // for visibility on /dashboard/audit but doesn't trigger a retry.
    ...validateNotesPropagated(llmResult, candidate.hints.notes),
  ];
  if (hasErrors(firstIssues)) {
    const retryHint = formatRetryHint(firstIssues);
    const retried = (await llmFn({
      candidate,
      projectName,
      config,
      retryHint,
    })) as typeof llmResult;
    // Use the retried result IF the second attempt has fewer error-
    // level issues than the first. Otherwise keep the original; the
    // retry didn't actually help and the structured-default fallbacks
    // below will paper over the gaps.
    const retriedIssues = [
      ...validateUseCaseDraft(retried, {
        maxMainFlowSteps: config.validator.maxMainFlowSteps,
        tagJargonBlocklist: config.validator.tagJargonBlocklist,
      }),
      ...validateNotesPropagated(retried, candidate.hints.notes),
    ];
    const firstErrorCount = firstIssues.filter(
      (i) => i.severity === "error",
    ).length;
    const retriedErrorCount = retriedIssues.filter(
      (i) => i.severity === "error",
    ).length;
    const recovered = retriedErrorCount < firstErrorCount;
    if (recovered) {
      llmResult = retried;
    }
    retry = {
      firstIssues,
      retriedIssues,
      outcome: recovered ? "recovered" : "no_help",
    };
  }

  const title =
    typeof llmResult.title === "string" && llmResult.title.length > 0
      ? llmResult.title
      : humanizeName(candidate.name);

  const code2wiki_id = stableId(
    candidate.language,
    candidate.relativePath,
    candidate.name,
  );
  // slugify(title) is empty when the title has no ASCII-alphanumeric
  // characters, e.g. a use-case title the LLM writes entirely in a
  // non-Latin script. An empty slug yields a broken page URL and makes
  // every such page collide on the same empty URL form, so fall back to
  // the humanized method name, then to the always-non-empty code2wiki_id
  // (its `<language>-...` prefix guarantees a sluggable char).
  const slug =
    slugify(title) || slugify(humanizeName(candidate.name)) || code2wiki_id;

  const useCase: UseCase = {
    code2wiki_id,
    title,
    slug,
    actor: llmResult.actor ?? "Unknown caller",
    status: "active",
    last_generated: meta.generatedAt,
    last_commit: meta.commit,
    confidence: llmResult.confidence ?? "low",
    source_files: [
      {
        path: candidate.relativePath,
        lines: `${candidate.lineStart}-${candidate.lineEnd}`,
      },
    ],
    tags: llmResult.tags ?? [candidate.language, candidate.kind],
    summary: llmResult.summary ?? "(no summary produced)",
    actor_detail: llmResult.actor ?? "",
    trigger: llmResult.trigger ?? "",
    preconditions: llmResult.preconditions ?? [],
    main_flow: llmResult.main_flow ?? [],
    alternate_flows: llmResult.alternate_flows ?? [],
    postconditions: llmResult.postconditions ?? [],
    business_rules: llmResult.business_rules ?? [],
    test_scenarios: llmResult.test_scenarios ?? [],
    related: llmResult.related ?? [],
    confidence_reason: llmResult.confidence_reason ?? "",
  };

  return { useCase, retry };
}

function humanizeName(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

