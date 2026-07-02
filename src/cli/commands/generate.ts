import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../core/config.js";
import { scanProject } from "../../core/scan.js";
import { extractUseCase, type LlmFn } from "../../core/extractor.js";
import { renderUseCase } from "../../core/renderer.js";
import { currentCommit, changedFilesSince } from "../../core/git.js";
import { appendAuditEntry, hashContent, loadSigningKey, type SigningInput } from "../../core/audit.js";
import { PROMPT_VERSION } from "../../core/llm/prompts.js";
import {
  countTokens as defaultCountTokens,
  resolveBackend,
  type CountTokensFn,
} from "../../core/llm/client.js";
import {
  computeEstimate,
  type PerCandidateTokens,
} from "../../core/llm/cost.js";

const COST_WARN_THRESHOLD_USD = 5;

export interface GenerateOptions {
  cwd: string;
  mock?: boolean;
  limit?: number;
  only?: string;
  name?: string;
  /** Only regenerate use cases derived from files that changed since this ref.
   *  Common values: "HEAD~1", "main", "origin/main", "uncommitted". */
  since?: string;
  /** Print a token + USD cost estimate and exit WITHOUT calling the LLM.
   *  Uses anthropic.messages.countTokens (non-billed) per candidate plus
   *  a projected 3000 output tokens/page. See src/core/llm/cost.ts. */
  estimateCost?: boolean;
  /** Injectable LLM function; defaults to the real client. Used in tests
   *  to drive the chain-of-correction retry path without a real API key. */
  llmFn?: LlmFn;
  /** Injectable token-count function; defaults to the real client. Used
   *  in tests so --estimate-cost can be exercised without an API key and
   *  with hand-computed token totals. */
  countTokensFn?: CountTokensFn;
  /** Injectable clock; defaults to new Date().toISOString(). Used in tests
   *  to produce a deterministic last_generated timestamp so two runs over
   *  the same source produce byte-identical output (enabling the
   *  outcome=unchanged path without relying on sub-millisecond timing). */
  now?: () => string;
  /** Skip writing pages whose LLM-rated confidence is below this level.
   *  "low" (default) writes everything; "medium" drops low-confidence pages;
   *  "high" writes only high-confidence pages. */
  minConfidence?: "high" | "medium" | "low";
}

const CONFIDENCE_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };

function meetsConfidenceThreshold(
  confidence: string,
  threshold: string,
): boolean {
  const pageLevel = CONFIDENCE_ORDER[confidence] ?? 1;
  const minLevel = CONFIDENCE_ORDER[threshold] ?? 1;
  return pageLevel >= minLevel;
}

export async function runGenerate(opts: GenerateOptions): Promise<void> {
  // Validate --min-confidence at the boundary. The CLI layer (cli/index.ts)
  // casts the raw flag string straight to the union type with no runtime
  // check, and meetsConfidenceThreshold resolves an unknown threshold to
  // minLevel=1 (= "low" = write EVERYTHING). So a typo or wrong-case value
  // (`--min-confidence HIGH`, `hgih`) would SILENTLY write every page instead
  // of gating, the exact silent-degradation an auditor-minded operator runs
  // this flag to prevent. Fail loud instead. Own-property check so values
  // that exist only on Object.prototype (`constructor`, `toString`) are also
  // rejected. Validated here (not only in commander) so the programmatic
  // worker/dashboard call path is protected too.
  if (
    opts.minConfidence !== undefined &&
    !Object.prototype.hasOwnProperty.call(CONFIDENCE_ORDER, opts.minConfidence)
  ) {
    throw new Error(
      `Invalid --min-confidence "${opts.minConfidence}". Expected one of: ${Object.keys(
        CONFIDENCE_ORDER,
      ).join(", ")}.`,
    );
  }

  const config = await loadConfig(opts.cwd);
  if (opts.mock) config.mock = true;
  if (opts.limit && opts.limit > 0) config.maxCandidates = opts.limit;

  const projectName = path.basename(opts.cwd);
  let candidates = await scanProject(opts.cwd, config);


  // First-run friction guard: when the scan yields zero candidates we used to
  // fall through to a terse "No candidates to process." and exit, which on a
  // wrong --cwd is indistinguishable from "tool is broken." Print WHERE we
  // looked, WHAT extensions we look for, and WHAT TO TRY next. Stderr so any
  // future stdout contract stays clean; exit 0 so CI regen workflows that
  // legitimately run against docs-only commits still no-op cleanly.
  if (candidates.length === 0) {
    console.warn(
      [
        `[code2wiki] No parseable source files found in ${opts.cwd}.`,
        `[code2wiki] Supported languages: Java, CFML (.cfc / .cfm), Ruby (Rails controllers).`,
        `[code2wiki] Looked for files matching these patterns (code2wiki.config.json -> include[]):`,
        ...config.include.map((p) => `[code2wiki]   ${p}`),
        `[code2wiki] Hint: point --cwd at the application source root, or extend include[] in code2wiki.config.json.`,
      ].join("\n"),
    );
    return;
  }

  let work = candidates;
  if (opts.only) {
    const needle = opts.only;
    work = work.filter((c) => c.relativePath.includes(needle));
  }
  if (opts.name) {
    const needle = opts.name;
    // Match suffix so users can pass either "publish" or "ClassName.method".
    work = work.filter(
      (c) => c.name === needle || c.name.endsWith("." + needle),
    );
  }
  if (opts.since) {
    const changed = await changedFilesSince(opts.cwd, opts.since);
    if (changed === null) {
      console.warn(
        `[code2wiki] --since ${opts.since}: git diff failed; falling back to full regeneration.`,
      );
    } else {
      const changedSet = new Set(changed);
      const before = work.length;
      work = work.filter((c) => changedSet.has(c.relativePath));
      console.log(
        `[code2wiki] --since ${opts.since}: ${changed.length} file(s) changed, ${before} -> ${work.length} candidate(s) to regenerate.`,
      );
    }
  }
  if (work.length > config.maxCandidates) {
    // Even-spread sampling instead of `slice(0, N)` so a small --limit
    // gives a REPRESENTATIVE slice of the codebase, not just whatever
    // sorts alphabetically first. The previous behaviour biased
    // toward `app/controllers/...` files in a Wheels-style layout
    // (real-world signal, see `feedback_real_repo_signal.md`); a user
    // running `code2wiki generate --limit 8` to evaluate the tool on
    // their repo got a sample concentrated in one or two directories
    // rather than a fair cross-section.
    //
    // --only / --name / --since filters apply BEFORE this cap, so
    // the legacy "first N alphabetical" behaviour is recoverable by
    // narrowing the filter (`--only some/dir/`).
    console.warn(
      `[code2wiki] Capping at maxCandidates=${config.maxCandidates} (found ${work.length}); sampling evenly across the candidate list.`,
    );
    work = sampleEvenly(work, config.maxCandidates);
  }

  if (work.length === 0) {
    // Candidates WERE found by the scan (we cleared the zero-scan guard
    // above), but the active --only / --name / --since filters excluded
    // every one. The terse "No candidates to process." that used to print
    // here read as "the tool is broken" to a prospect who simply mistyped a
    // filter value -- the same first-run friction the post-scan guard fixes.
    // Name how many candidates existed pre-filter and which filters are
    // active so the typo is obvious. Stderr keeps any stdout contract clean.
    const activeFilters: string[] = [];
    if (opts.only) activeFilters.push(`--only ${opts.only}`);
    if (opts.name) activeFilters.push(`--name ${opts.name}`);
    if (opts.since) activeFilters.push(`--since ${opts.since}`);
    const filterDesc =
      activeFilters.length > 0 ? activeFilters.join(", ") : "the active filters";
    // --only / --name take a user-typed needle, so a mistype is the most
    // likely cause and "check for a typo" is the right nudge. --since is
    // different: it is the diff-aware release-regen path (the core
    // auto-publish-on-every-release flow), and zero documentable candidates
    // changed since a ref is the NORMAL outcome of a release that did not
    // touch documented code, NOT an error. Suggest "typo" only when a needle
    // filter is active; frame a --since-only miss as the benign no-op it is.
    const hasNeedleFilter = Boolean(opts.only || opts.name);
    const hint = hasNeedleFilter
      ? `Hint: check the filter value for a typo, or drop the filter to generate all ${candidates.length} candidate(s).`
      : `Hint: this is expected when no documentable code changed since ${opts.since}; nothing to regenerate. Drop --since to generate all ${candidates.length} candidate(s).`;
    console.warn(
      [
        `[code2wiki] Found ${candidates.length} candidate(s) in ${opts.cwd}, but ${filterDesc} matched none of them.`,
        `[code2wiki] ${hint}`,
      ].join("\n"),
    );
    return;
  }


  // --estimate-cost: project the run's input + output token cost and
  // exit BEFORE any LLM call or filesystem write. Placed here (after
  // scan + filters + maxCandidates cap + dependency resolution, before
  // mkdir/audit-write) so the estimate matches exactly what the same
  // flag-set would actually bill, and so dry-runs leave zero side
  // effects on disk.
  if (opts.estimateCost) {
    const countTokensFn = opts.countTokensFn ?? defaultCountTokens;
    console.log(
      `[code2wiki] Counting tokens for ${work.length} candidate(s) (no LLM call)...`,
    );
    const perCandidate: PerCandidateTokens[] = [];
    for (const candidate of work) {
      const counts = await countTokensFn({
        candidate,
        projectName,
        config,
      });
      perCandidate.push(counts);
    }
    const est = computeEstimate(perCandidate);
    printEstimate(est, config.model);
    if (est.totalUsd > COST_WARN_THRESHOLD_USD) {
      console.warn(
        `[code2wiki] Estimate exceeds $${COST_WARN_THRESHOLD_USD}; use --limit N to cap the run.`,
      );
    }
    return;
  }

  const commit = await currentCommit(opts.cwd);
  const generatedAt = (opts.now ?? (() => new Date().toISOString()))();

  // Load signing key if audit signing is enabled in config.
  let signing: SigningInput | undefined;
  if (config.audit.signing.enabled) {
    const keyPath = path.isAbsolute(config.audit.signing.keyPath)
      ? config.audit.signing.keyPath
      : path.join(opts.cwd, config.audit.signing.keyPath);
    signing = await loadSigningKey(keyPath);
  }

  await fs.mkdir(path.join(opts.cwd, config.output), { recursive: true });

  const backend = resolveBackend(config);
  const usingMock = backend === "mock";
  const backendLabel =
    backend === "azure-openai"
      ? `Azure OpenAI (${process.env["AZURE_OPENAI_DEPLOYMENT"] || "gpt-4o"})`
      : backend === "deepseek"
        ? `DeepSeek (${process.env["DEEPSEEK_MODEL"] || "deepseek-v4-flash"})`
        : config.model;

  console.log(
    `[code2wiki] Generating ${work.length} use case(s)${usingMock ? " (MOCK MODE, no LLM call)" : ` via ${backendLabel}`}...`,
  );

  // First pass: extract all use cases (collecting slugs for the second pass).
  // This ensures that related-use-case links are only generated for pages
  // that actually exist in this run, preventing broken anchors.
  const extractions: Array<{
    candidate: Awaited<ReturnType<typeof scanProject>>[0];
    useCase: Awaited<ReturnType<typeof extractUseCase>>["useCase"];
    retry: Awaited<ReturnType<typeof extractUseCase>>["retry"];
  }> = [];
  const validSlugs = new Set<string>();

  for (const candidate of work) {
    try {
      const { useCase, retry } = await extractUseCase(
        candidate,
        projectName,
        config,
        { commit, generatedAt },
        opts.llmFn,
      );
      extractions.push({ candidate, useCase, retry });
      validSlugs.add(useCase.slug);
    } catch (e) {
      console.error(
        `  ✗ ${candidate.relativePath}:${candidate.lineStart}, ${
          (e as Error).message
        }`,
      );
      await appendAuditEntry(opts.cwd, {
        operation: "generate",
        commit,
        page: candidate.name,
        outcome: "error",
        details: {
          source: candidate.relativePath,
          error: (e as Error).message,
          mock: usingMock,
          promptVersion: PROMPT_VERSION,
        },
        signing,
      });
    }
  }

  // Second pass: render and write all use cases, now that we know which slugs
  // exist (validSlugs set). Pass the set to renderUseCase so it can filter
  // related-use-case links.
  let written = 0;
  let skipped = 0;
  for (const { candidate, useCase, retry } of extractions) {
    try {
      // Persist the chain-of-correction outcome BEFORE the generate
      // entry, so the audit log reads: retried → generate. That order
      // makes per-candidate replay easier (downstream tooling sees the
      // retry first, then the final outcome).
      if (retry) {
        await appendAuditEntry(opts.cwd, {
          operation: "retried",
          commit,
          page: useCase.slug,
          outcome: retry.outcome,
          details: {
            source: candidate.relativePath,
            firstIssues: retry.firstIssues,
            retriedIssues: retry.retriedIssues,
            firstErrorCount: retry.firstIssues.filter(
              (i) => i.severity === "error",
            ).length,
            retriedErrorCount: retry.retriedIssues.filter(
              (i) => i.severity === "error",
            ).length,
            mock: usingMock,
            promptVersion: PROMPT_VERSION,
          },
          signing,
        });
      }
      // --min-confidence gate: skip pages below the threshold and emit a
      // "skipped" audit entry so downstream tools can distinguish skipped
      // from error. The threshold is "low" by default (write everything).
      const threshold = opts.minConfidence ?? "low";
      if (!meetsConfidenceThreshold(useCase.confidence, threshold)) {
        console.log(
          `  - ${useCase.slug} (skipped: confidence=${useCase.confidence} below --min-confidence=${threshold})`,
        );
        await appendAuditEntry(opts.cwd, {
          operation: "generate",
          commit,
          page: useCase.slug,
          outcome: "skipped",
          details: {
            source: candidate.relativePath,
            lines: `${candidate.lineStart}-${candidate.lineEnd}`,
            confidence: useCase.confidence,
            skipReason: "below_min_confidence",
            mock: usingMock,
            promptVersion: PROMPT_VERSION,
          },
          signing,
        });
        skipped++;
        continue;
      }

      const md = renderUseCase(useCase, validSlugs);
      const outPath = path.join(
        opts.cwd,
        config.output,
        `${useCase.slug}.md`,
      );
      // Determine outcome by comparing against existing on-disk content.
      let outcome: "created" | "updated" | "unchanged" = "created";
      try {
        const existing = await fs.readFile(outPath, "utf-8");
        outcome = existing === md ? "unchanged" : "updated";
      } catch {
        outcome = "created";
      }
      await fs.writeFile(outPath, md, "utf-8");
      written++;
      console.log(`  ${outcome === "unchanged" ? "·" : "✓"} ${path.relative(opts.cwd, outPath)} (${outcome})`);
      await appendAuditEntry(opts.cwd, {
        operation: "generate",
        commit,
        page: useCase.slug,
        outcome,
        contentHash: hashContent(md),
        details: {
          source: candidate.relativePath,
          lines: `${candidate.lineStart}-${candidate.lineEnd}`,
          confidence: useCase.confidence,
          mock: usingMock,
          promptVersion: PROMPT_VERSION,
        },
        signing,
      });
    } catch (e) {
      console.error(
        `  ✗ ${candidate.relativePath}:${candidate.lineStart}, ${
          (e as Error).message
        }`,
      );
      await appendAuditEntry(opts.cwd, {
        operation: "generate",
        commit,
        page: candidate.name,
        outcome: "error",
        details: {
          source: candidate.relativePath,
          error: (e as Error).message,
          promptVersion: PROMPT_VERSION,
        },
        signing,
      });
    }
  }

  const skippedSuffix = skipped > 0 ? `; skipped ${skipped} (below --min-confidence=${opts.minConfidence ?? "low"})` : "";
  console.log(
    `[code2wiki] Wrote ${written} use case(s) to ${config.output}/${skippedSuffix}`,
  );
}

/**
 * Pick `target` items spread evenly across the input array. Returns the
 * input unchanged when `items.length <= target`.
 *
 * Exported for unit-testing the heuristic independently of the CLI.
 *
 * Used by `--limit` capping to give a REPRESENTATIVE slice of the
 * codebase instead of biasing toward whatever sorts alphabetically
 * first. Deterministic: the same input produces the same sample
 * across runs (no randomness), which keeps audit-log replay + the
 * `examples/` regression suite stable.
 *
 * Algorithm: pick indices `floor(i * L / target)` for i in [0, target).
 * Distinct because target ≤ L. Order-preserving (always returns items
 * in their original order) so downstream consumers that depend on
 * candidate ordering, e.g., `feedback_real_repo_signal.md`'s
 * scan-only check that lists the first-N alphabetical, read normally.
 */
function printEstimate(
  est: ReturnType<typeof computeEstimate>,
  model: string,
): void {
  const fmt = (n: number): string => n.toLocaleString();
  const dollars = (n: number): string => `$${n.toFixed(4)}`;
  console.log(`[code2wiki] Cost estimate via ${model} (no LLM call made):`);
  console.log(`  Candidates: ${est.pages}`);
  console.log(
    `  Input: ${fmt(est.totalSystemInputTokens)} system (cached, 50% off) + ${fmt(est.totalUserInputTokens)} user`,
  );
  console.log(
    `  Output: ${fmt(est.estimatedOutputTokens)} (projected @ 3000/page)`,
  );
  console.log(`  Cost breakdown:`);
  console.log(`    Input (cached system):   ${dollars(est.cachedInputCostUsd)}`);
  console.log(`    Input (uncached user):   ${dollars(est.uncachedInputCostUsd)}`);
  console.log(`    Output (projected):      ${dollars(est.outputCostUsd)}`);
  console.log(`  Total: $${est.totalUsd.toFixed(2)}`);
}

export function sampleEvenly<T>(items: T[], target: number): T[] {
  if (target <= 0) return [];
  if (items.length <= target) return items;
  const step = items.length / target;
  const result: T[] = [];
  for (let i = 0; i < target; i++) {
    result.push(items[Math.floor(i * step)]!);
  }
  return result;
}
