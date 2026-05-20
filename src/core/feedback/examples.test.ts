import { describe, expect, it } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeMarkdownSnapshot,
  type MarkdownSnapshot,
} from "./snapshot.js";

// ----------------------------------------------------------------------------
// examples/ regression suite
// ----------------------------------------------------------------------------
//
// For every examples/<name>/ directory containing both expected.md and
// baseline.snapshot.json, recompute the structural snapshot from the
// expected.md and assert it matches the committed baseline.
//
// This is the cheapest, fastest layer of the self-learning quality gate
// (docs/self-learning.md signal #2). It runs in mock mode (no LLM, no
// network) and catches:
//
//   - Accidental edits to a hand-curated example (expected.md changed
//     but baseline.snapshot.json wasn't regenerated → drift)
//   - Snapshot algorithm changes that affect the public surface (e.g.,
//     new section parser, frontmatter key normalization)
//   - File encoding / BOM / CRLF regressions that would otherwise only
//     surface in real customer runs
//
// To intentionally update a baseline after a curated example changes:
//   npx tsx scripts/gen-baseline-snapshots.mjs
// then commit the new baseline.snapshot.json files alongside the expected.md.

// Resolve examples/ relative to this test file so the test works from any cwd.
const examplesDir = fileURLToPath(new URL("../../../examples/", import.meta.url));

interface ExampleCase {
  name: string;
  expectedPath: string;
  baselinePath: string;
}

function findExamples(): ExampleCase[] {
  if (!existsSync(examplesDir)) return [];
  return readdirSync(examplesDir)
    .filter((n) => {
      const p = join(examplesDir, n);
      return statSync(p).isDirectory();
    })
    .map((name) => ({
      name,
      expectedPath: join(examplesDir, name, "expected.md"),
      baselinePath: join(examplesDir, name, "baseline.snapshot.json"),
    }))
    .filter(
      (c) => existsSync(c.expectedPath) && existsSync(c.baselinePath),
    );
}

const cases = findExamples();

describe("examples/ structural snapshot regression", () => {
  it("finds at least one example with a baseline", () => {
    // Guard against the suite silently passing because no example dirs
    // were located (e.g., we ran from a worktree where examples/ was
    // checked out empty or path resolution broke).
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)(
    "$name: expected.md snapshot matches baseline.snapshot.json",
    ({ expectedPath, baselinePath }) => {
      const expectedText = readFileSync(expectedPath, "utf8");
      const baseline = JSON.parse(
        readFileSync(baselinePath, "utf8"),
      ) as MarkdownSnapshot;
      const computed = computeMarkdownSnapshot(expectedText);
      expect(computed).toEqual(baseline);
    },
  );
});
