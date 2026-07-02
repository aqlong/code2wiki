import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../core/config.js";
import { scanProject } from "../../core/scan.js";
import { extractUseCase } from "../../core/extractor.js";
import { renderUseCase } from "../../core/renderer.js";
import { currentCommit } from "../../core/git.js";
import { type AuditEntry } from "../../core/audit.js";
import { computeMarkdownSnapshot } from "../../core/feedback/snapshot.js";
import { promptVersionLte } from "./prompt-version.js";
import { slugLooksLike } from "./slug-match.js";
import type { Candidate, Config } from "../../core/types.js";

/**
 * Replay-and-improve (signal #4 in `docs/self-learning.md`).
 *
 * Replays every `generate` audit entry through the CURRENT prompt
 * template and reports an aggregate diff: how many pages would change
 * if we re-published right now? Aimed at prompt-iteration workflow,
 * the operator runs `replay --mock` to quickly check structural drift
 * with no API cost, then runs without `--mock` against a small `--limit`
 * to evaluate semantic changes with minimal token cost.
 *
 * No live publishing happens here. The replay is observational: write
 * a JSON report to `.code2wiki/replay-<iso>.json`, plus a console
 * summary, and exit. Audit log is not touched (it's reserved for
 * production operations).
 *
 * Implementation choices:
 *   - --since <commit>: include audit entries from that commit
 *     forward (chronologically). Audit log is append-only ordered, so
 *     "from index of first entry whose commit === <since>" is the
 *     filter.
 *   - dedupe by page slug: the latest `generate` entry per slug wins
 *     (a slug regenerated 5 times only counts once for replay).
 *   - candidate match: relativePath equals the audit entry's
 *     details.source AND slug derivation produces the same page
 *     identifier. Pages whose source has been deleted/moved are
 *     reported as "skipped: candidate not found."
 *   - line-count + section-count deltas: computed only when we can
 *     read the old Markdown from disk (`<output>/<slug>.md`). If a
 *     manual edit has changed the local file's hash away from the
 *     audit entry's, we skip comparison (the local file is no longer
 *     the canonical "old version").
 */

export interface ReplayOptions {
  cwd: string;
  /** Filter by commit SHA, only replay entries from this commit forward
   *  (chronologically in the audit log). */
  since?: string;
  /** Filter by promptVersion, only replay entries whose `details.promptVersion`
   *  is strictly LESS than the current PROMPT_VERSION (i.e. produced
   *  before the operator bumped it). The intended workflow is: edit
   *  prompt → bump PROMPT_VERSION → run `replay --since-version <old>`
   *  to see how output drifts for entries produced under <old>. Pass
   *  the OLDER version, not the new one. */
  sinceVersion?: string;
  limit?: number;
  mock?: boolean;
  /** Override the LLM seam, wired by the test harness; production omits. */
  llmFn?: Parameters<typeof extractUseCase>[4];
  /** Override new Date().toISOString(), for deterministic tests. */
  now?: () => string;
}

export type ReplayPerSlugStatus =
  | "unchanged"
  | "changed"
  | "skipped"
  | "error";

export interface ReplayPerSlugResult {
  slug: string;
  status: ReplayPerSlugStatus;
  /** Body-only sha256 of the OLD on-disk Markdown (excludes fence +
   *  frontmatter so timestamp churn doesn't show as drift). null when
   *  the local file is missing. */
  oldBodyHash: string | null;
  /** Body-only sha256 of the NEW (replayed) Markdown. */
  newBodyHash: string | null;
  /** Net line count change (new - old). null when old can't be read. */
  lineCountDelta: number | null;
  /** Net section count change (new H2 count - old H2 count). null when old can't be read. */
  sectionCountDelta: number | null;
  /** Extra context for "skipped" / "error" rows. */
  reason?: string;
}

export interface ReplayReport {
  startedAt: string;
  cwd: string;
  /** Mirrors --since when supplied, otherwise null (full replay). */
  since: string | null;
  /** Mirrors --since-version when supplied. */
  sinceVersion: string | null;
  /** Mirrors --mock; surfaces in the report so a viewer knows whether to compare semantics. */
  mock: boolean;
  totals: {
    auditEntriesScanned: number;
    distinctSlugsReplayed: number;
    unchanged: number;
    changed: number;
    skipped: number;
    errors: number;
  };
  perSlug: ReplayPerSlugResult[];
}

export async function runReplay(opts: ReplayOptions): Promise<ReplayReport> {
  const config = await loadConfig(opts.cwd);
  if (opts.mock) config.mock = true;
  const usingMock =
    config.mock ||
    process.env["CODE2WIKI_MOCK"] === "1" ||
    !process.env["ANTHROPIC_API_KEY"];

  const auditFile = path.join(opts.cwd, ".code2wiki", "audit.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(auditFile, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      console.log(
        "Audit log not found. Run 'code2wiki generate' before 'replay'.",
      );
      return emptyReport(opts);
    }
    throw e;
  }
  const lines = raw.split("\n").filter(Boolean);
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // Malformed, skip this line, not the whole replay
    }
  }

  // Optional --since filter: chronological start point. The audit log
  // is append-only-ordered, so we walk from front and start when the
  // commit first matches. Subsequent entries are all included even if
  // they have the same commit (a single commit can have multiple
  // entries from different `generate` invocations).
  let work = entries;
  if (opts.since) {
    const startIdx = entries.findIndex((e) => e.commit === opts.since);
    if (startIdx < 0) {
      console.error(
        `[code2wiki] --since ${opts.since}: no audit entry with that commit. Run 'code2wiki audit show' to inspect.`,
      );
      return emptyReport(opts, lines.length);
    }
    work = entries.slice(startIdx);
  }

  // Optional --since-version filter: keep entries produced UNDER OR BEFORE
  // the supplied version. Predicate intentionally LOOSE: entries
  // missing details.promptVersion (older audit logs from before the
  // stamp landed) are KEPT, the operator wants to replay them too,
  // since the whole point is "what changes when I bump the prompt?".
  // The current code's prompt is whatever ships in this run, so the
  // semantic baseline for "old version" is "anything not ALREADY at
  // the current version."
  if (opts.sinceVersion) {
    const target = opts.sinceVersion;
    work = work.filter((e) => {
      const v =
        typeof e.details?.["promptVersion"] === "string"
          ? (e.details["promptVersion"] as string)
          : null;
      // Missing version → assume older → include.
      if (v === null) return true;
      // At-or-before the supplied version → include. We compare as
      // monotonic strings (v1, v2, …, v10) using a numeric extractor
      // so v10 sorts after v9, not "v1, v10, v2, v3" lex order.
      return promptVersionLte(v, target);
    });
    if (work.length === 0) {
      console.error(
        `[code2wiki] --since-version ${opts.sinceVersion}: no audit entries at or before that version. Run 'code2wiki audit show' to inspect.`,
      );
      return emptyReport(opts, lines.length);
    }
  }

  // Filter to successful generate entries (skipped/error rows have no
  // useful baseline) and dedupe by slug, the latest entry wins, so we
  // walk the array right-to-left and keep first-seen.
  const latestBySlug = new Map<string, AuditEntry>();
  for (let i = work.length - 1; i >= 0; i--) {
    const e = work[i]!;
    if (e.operation !== "generate") continue;
    if (!e.content_hash) continue;
    if (e.outcome === "error") continue;
    if (!latestBySlug.has(e.page)) latestBySlug.set(e.page, e);
  }
  let pendingSlugs = Array.from(latestBySlug.values());
  if (opts.limit && pendingSlugs.length > opts.limit) {
    console.warn(
      `[code2wiki] capping replay at limit=${opts.limit} (found ${pendingSlugs.length} distinct slugs)`,
    );
    pendingSlugs = pendingSlugs.slice(0, opts.limit);
  }

  if (pendingSlugs.length === 0) {
    console.log("Nothing to replay (no generate entries matched the filter).");
    return emptyReport(opts, lines.length);
  }

  // One scan of the project up front; the candidate list is reused
  // across all audit entries.
  let candidates = await scanProject(opts.cwd, config);
  const projectName = path.basename(opts.cwd);
  const commit = await currentCommit(opts.cwd);
  const generatedAt = (opts.now ?? (() => new Date().toISOString()))();

  console.log(
    `[code2wiki] replay starting: ${pendingSlugs.length} distinct slug(s)${
      usingMock ? " (MOCK MODE, no LLM call)" : ""
    }`,
  );

  const perSlug: ReplayPerSlugResult[] = [];
  for (const entry of pendingSlugs) {
    const result = await replayOne(entry, {
      candidates,
      projectName,
      config,
      commit,
      generatedAt,
      cwd: opts.cwd,
      llmFn: opts.llmFn,
    });
    perSlug.push(result);
    const sym = symbolFor(result.status);
    const tail =
      result.status === "changed"
        ? `(Δ lines: ${formatDelta(result.lineCountDelta)}, Δ sections: ${formatDelta(result.sectionCountDelta)})`
        : result.reason
          ? `(${result.reason})`
          : "";
    console.log(`  ${sym} ${result.slug} ${tail}`);
  }

  const report: ReplayReport = {
    startedAt: generatedAt,
    cwd: opts.cwd,
    since: opts.since ?? null,
    sinceVersion: opts.sinceVersion ?? null,
    mock: usingMock,
    totals: {
      auditEntriesScanned: lines.length,
      distinctSlugsReplayed: perSlug.length,
      unchanged: perSlug.filter((r) => r.status === "unchanged").length,
      changed: perSlug.filter((r) => r.status === "changed").length,
      skipped: perSlug.filter((r) => r.status === "skipped").length,
      errors: perSlug.filter((r) => r.status === "error").length,
    },
    perSlug,
  };

  console.log(
    `[code2wiki] replay summary: ${report.totals.changed} changed, ${report.totals.unchanged} unchanged, ${report.totals.skipped} skipped, ${report.totals.errors} error(s)`,
  );

  // Write report file. Multiple replays per day get unique filenames
  // via the iso timestamp; never overwrites a prior run's report.
  const reportFile = path.join(
    opts.cwd,
    ".code2wiki",
    `replay-${generatedAt.replace(/[:.]/g, "-")}.json`,
  );
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2), "utf-8");
  console.log(`[code2wiki] report written to ${path.relative(opts.cwd, reportFile)}`);

  return report;
}

interface ReplayOneCtx {
  candidates: Candidate[];
  projectName: string;
  config: Config;
  commit: string;
  generatedAt: string;
  cwd: string;
  llmFn?: ReplayOptions["llmFn"];
}

async function replayOne(
  entry: AuditEntry,
  ctx: ReplayOneCtx,
): Promise<ReplayPerSlugResult> {
  const sourcePath =
    typeof entry.details?.["source"] === "string"
      ? (entry.details["source"] as string)
      : undefined;
  if (!sourcePath) {
    return baseSkip(entry, "audit entry missing details.source");
  }
  // Match by relative path. Multiple candidates per file are possible
  // (one per function); we filter further by which one's slug matches
  // the audit entry's page slug.
  const matchingFile = ctx.candidates.filter(
    (c) => c.relativePath === sourcePath,
  );
  if (matchingFile.length === 0) {
    return baseSkip(
      entry,
      "source file no longer present (deleted/renamed since publish)",
    );
  }
  const candidate = matchingFile.find((c) => slugLooksLike(c.name, entry.page));
  if (!candidate) {
    return baseSkip(
      entry,
      "candidate function not found in current source (renamed/removed)",
    );
  }
  let newMd: string;
  try {
    const { useCase } = await extractUseCase(
      candidate,
      ctx.projectName,
      ctx.config,
      { commit: ctx.commit, generatedAt: ctx.generatedAt },
      ctx.llmFn,
    );
    newMd = renderUseCase(useCase);
  } catch (e) {
    return {
      slug: entry.page,
      status: "error",
      oldBodyHash: null,
      newBodyHash: null,
      lineCountDelta: null,
      sectionCountDelta: null,
      reason: (e as Error).message,
    };
  }

  const newSnap = computeMarkdownSnapshot(newMd);
  const newBodyHash = newSnap.contentHash;

  // Read the OLD on-disk Markdown, that's the canonical "what was
  // published" baseline. The audit entry's content_hash exists for
  // tamper-evidence but isn't useful for comparison: it's a hash of
  // the FULL render including the fence (which embeds a timestamp +
  // commit sha that change every run), so it never matches a fresh
  // render's hash. Body-only snapshot is the right comparator.
  let oldBodyHash: string | null = null;
  let oldLines: number | null = null;
  let oldSections: number | null = null;
  try {
    const oldPath = path.join(
      ctx.cwd,
      ctx.config.output,
      `${entry.page}.md`,
    );
    const oldMd = await fs.readFile(oldPath, "utf-8");
    const oldSnap = computeMarkdownSnapshot(oldMd);
    oldBodyHash = oldSnap.contentHash;
    oldLines = oldSnap.bodyLineCount;
    oldSections = oldSnap.sections.length;
  } catch {
    // No baseline file, local output was deleted or never existed.
    // We can't classify changed/unchanged without a baseline; report
    // as skipped with a clear reason.
    return {
      slug: entry.page,
      status: "skipped",
      oldBodyHash: null,
      newBodyHash,
      lineCountDelta: null,
      sectionCountDelta: null,
      reason: "no local baseline at <output>/<slug>.md to compare against",
    };
  }

  if (oldBodyHash === newBodyHash) {
    return {
      slug: entry.page,
      status: "unchanged",
      oldBodyHash,
      newBodyHash,
      lineCountDelta: 0,
      sectionCountDelta: 0,
    };
  }
  return {
    slug: entry.page,
    status: "changed",
    oldBodyHash,
    newBodyHash,
    lineCountDelta:
      oldLines !== null ? newSnap.bodyLineCount - oldLines : null,
    sectionCountDelta:
      oldSections !== null ? newSnap.sections.length - oldSections : null,
  };
}

function baseSkip(entry: AuditEntry, reason: string): ReplayPerSlugResult {
  return {
    slug: entry.page,
    status: "skipped",
    oldBodyHash: null,
    newBodyHash: null,
    lineCountDelta: null,
    sectionCountDelta: null,
    reason,
  };
}

function symbolFor(status: ReplayPerSlugStatus): string {
  switch (status) {
    case "unchanged":
      return "·";
    case "changed":
      return "~";
    case "skipped":
      return "○";
    case "error":
      return "✗";
  }
}

function formatDelta(d: number | null): string {
  if (d === null) return "?";
  if (d > 0) return `+${d}`;
  return String(d);
}

function emptyReport(opts: ReplayOptions, scanned = 0): ReplayReport {
  return {
    startedAt: (opts.now ?? (() => new Date().toISOString()))(),
    cwd: opts.cwd,
    since: opts.since ?? null,
    sinceVersion: opts.sinceVersion ?? null,
    mock: Boolean(opts.mock),
    totals: {
      auditEntriesScanned: scanned,
      distinctSlugsReplayed: 0,
      unchanged: 0,
      changed: 0,
      skipped: 0,
      errors: 0,
    },
    perSlug: [],
  };
}

