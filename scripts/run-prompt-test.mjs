#!/usr/bin/env -S npx tsx
/**
 * Prompt regression harness (docs/self-learning.md operator section).
 *
 * Runs `code2wiki generate` against a set of reference repos, snapshots
 * the output, and optionally diffs against a prior snapshot to flag
 * regressions. Intended for manual operator use via
 * `.github/workflows/prompt-test.yml` (workflow_dispatch only), not
 * every PR, each run is real LLM cost.
 *
 * Output: `.code2wiki/prompt-tests/<timestamp>.json` (gitignored).
 *
 * Usage:
 *   node scripts/run-prompt-test.mjs
 *   node scripts/run-prompt-test.mjs --against .code2wiki/prompt-tests/<prior>.json
 *   node scripts/run-prompt-test.mjs --repos spring-petclinic,contentbox
 *   node scripts/run-prompt-test.mjs --threshold 15
 *   CODE2WIKI_MOCK=1 node scripts/run-prompt-test.mjs  (cheap smoke test)
 *
 * Exit codes:
 *   0 - ran cleanly (no --against, OR --against showed no regression)
 *   1 - regression detected (only when --against given)
 *   2 - all repos failed to clone (no usable snapshot produced)
 */

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { computeMarkdownSnapshot } from "../src/core/feedback/snapshot.ts";
import {
  aggregateSnapshot,
  countMainFlowWords,
  diffSnapshots,
} from "../src/core/feedback/prompt-test.ts";
import { PROMPT_VERSION } from "../src/core/llm/prompts.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Curated reference set. Names match the `references/<name>/` clone
 * dir per references/README.md. Operator can override via --repos.
 *
 * Kept small by default: each repo means one full `generate` run worth
 * of LLM cost. Operator scales up by passing a longer list explicitly.
 */
const DEFAULT_REPOS = [
  {
    name: "spring-petclinic",
    url: "https://github.com/spring-projects/spring-petclinic.git",
  },
];

function main() {
  const args = parseArgs(process.argv.slice(2));

  const repos = args.repos
    ? args.repos.split(",").map((name) => {
        const known = DEFAULT_REPOS.find((r) => r.name === name);
        if (known) return known;
        throw new Error(
          `Unknown repo '${name}'. Add it to DEFAULT_REPOS in scripts/run-prompt-test.mjs.`,
        );
      })
    : DEFAULT_REPOS;

  const refDir = path.join(REPO_ROOT, "references");
  mkdirSync(refDir, { recursive: true });

  const snapshot = {
    ranAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    repos: {},
  };

  let usable = 0;
  for (const repo of repos) {
    const cloned = cloneOrPull(refDir, repo);
    if (!cloned) continue;
    console.log(`[prompt-test] running code2wiki generate against ${repo.name}...`);
    try {
      runGenerate(cloned);
      const repoSnap = collectRepoSnapshot(cloned);
      snapshot.repos[repo.name] = repoSnap;
      console.log(
        `[prompt-test]   ${repo.name}: ${repoSnap.pages} page(s), confidence high/med/low = ${repoSnap.confidence.high}/${repoSnap.confidence.medium}/${repoSnap.confidence.low}, retried=${repoSnap.retriedCount}`,
      );
      usable++;
    } catch (e) {
      console.warn(
        `[prompt-test] WARN: ${repo.name}: generate failed (${e.message}). Skipping.`,
      );
    }
  }

  if (usable === 0) {
    console.error("[prompt-test] All repos failed; no snapshot produced.");
    process.exit(2);
  }

  const outDir = path.join(REPO_ROOT, ".code2wiki", "prompt-tests");
  mkdirSync(outDir, { recursive: true });
  const stamp = snapshot.ranAt.replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(`[prompt-test] wrote ${path.relative(REPO_ROOT, outPath)}`);

  if (args.against) {
    const priorPath = path.resolve(args.against);
    if (!existsSync(priorPath)) {
      console.error(`[prompt-test] --against path not found: ${priorPath}`);
      process.exit(1);
    }
    const prior = JSON.parse(readFileSync(priorPath, "utf8"));
    const threshold = args.threshold ? Number(args.threshold) : 10;
    const diff = diffSnapshots(prior, snapshot, { threshold });
    console.log(
      `\n[prompt-test] diff vs ${path.relative(REPO_ROOT, priorPath)} (threshold=${threshold}pp):`,
    );
    for (const [name, d] of Object.entries(diff.repos)) {
      if (d.onlyIn) {
        console.log(`  ${name}: only in ${d.onlyIn} (no baseline to gate)`);
        continue;
      }
      const c = d.confidenceHighPct;
      const sym = c?.regressed ? "✗" : "·";
      console.log(
        `  ${sym} ${name}: high% ${c?.prior}→${c?.current} (Δ${c?.deltaPP}pp)`,
      );
    }
    if (diff.regressed) {
      console.error(
        `[prompt-test] REGRESSION: at least one repo's high-confidence share dropped ≥ ${threshold}pp.`,
      );
      process.exit(1);
    }
    console.log(`[prompt-test] no regression.`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
      out[key] = val;
    }
  }
  return out;
}

/**
 * Pull if `references/<name>` exists, clone otherwise. Skip-with-warn
 * on any failure, never fatal (per the operator spec, a partial repo
 * set still produces a usable snapshot).
 */
function cloneOrPull(refDir, repo) {
  const target = path.join(refDir, repo.name);
  if (existsSync(target)) {
    try {
      execSync("git pull --ff-only", { cwd: target, stdio: "ignore" });
      return target;
    } catch (e) {
      console.warn(
        `[prompt-test] WARN: pull failed for ${repo.name}: ${e.message}. Skipping.`,
      );
      return null;
    }
  }
  try {
    execSync(`git clone --depth=1 ${repo.url} ${repo.name}`, {
      cwd: refDir,
      stdio: "ignore",
    });
    return target;
  } catch (e) {
    console.warn(
      `[prompt-test] WARN: clone failed for ${repo.name}: ${e.message}. Skipping.`,
    );
    return null;
  }
}

function runGenerate(cloned) {
  const cliPath = path.join(REPO_ROOT, "dist/cli/index.js");
  if (!existsSync(cliPath)) {
    throw new Error("dist/cli/index.js missing; run `npm run build` first.");
  }
  // Cap to a small candidate set: each run is real LLM cost, and the
  // signal we need (confidence distribution + retried count + warn
  // counts) emerges from 10-20 pages, not the full repo.
  const result = spawnSync(
    "node",
    [cliPath, "generate", "--limit=10", "--cwd", cloned],
    { stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) {
    throw new Error(`code2wiki generate exited ${result.status}`);
  }
}

/**
 * Walk the cloned repo's docs/use-cases/ + .code2wiki/audit.jsonl and
 * roll them into a RepoSnapshot via aggregateSnapshot (the unit-tested
 * pure function). All I/O lives here; aggregation logic lives in
 * src/core/feedback/prompt-test.ts.
 */
function collectRepoSnapshot(cloned) {
  const outDir = path.join(cloned, "docs/use-cases");
  const pages = [];
  if (existsSync(outDir)) {
    for (const f of readdirSync(outDir)) {
      if (!f.endsWith(".md")) continue;
      const md = readFileSync(path.join(outDir, f), "utf8");
      const fm = matter(md);
      const snap = computeMarkdownSnapshot(md);
      pages.push({
        confidence: fm.data.confidence,
        mainFlowWordCount: countMainFlowWords(fm.content),
        bodyLineCount: snap.bodyLineCount,
      });
    }
  }

  const auditPath = path.join(cloned, ".code2wiki/audit.jsonl");
  const auditEntries = [];
  if (existsSync(auditPath)) {
    const raw = readFileSync(auditPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        auditEntries.push(JSON.parse(line));
      } catch {
        // Malformed line; skip, not abort. Audit log is otherwise valid.
      }
    }
  }

  return aggregateSnapshot({ pages, auditEntries });
}

// Only run main() when invoked directly; harmless if a future test imports
// this module (the pure aggregator/diff live in src/core/feedback/prompt-test.ts
// for unit testing).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("run-prompt-test.mjs")
) {
  main();
}
