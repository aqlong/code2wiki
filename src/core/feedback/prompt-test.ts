/**
 * Pure data transforms backing scripts/run-prompt-test.mjs (signal #4 in
 * docs/self-learning.md: replay-and-improve via audit log, but applied
 * forward, run the current prompt against the reference repos to detect
 * regressions BEFORE shipping).
 *
 * Two functions, no I/O:
 *   - aggregateSnapshot: pages + audit entries -> per-repo metrics
 *   - diffSnapshots: prior + current snapshot -> per-repo deltas + a
 *     boolean regression gate
 *
 * Kept here (vs colocated with the .mjs orchestrator) so vitest can
 * cover the diff logic with synthetic inputs. The orchestrator script
 * handles the cloning / CLI invocation / disk I/O; this file is the
 * only place that knows the snapshot shape.
 */

export type ConfidenceLevel = "high" | "medium" | "low";

export interface PageMetrics {
  /** UseCase frontmatter `confidence` field. Anything outside the three
   *  known levels is ignored (defends against an LLM emitting a typo). */
  confidence?: ConfidenceLevel | string;
  /** Word count of the `## Main flow` section body (excluding the
   *  heading itself). 0 when the section is absent. */
  mainFlowWordCount?: number;
  /** Body line count via computeMarkdownSnapshot. */
  bodyLineCount?: number;
}

export interface AuditEntryLike {
  operation?: string;
  outcome?: string;
  details?: Record<string, unknown>;
}

export interface RepoSnapshot {
  pages: number;
  confidence: { high: number; medium: number; low: number };
  retriedCount: number;
  /** Field name -> count of warn-severity validator issues in the
   *  retried entries' firstIssues lists. */
  validatorWarnCounts: Record<string, number>;
  avgMainFlowWords: number;
  avgBodyLineCount: number;
}

export interface PromptTestSnapshot {
  ranAt: string;
  promptVersion: string;
  repos: Record<string, RepoSnapshot>;
}

export interface RepoDiff {
  /** Set on repos that exist in one snapshot but not the other; the
   *  regression gate skips those. */
  onlyIn?: "prior" | "current";
  confidenceHighPct?: {
    prior: number;
    current: number;
    deltaPP: number;
    regressed: boolean;
  };
  retriedCount?: { prior: number; current: number; delta: number };
  avgMainFlowWords?: { prior: number; current: number; delta: number };
  avgBodyLineCount?: { prior: number; current: number; delta: number };
  validatorWarns?: {
    prior: Record<string, number>;
    current: Record<string, number>;
  };
}

export interface DiffResult {
  threshold: number;
  regressed: boolean;
  repos: Record<string, RepoDiff>;
}

/**
 * Roll a list of pages + audit entries into one RepoSnapshot.
 *
 * Tolerant on shape: missing pages.confidence -> not counted; missing
 * mainFlowWordCount / bodyLineCount -> treated as 0; empty pages list
 * -> avg fields = 0 (NOT NaN). Empty audit entries -> retriedCount = 0,
 * empty validatorWarnCounts.
 */
export function aggregateSnapshot(input: {
  pages: PageMetrics[];
  auditEntries: AuditEntryLike[];
}): RepoSnapshot {
  const confidence = { high: 0, medium: 0, low: 0 };
  let totalMainFlowWords = 0;
  let totalBodyLines = 0;

  for (const p of input.pages) {
    const c = p.confidence;
    if (c === "high" || c === "medium" || c === "low") confidence[c]++;
    totalMainFlowWords += p.mainFlowWordCount ?? 0;
    totalBodyLines += p.bodyLineCount ?? 0;
  }

  const n = input.pages.length;
  const avgMainFlowWords = n === 0 ? 0 : round2(totalMainFlowWords / n);
  const avgBodyLineCount = n === 0 ? 0 : round2(totalBodyLines / n);

  let retriedCount = 0;
  const validatorWarnCounts: Record<string, number> = {};
  for (const entry of input.auditEntries) {
    if (entry?.operation !== "retried") continue;
    retriedCount++;
    const issues = (entry.details?.["firstIssues"] ?? []) as Array<{
      field?: string;
      severity?: string;
    }>;
    for (const iss of issues) {
      if (iss?.severity !== "warn") continue;
      const field = iss.field ?? "unknown";
      validatorWarnCounts[field] = (validatorWarnCounts[field] ?? 0) + 1;
    }
  }

  return {
    pages: n,
    confidence,
    retriedCount,
    validatorWarnCounts,
    avgMainFlowWords,
    avgBodyLineCount,
  };
}

/**
 * Per-repo deltas between two snapshots. The regression gate fires on
 * a drop in confidence high-share of `>= threshold` percentage points
 * (default 10). Other metrics are reported but do NOT gate, drift in
 * avg word count or retried count is informational, not enforcement.
 *
 * Boundary: exactly threshold-pp drop = regression; (threshold-1)-pp
 * drop = pass. Mirrors the user's spec.
 *
 * Repos in only one snapshot get `onlyIn` and skip the gate (no
 * baseline to compare against).
 */
export function diffSnapshots(
  prior: PromptTestSnapshot | null | undefined,
  current: PromptTestSnapshot | null | undefined,
  options: { threshold?: number } = {},
): DiffResult {
  const threshold = options.threshold ?? 10;
  const repoNames = new Set<string>([
    ...Object.keys(prior?.repos ?? {}),
    ...Object.keys(current?.repos ?? {}),
  ]);

  const repos: Record<string, RepoDiff> = {};
  let regressed = false;

  for (const name of repoNames) {
    const p = prior?.repos?.[name];
    const c = current?.repos?.[name];

    if (!p || !c) {
      repos[name] = { onlyIn: p ? "prior" : "current" };
      continue;
    }

    const pHigh = highSharePct(p);
    const cHigh = highSharePct(c);
    const deltaPP = round2(cHigh - pHigh);
    const repoRegressed = -deltaPP >= threshold;
    if (repoRegressed) regressed = true;

    repos[name] = {
      confidenceHighPct: {
        prior: pHigh,
        current: cHigh,
        deltaPP,
        regressed: repoRegressed,
      },
      retriedCount: {
        prior: p.retriedCount ?? 0,
        current: c.retriedCount ?? 0,
        delta: (c.retriedCount ?? 0) - (p.retriedCount ?? 0),
      },
      avgMainFlowWords: {
        prior: p.avgMainFlowWords ?? 0,
        current: c.avgMainFlowWords ?? 0,
        delta: round2((c.avgMainFlowWords ?? 0) - (p.avgMainFlowWords ?? 0)),
      },
      avgBodyLineCount: {
        prior: p.avgBodyLineCount ?? 0,
        current: c.avgBodyLineCount ?? 0,
        delta: round2((c.avgBodyLineCount ?? 0) - (p.avgBodyLineCount ?? 0)),
      },
      validatorWarns: {
        prior: p.validatorWarnCounts ?? {},
        current: c.validatorWarnCounts ?? {},
      },
    };
  }

  return { threshold, regressed, repos };
}

/**
 * Word count of the body of `## Main flow`. Stops at the next `##`
 * heading or EOF. Returns 0 when the section is absent or its body is
 * empty/whitespace-only.
 *
 * Lives here (not in the .mjs orchestrator) so vitest can pin the
 * regex. A regression that broke the heading match or the EOF lookahead
 * would silently report 0 words on every page and the avgMainFlowWords
 * metric in the prompt-test snapshot would lose all signal.
 */
export function countMainFlowWords(content: string): number {
  const re = /^##\s+Main flow\s*$([\s\S]*?)(?=^##\s|$(?![\r\n]))/m;
  const m = content.match(re);
  if (!m) return 0;
  const body = m[1].trim();
  if (!body) return 0;
  return body.split(/\s+/).filter(Boolean).length;
}

function highSharePct(snap: RepoSnapshot): number {
  const conf = snap?.confidence ?? { high: 0, medium: 0, low: 0 };
  const total = (conf.high ?? 0) + (conf.medium ?? 0) + (conf.low ?? 0);
  if (total === 0) return 0;
  return round2(((conf.high ?? 0) / total) * 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
