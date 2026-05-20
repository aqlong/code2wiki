import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeMarkdownSnapshot,
  type MarkdownSnapshot,
} from "./snapshot.js";

// ---------------------------------------------------------------------
// LIVE engine regression; gated, expensive, only useful with real LLM
// ---------------------------------------------------------------------
//
// What this test does (when gated on):
//   1. For each examples/<name>/, parse source.md to find the local
//      reference-repo clone path + use-case region.
//   2. Spawn `code2wiki generate --only <name>` against the reference
//      repo (real LLM, no mock).
//   3. Compute a structural snapshot of the produced Markdown.
//   4. Compare against the committed baseline.snapshot.json; but
//      tolerate the parts that legitimately churn between LLM runs:
//        - body content hash WILL differ (LLM is non-deterministic)
//        - managed-block hash WILL differ (timestamp + commit SHA churn)
//        - body line count is allowed to drift up to ±25%
//        - sections + frontmatter keys MUST match exactly (those are
//          the load-bearing structural contract we care about for
//          non-technical readers)
//
// Why this is split out from examples.test.ts:
//   - costs real LLM tokens (~$0.10-0.50 per full run depending on
//     model + cache hits)
//   - requires references/ to be cloned locally (gitignored per ADR-010)
//   - is non-deterministic; flaky in CI without retry budget
//
// Gating:
//   CODE2WIKI_RUN_LIVE_EXAMPLES=1 + ANTHROPIC_API_KEY=<real key>
//   npx vitest run src/core/feedback/examples.live.test.ts
//
//   Or via the npm shortcut:
//     CODE2WIKI_RUN_LIVE_EXAMPLES=1 npm run test:live-examples
//
// What it is NOT:
//   - it does not feed back into prompt iteration directly. That work
//     is signal #4 "replay-and-improve via audit log" in
//     docs/self-learning.md, which is later; this is just the
//     foundation that proves the engine still produces structurally
//     correct output on real source.

const RUN_LIVE = process.env["CODE2WIKI_RUN_LIVE_EXAMPLES"] === "1";
const HAS_KEY = !!process.env["ANTHROPIC_API_KEY"];

const examplesDir = fileURLToPath(new URL("../../../examples/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface LiveCase {
  name: string;
  cliName: string; // value passed to --only
  refClonePath: string; // ABSOLUTE; must exist on disk
  refRoot: string; // root dir to pass to --cwd
  baselinePath: string;
}

const LOCAL_PATH_RE = /\*\*Local clone path:\*\*\s*`([^`]+)`/;
const REGION_RE =
  /\*\*Use case region:\*\*\s*Lines\s+\d+[–-]\d+\s*\(`([^`]+)`/;

// Pulls (a) the local clone path and (b) the FIRST function name from
// the "Use case region: Lines NN-NN (`name`, ...)" line in source.md.
// We use the function name as the --only filter on the CLI; --only does
// suffix matching, so passing `findOwner` matches the
// `OwnerController.findOwner` candidate.
function parseSourcePointer(text: string): {
  localClone: string;
  cliName: string;
} | null {
  const local = text.match(LOCAL_PATH_RE)?.[1];
  const region = text.match(REGION_RE)?.[1];
  if (!local || !region) return null;
  return { localClone: local, cliName: region };
}

function discoverCases(): LiveCase[] {
  const cases: LiveCase[] = [];
  if (!existsSync(examplesDir)) return cases;
  for (const name of readdirSync(examplesDir)) {
    const dir = join(examplesDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const sourceMd = join(dir, "source.md");
    const baselinePath = join(dir, "baseline.snapshot.json");
    if (!existsSync(sourceMd) || !existsSync(baselinePath)) continue;
    const parsed = parseSourcePointer(readFileSync(sourceMd, "utf8"));
    if (!parsed) continue;
    // Reference paths in source.md are relative to repo root.
    const absLocalClone = join(repoRoot, parsed.localClone);
    if (!existsSync(absLocalClone)) continue;
    // The CLI scans a project root; pick the FIRST ancestor that
    // makes sense. We ascend from the file until the path no longer
    // contains "src"; for spring-petclinic that's the repo root, for
    // CFML that's the references/masa-cms root.
    const refRoot = inferProjectRoot(parsed.localClone);
    cases.push({
      name,
      cliName: parsed.cliName,
      refClonePath: absLocalClone,
      refRoot: join(repoRoot, refRoot),
      baselinePath,
    });
  }
  return cases;
}

function inferProjectRoot(relativePath: string): string {
  // references/<repo-name>/... returns references/<repo-name>.
  const parts = relativePath.split("/");
  if (parts[0] === "references" && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }
  // Fallback: trim from "src/" onward.
  const idx = relativePath.indexOf("/src/");
  return idx === -1 ? relativePath : relativePath.slice(0, idx);
}

function runGenerate(refRoot: string, cliName: string): string {
  // Spawn the CLI as a child process; the test stays decoupled from
  // the live LLM client + scan internals. No CODE2WIKI_MOCK in the
  // env; we WANT the real LLM call.
  const result = spawnSync(
    "npx",
    [
      "tsx",
      "src/cli/index.ts",
      "generate",
      "--cwd",
      refRoot,
      "--only",
      cliName,
      "--limit",
      "1",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CODE2WIKI_MOCK: "" },
      encoding: "utf8",
      timeout: 5 * 60 * 1000, // 5 min per candidate; real LLM is slow
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `code2wiki generate exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  // Find the produced file inside refRoot/generated-docs/.
  const outDir = join(refRoot, "generated-docs");
  const files = readdirSync(outDir).filter((n) => n.endsWith(".md"));
  if (files.length === 0) {
    throw new Error(
      `no .md files emitted to ${outDir} despite exit 0; stdout: ${result.stdout}`,
    );
  }
  // Sort by mtime, take the newest.
  const newest = files
    .map((n) => ({ name: n, mtime: statSync(join(outDir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]!;
  return readFileSync(join(outDir, newest.name), "utf8");
}

function cleanup(refRoot: string): void {
  const outDir = join(refRoot, "generated-docs");
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
}

const cases = discoverCases();

describe.runIf(RUN_LIVE && HAS_KEY)(
  "examples/ live engine regression",
  () => {
    it("found at least one example with both source.md + baseline.snapshot.json + a local references clone", () => {
      // If this fails, you probably haven't cloned references/. See
      // ADR-010 + references/README.md.
      expect(cases.length).toBeGreaterThan(0);
    });

    for (const c of cases) {
      it(
        `${c.name}: live LLM output matches the baseline's structural shape`,
        async () => {
          let regenerated: string;
          try {
            regenerated = runGenerate(c.refRoot, c.cliName);
          } finally {
            cleanup(c.refRoot);
          }
          const snap = computeMarkdownSnapshot(regenerated);
          const baseline = JSON.parse(
            readFileSync(c.baselinePath, "utf8"),
          ) as MarkdownSnapshot;

          // Sections + frontmatter keys are the load-bearing contract;
          // non-technical readers depend on them.
          expect(snap.sections).toEqual(baseline.sections);
          expect(snap.frontmatterKeys).toEqual(baseline.frontmatterKeys);

          // Body line count is allowed to drift up to ±25%. Wide
          // enough to absorb LLM phrasing variance, narrow enough to
          // catch a "the model started producing 200-line walls of
          // text" regression.
          const drift =
            Math.abs(snap.bodyLineCount - baseline.bodyLineCount) /
            baseline.bodyLineCount;
          expect(drift).toBeLessThanOrEqual(0.25);

          // Body content hash WILL differ; LLM is non-deterministic.
          // Managed-block hash WILL differ; timestamp + commit SHA
          // churn each run. We don't assert on either.
        },
        // Generous per-test timeout; vitest's default is 10s which is
        // way too short for a real LLM call + a parser scan over a
        // reference repo.
        7 * 60 * 1000,
      );
    }
  },
);
