import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Wrap changedFilesSince in vi.fn so individual tests can drive the
// --since happy path (non-null return) without a real git repo. Every
// test that doesn't override gets the real implementation, which returns
// null in the non-git tmpdir used by this suite, exercising the fallback.
vi.mock("../../core/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/git.js")>();
  return {
    ...actual,
    changedFilesSince: vi.fn(actual.changedFilesSince),
    currentCommit: vi.fn(actual.currentCommit),
  };
});

import { changedFilesSince } from "../../core/git.js";
import { runGenerate, sampleEvenly } from "./generate.js";
import { PROMPT_VERSION } from "../../core/llm/prompts.js";
import type { LlmFn } from "../../core/extractor.js";
import type { Candidate } from "../../core/types.js";

describe("sampleEvenly (--limit cap heuristic)", () => {
  it("returns the input unchanged when length <= target", () => {
    expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(sampleEvenly([], 3)).toEqual([]);
    expect(sampleEvenly(["a", "b", "c"], 3)).toEqual(["a", "b", "c"]);
  });

  it("returns [] for non-positive target", () => {
    expect(sampleEvenly([1, 2, 3], 0)).toEqual([]);
    expect(sampleEvenly([1, 2, 3], -1)).toEqual([]);
  });

  it("picks evenly-spaced indices when length > target", () => {
    // 10 items, 5 target → step = 2 → indices [0, 2, 4, 6, 8]
    const xs = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    expect(sampleEvenly(xs, 5)).toEqual(["a", "c", "e", "g", "i"]);
  });

  it("handles non-integer step via floor (no out-of-bounds reads)", () => {
    // 7 items, 3 target → step = 7/3 ≈ 2.33 → floor → indices [0, 2, 4]
    const xs = ["a", "b", "c", "d", "e", "f", "g"];
    expect(sampleEvenly(xs, 3)).toEqual(["a", "c", "e"]);
  });

  it("returns N distinct items when target > 0 and length > target (no duplicates)", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i);
    const sampled = sampleEvenly(xs, 8);
    expect(sampled).toHaveLength(8);
    expect(new Set(sampled).size).toBe(8);
    // First and last buckets included → confirms even spread.
    expect(sampled[0]).toBe(0);
    expect(sampled[sampled.length - 1]).toBeGreaterThanOrEqual(75);
  });

  it("preserves original ordering of selected items", () => {
    // Even-spread MUST keep items in their original order so audit-log
    // replay + the examples regression suite read deterministically.
    const xs = ["z", "y", "x", "w", "v", "u", "t", "s", "r", "q"];
    const sampled = sampleEvenly(xs, 5);
    let lastIdx = -1;
    for (const s of sampled) {
      const idx = xs.indexOf(s);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("is deterministic, repeated calls produce the same result", () => {
    const xs = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    const a = sampleEvenly(xs, 7);
    const b = sampleEvenly(xs, 7);
    expect(a).toEqual(b);
  });

  it("real-world: 3272 candidates capped to 8 picks indices 0, 409, 818, 1227, 1636, 2045, 2454, 2863", () => {
    // Mirrors the wheels-repo scenario in feedback_real_repo_signal.md:
    // before this change, slice(0, 8) returned the first 8 alphabetical
    // candidates (all from app/controllers/* and app/events/*).
    // After the change, the 8-item sample spans the full sorted list.
    const xs = Array.from({ length: 3272 }, (_, i) => i);
    const sampled = sampleEvenly(xs, 8);
    expect(sampled).toEqual([0, 409, 818, 1227, 1636, 2045, 2454, 2863]);
  });
});

// runGenerate is the load-bearing CLI surface every operator hits; this
// suite was previously testing only the sampleEvenly helper, leaving
// the orchestrator's filter, outcome-classification, audit-row, and
// early-return branches verified only indirectly through replay.test.ts
// (which calls runGenerate as a setup step). A regression in --only,
// --name, --since fallback, the created/updated/unchanged outcome, or
// the work=0 early-return would silently change customer behavior.

// Non-trivial bodies so scanProject's constant-return filter (default-on)
// keeps the fixtures. Constant-return semantics are unit-tested in
// triviality.test.ts.
const FIXTURE_TWO = `<cffunction name="alpha" returntype="boolean" access="public">
  <cfset var ok = something()>
  <cfreturn ok>
</cffunction>
<cffunction name="beta" returntype="boolean" access="public">
  <cfset var ok = somethingElse()>
  <cfreturn ok>
</cffunction>
`;

const FIXTURE_SINGLE = `<cffunction name="solo" returntype="boolean" access="public">
  <cfset var ok = something()>
  <cfreturn ok>
</cffunction>
`;

// Java Spring controller with method `hello`. The Java parser produces
// candidate name `HelloController.hello` (ClassName.method format).
// Used to exercise the `c.name.endsWith("." + needle)` branch of --name.
const FIXTURE_JAVA_CONTROLLER = `package com.example;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class HelloController {
    @GetMapping("/hello")
    public String hello() {
        String result = greetingService.buildGreeting();
        return result;
    }
}
`;

interface AuditRow {
  operation: string;
  page: string;
  outcome: string;
  details?: Record<string, unknown>;
  content_hash: string | null;
}

async function readGenerateRows(dir: string): Promise<AuditRow[]> {
  const raw = await fs.readFile(
    path.join(dir, ".code2wiki", "audit.jsonl"),
    "utf-8",
  );
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditRow)
    .filter((e) => e.operation === "generate");
}

describe("runGenerate", () => {
  let dir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-gen-cli-"));
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({
        output: "./docs/use-cases",
        include: ["src/**/*.cfc"],
        maxCandidates: 50,
      }),
      "utf-8",
    );
    savedEnv = {
      CODE2WIKI_MOCK: process.env["CODE2WIKI_MOCK"],
      ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
    };
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["CODE2WIKI_MOCK"] = "1";
  });

  afterEach(async () => {
    vi.mocked(changedFilesSince).mockClear();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // --only is a relativePath substring filter (NOT a glob). A regression
  // swapping `includes` for an exact match would silently drop every
  // candidate not at the exact path; swapping for a glob/regex would
  // collide with operator-supplied special chars. Pin the substring
  // semantic against a layout where one file matches and one doesn't.
  it("--only filters candidates by relativePath substring", async () => {
    await fs.mkdir(path.join(dir, "src", "billing"), { recursive: true });
    await fs.mkdir(path.join(dir, "src", "shipping"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "src", "billing", "invoice.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "src", "shipping", "label.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );

    await runGenerate({ cwd: dir, mock: true, only: "billing" });

    const rows = await readGenerateRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details?.["source"]).toContain("billing");
    expect(rows[0]!.details?.["source"]).not.toContain("shipping");
    // Output dir should contain exactly the billing-derived .md.
    const outFiles = await fs.readdir(path.join(dir, "docs", "use-cases"));
    expect(outFiles).toHaveLength(1);
  });

  // Pins the filter-before-cap ordering documented in generate.ts:88:
  // "--only / --name / --since filters apply BEFORE this cap".
  //
  // Setup: 4 candidates whose sorted relativePaths are
  //   0: src/aaa.cfc
  //   1: src/auth/login.cfc   <- the target
  //   2: src/ccc.cfc
  //   3: src/zzz.cfc
  //
  // sampleEvenly(4 items, cap=2) picks indices 0 and 2 (aaa + ccc).
  //
  // Wrong order (cap first): sampleEvenly picks aaa + ccc; --only "auth"
  //   matches neither → 0 generate rows. A refactor that moves the cap
  //   block before the filter blocks would silently produce this.
  //
  // Correct order (filter first): --only "auth" keeps only auth/login.cfc
  //   (1 candidate); cap of 2 doesn't fire (1 <= 2) → 1 generate row.
  it("--only filter runs BEFORE the --limit cap (filter-then-cap ordering)", async () => {
    await fs.mkdir(path.join(dir, "src", "auth"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "aaa.cfc"), FIXTURE_SINGLE, "utf-8");
    await fs.writeFile(
      path.join(dir, "src", "auth", "login.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );
    await fs.writeFile(path.join(dir, "src", "ccc.cfc"), FIXTURE_SINGLE, "utf-8");
    await fs.writeFile(path.join(dir, "src", "zzz.cfc"), FIXTURE_SINGLE, "utf-8");

    // limit=2 sets maxCandidates=2 (same as passing --limit 2 on the CLI).
    await runGenerate({ cwd: dir, mock: true, only: "auth", limit: 2 });

    const rows = await readGenerateRows(dir);
    // Correct: 1 result from auth/login.cfc.
    // Wrong (cap first): 0 results (aaa + ccc sampled, neither in auth/).
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details?.["source"]).toContain("auth");
  }, 30000);

  // --name uses `c.name === needle || c.name.endsWith("." + needle)` so
  // both `--name solo` and `--name MyClass.solo` pick the same Java
  // method. Pin the bare-name path against the cfml two-function
  // fixture: only `alpha` is processed, `beta` is dropped.
  it("--name filters candidates to the matching function name", async () => {
    await fs.writeFile(
      path.join(dir, "src", "two.cfc"),
      FIXTURE_TWO,
      "utf-8",
    );

    await runGenerate({ cwd: dir, mock: true, name: "alpha" });

    const rows = await readGenerateRows(dir);
    expect(rows).toHaveLength(1);
    // The slug derives from the function name + a -v1 suffix in mock
    // output; assert the audit page slug starts with the function name.
    expect(rows[0]!.page).toMatch(/^alpha/);
    const outFiles = await fs.readdir(path.join(dir, "docs", "use-cases"));
    expect(outFiles).toHaveLength(1);
    expect(outFiles[0]).toMatch(/^alpha/);
  });

  // The bare-name test above only covers the `c.name === needle` branch.
  // Java candidates have names in "ClassName.method" format (produced by
  // parseJava at java.ts:237: `${className}.${methodName}`). When a user
  // passes `--name hello`, the filter must match `HelloController.hello`
  // via the suffix branch `c.name.endsWith("." + needle)`. A regression
  // removing that OR branch (or the leading dot, making it `.endsWith(needle)`
  // which would also match "ahello") would compile clean and silence the
  // CLI for every Java repo where the user passes only the method name.
  //
  // Two sub-cases: (1) bare method name matches the suffix; (2) a
  // prefix-only pass (`--name HelloController`) does NOT match via suffix
  // (the name is `HelloController.hello`, which doesn't end with `.HelloController`).
  it("--name suffix match: bare method name matches Java 'ClassName.method' candidates", async () => {
    // Override the beforeEach config (which only includes *.cfc) to add Java.
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ output: "./docs/use-cases", include: ["**/*.java"], maxCandidates: 50 }),
      "utf-8",
    );
    await fs.mkdir(path.join(dir, "src", "java"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "src", "java", "HelloController.java"),
      FIXTURE_JAVA_CONTROLLER,
      "utf-8",
    );

    // `--name hello` must match `HelloController.hello` via endsWith(".hello").
    await runGenerate({ cwd: dir, mock: true, name: "hello" });
    const rows = await readGenerateRows(dir);
    expect(rows).toHaveLength(1);
    // The generated page is for HelloController.hello, not some other candidate.
    expect(rows[0]!.details?.["source"]).toMatch(/HelloController\.java$/);
  });

  it("--name prefix-only does NOT match Java 'ClassName.method' via suffix", async () => {
    // Override the beforeEach config (which only includes *.cfc) to add Java.
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ output: "./docs/use-cases", include: ["**/*.java"], maxCandidates: 50 }),
      "utf-8",
    );
    await fs.mkdir(path.join(dir, "src", "java"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "src", "java", "HelloController.java"),
      FIXTURE_JAVA_CONTROLLER,
      "utf-8",
    );

    // `--name HelloController` should NOT match `HelloController.hello`:
    // `"HelloController.hello".endsWith(".HelloController")` is false and
    // `"HelloController.hello" === "HelloController"` is also false.
    // The zero-candidate path exits before creating audit.jsonl or output
    // files, so we check the output dir rather than readGenerateRows.
    await runGenerate({ cwd: dir, mock: true, name: "HelloController" });
    const outDir = path.join(dir, "docs", "use-cases");
    const exists = await fs.stat(outDir).catch(() => null);
    // No candidates matched: output dir was never created.
    expect(exists).toBeNull();
  });

  // --since with a ref that fails (non-git tmpdir → changedFilesSince
  // returns null) MUST fall back to "regenerate everything" rather than
  // silently emitting an empty changedSet (which would skip every
  // candidate). The console.warn at L45 is the operator's only signal
  // this happened; pin it via a console.warn spy so a regression that
  // swallows the warning surfaces here.
  it("--since with an invalid ref warns and falls back to full regeneration", async () => {
    await fs.writeFile(
      path.join(dir, "src", "solo.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warns.push(args.map(String).join(" "));
    };
    try {
      await runGenerate({
        cwd: dir,
        mock: true,
        since: "no-such-ref",
      });
    } finally {
      console.warn = origWarn;
    }
    const rows = await readGenerateRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("created");
    const fellBack = warns.some(
      (w) => w.includes("--since") && w.includes("falling back"),
    );
    expect(fellBack).toBe(true);
  }, 30000);

  // Regression guard for the --since happy path. The null-return (git
  // diff failed) fallback is tested above; the success path where
  // changedFilesSince returns a file list and work is filtered has NO
  // test. A regression e.g. comparing c.filePath against changedSet
  // instead of c.relativePath, or forgetting to Set-wrap the array,
  // would silently make --since regenerate nothing, emitting zero audit
  // rows with no operator-visible error. Parallel to the
  // includeConstantReturns threading pin in a3a9adf: the feature
  // existing is necessary but not sufficient, the threading through
  // runGenerate must also be pinned.
  it("--since with a valid ref regenerates only candidates from changed files", async () => {
    await fs.mkdir(path.join(dir, "src", "billing"), { recursive: true });
    await fs.mkdir(path.join(dir, "src", "shipping"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "src", "billing", "invoice.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "src", "shipping", "label.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );

    // Simulate git reporting only invoice.cfc changed since HEAD~1.
    // changedFilesSince returns project-root-relative paths.
    vi.mocked(changedFilesSince).mockResolvedValueOnce([
      path.join("src", "billing", "invoice.cfc"),
    ]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]): void => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await runGenerate({ cwd: dir, mock: true, since: "HEAD~1" });
    } finally {
      console.log = origLog;
    }

    // Only the billing candidate processed; shipping skipped.
    const rows = await readGenerateRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details?.["source"]).toContain("billing");
    expect(rows[0]!.details?.["source"]).not.toContain("shipping");

    // Operator-visible log: "1 file(s) changed, 2 -> 1 candidate(s) to regenerate."
    const filterLog = logs.find((l) => l.includes("file(s) changed"));
    expect(filterLog).toBeDefined();
    expect(filterLog).toContain("1 file(s) changed");
    expect(filterLog).toMatch(/2 -> 1 candidate/);
  });

  // outcome=created fires when the output file doesn't exist yet. Pin
  // the first-run row's outcome AND the load-bearing details fields:
  // promptVersion (per docs/self-learning.md, every generate row must
  // carry it for replay --since-version filtering); mock (operator
  // signal: was this LLM-cost or free?); confidence (used by the
  // dashboard's per-run confidence card); lines (used by replay's
  // candidate-match log line); content_hash (sha256 prefix shape).
  // A regression dropping any one of these surfaces would compile
  // clean (details is Record<string, unknown>) and silently break a
  // downstream surface.
  //
  // outcome="unchanged" is pinned via the opts.now seam (see the test
  // after outcome=updated). The complementary "updated" branch is also
  // pinned in the next test via on-disk tampering.
  it("outcome=created on first run with all load-bearing audit details fields populated", async () => {
    await fs.writeFile(
      path.join(dir, "src", "solo.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );

    await runGenerate({ cwd: dir, mock: true });
    const rows = await readGenerateRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("created");
    expect(rows[0]!.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rows[0]!.details?.["promptVersion"]).toBe(PROMPT_VERSION);
    expect(rows[0]!.details?.["mock"]).toBe(true);
    expect(rows[0]!.details?.["confidence"]).toBeDefined();
    expect(rows[0]!.details?.["lines"]).toMatch(/^\d+-\d+$/);
    expect(rows[0]!.details?.["source"]).toBe("src/solo.cfc");
  });

  // outcome=updated fires when the on-disk file diverges from the
  // fresh render. Tamper with the local .md between runs to drive the
  // existing !== md branch. A regression flipping the comparator (e.g.
  // hashing both sides into different shapes) would mis-classify drift
  // and either always-update (audit-log spam) or always-unchanged
  // (silent drift, customer wikis stale).
  it("outcome=updated when the on-disk file differs from a fresh render", async () => {
    await fs.writeFile(
      path.join(dir, "src", "solo.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );
    await runGenerate({ cwd: dir, mock: true });
    const outDir = path.join(dir, "docs", "use-cases");
    const [first] = await fs.readdir(outDir);
    const filePath = path.join(outDir, first!);
    const original = await fs.readFile(filePath, "utf-8");
    // Inject a body edit OUTSIDE the managed fence so the next render
    // (which doesn't touch outside-fence content because runGenerate
    // overwrites the whole file anyway) produces different bytes.
    await fs.writeFile(filePath, original + "\n## TAMPERED\n", "utf-8");

    await runGenerate({ cwd: dir, mock: true });
    const rows = await readGenerateRows(dir);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.outcome).toBe("created");
    expect(rows[1]!.outcome).toBe("updated");
    // Re-render restores the canonical content, so file no longer
    // contains the tampered marker.
    const restored = await fs.readFile(filePath, "utf-8");
    expect(restored).not.toContain("TAMPERED");
  });

  // outcome=unchanged fires when the on-disk file is byte-identical to
  // the fresh render. The rendered Markdown carries last_generated, so
  // two back-to-back calls with a real clock would always diverge at ms
  // resolution. The opts.now seam fixes the timestamp so both runs
  // produce identical bytes, exercising the `existing === md` branch.
  //
  // A regression breaking this branch (e.g. always writing "updated")
  // would spam audit logs for customers who run generate in CI on
  // unchanged files and watch the audit log for real drift. The console
  // output also differs (· for unchanged vs ✓ for updated).
  it("outcome=unchanged when a second run produces byte-identical output (opts.now seam)", async () => {
    await fs.writeFile(
      path.join(dir, "src", "solo.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );
    const fixedNow = () => "2026-01-01T00:00:00.000Z";
    await runGenerate({ cwd: dir, mock: true, now: fixedNow });
    await runGenerate({ cwd: dir, mock: true, now: fixedNow });
    const rows = await readGenerateRows(dir);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.outcome).toBe("created");
    expect(rows[1]!.outcome).toBe("unchanged");
  });

  // --limit caps work to N via sampleEvenly + emits a console.warn so
  // the operator knows they got a representative sample, not everything.
  // Three independent surfaces to pin:
  //   (a) opts.limit overrides config.maxCandidates (the "50 default"
  //       in the fixture config would otherwise not trigger a cap);
  //   (b) the work.length > maxCandidates branch fires and actually
  //       samples down to N (only 1 audit row for limit=1 with 2 cfc);
  //   (c) console.warn emits "maxCandidates=1" so the operator can grep
  //       build logs and understand why they see fewer pages than files.
  // A regression e.g. changing opts.limit → config.maxCandidates * 2,
  // dropping the warn, or inverting the condition would compile clean
  // and pass every other test in this suite.
  it("--limit caps candidates via sampleEvenly and emits the maxCandidates warn", async () => {
    // Two CFC files, each with one non-trivial function, so scanProject
    // emits two candidates. With limit=1, sampleEvenly should keep one.
    await fs.writeFile(
      path.join(dir, "src", "alpha.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );
    await fs.mkdir(path.join(dir, "src", "sub"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "src", "sub", "beta.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warns.push(args.map(String).join(" "));
    };
    try {
      await runGenerate({ cwd: dir, mock: true, limit: 1 });
    } finally {
      console.warn = origWarn;
    }

    // Exactly 1 generate audit row: the cap reduced 2 candidates to 1.
    const rows = await readGenerateRows(dir);
    expect(rows).toHaveLength(1);

    // Exactly 1 .md file in the output dir.
    const outFiles = await fs.readdir(path.join(dir, "docs", "use-cases"));
    expect(outFiles.filter((f) => f.endsWith(".md"))).toHaveLength(1);

    // The operator-visible warn must fire and mention maxCandidates=1.
    const capWarn = warns.find((w) => w.includes("maxCandidates=1"));
    expect(capWarn).toBeDefined();
    expect(capWarn).toMatch(/sampling evenly/i);
  }, 30000);

  // work.length === 0 hits the early "No candidates to process." return
  // path BEFORE any audit append + BEFORE the output dir is created
  // (mkdir runs at L84, AFTER the L76 check; verify via absence of
  // both audit.jsonl and the output dir). A regression that fell
  // through past the early return would either crash on the empty
  // work loop or write a stale audit row from an earlier run.
  it("returns early without writing audit entries when no candidates match", async () => {
    await fs.writeFile(
      path.join(dir, "src", "solo.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );
    // --only with a substring that matches nothing yields work.length===0.
    await runGenerate({
      cwd: dir,
      mock: true,
      only: "no-such-substring",
    });
    // No audit.jsonl created (early return precedes appendAuditEntry).
    await expect(
      fs.stat(path.join(dir, ".code2wiki", "audit.jsonl")),
    ).rejects.toThrow();
    // No output directory created either (mkdir is downstream of the
    // early return at L76-79 / L84).
    await expect(
      fs.stat(path.join(dir, "docs", "use-cases")),
    ).rejects.toThrow();
  });

  // The for-loop try/catch at generate.ts:160-176 is the only path that
  // emits an `outcome="error"` generate audit row. It fires when
  // anything inside extractUseCase / renderUseCase / fs.writeFile /
  // the immediately-following audit append throws. Until now no test
  // exercised this branch, so a regression mis-keying the error-row
  // `page` field (e.g. sourcing from a not-yet-defined `useCase.slug`
  // when extractUseCase threw), dropping the `promptVersion` stamp
  // from the error path (silently excluding error rows from
  // `replay --since-version` filtering), inverting the contentHash
  // default (writing a stale or fabricated sha256 prefix), or
  // forgetting the audit append entirely (so customer wikis would
  // see "fewer docs than expected" without a paper trail) would
  // compile clean and pass every other test in this suite.
  //
  // Drive the failure through `fs.writeFile` at generate.ts:143 by
  // pre-occupying the slug's output path with a DIRECTORY (writeFile
  // → EISDIR). mkdir at L84 is OUTSIDE the try/catch so we cannot
  // sabotage the output root; the per-candidate `.md` path inside it
  // is the right injection point.
  it("appends outcome=error generate row when writing the rendered .md fails", async () => {
    await fs.writeFile(
      path.join(dir, "src", "solo.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );
    // First run discovers the slug filename mockExtract derives so we
    // can sabotage the SAME path on the second run. (Coupling the test
    // to a hardcoded "solo-draft.md" would brittle-fail any time the
    // mock's humanize pipeline shifts; reading it from disk keeps this
    // test resilient to mockExtract title changes.)
    await runGenerate({ cwd: dir, mock: true });
    const outDir = path.join(dir, "docs", "use-cases");
    const [slugFile] = await fs.readdir(outDir);
    expect(slugFile).toBeDefined();
    await fs.rm(path.join(outDir, slugFile!));
    // Sabotage: replace the file with a directory at the same path.
    // fs.readFile at L138 will throw EISDIR (caught locally → outcome
    // resets to "created"), then fs.writeFile at L143 throws EISDIR
    // and the error propagates to the outer catch at L160.
    await fs.mkdir(path.join(outDir, slugFile!));

    // Suppress the expected console.error so the suite output stays
    // quiet; capture lines so we can pin the operator-visible signal
    // (a regression silencing the error path would surface here).
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]): void => {
      errs.push(args.map(String).join(" "));
    };
    try {
      await runGenerate({ cwd: dir, mock: true });
    } finally {
      console.error = origErr;
    }

    const rows = await readGenerateRows(dir);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.outcome).toBe("created");
    expect(rows[1]!.outcome).toBe("error");

    // page on the error row is candidate.name (L169), NOT useCase.slug,
    // so this surface stays populated even when extractUseCase itself
    // throws (a hypothetical future regression). The dashboard error
    // surface keys per-candidate retry suggestions off this exact field.
    expect(rows[1]!.page).toBe("solo");

    // content_hash defaults to null when runGenerate omits contentHash
    // (audit.ts:154). A regression fabricating a stub sha256 prefix on
    // the error path would break the auditor invariant that error rows
    // never carry a content hash (no content was successfully written).
    expect(rows[1]!.content_hash).toBeNull();

    // promptVersion MUST stamp the error path too (generate.ts:174).
    // replay --since-version walks every `generate` row; dropping the
    // stamp here would silently exclude error rows from version-filtered
    // replays and the audit "did this error happen before/after v3?"
    // forensics path would lose precision.
    expect(rows[1]!.details?.["promptVersion"]).toBe(PROMPT_VERSION);
    expect(rows[1]!.details?.["source"]).toBe("src/solo.cfc");

    // Error message captured from (e as Error).message at L173. Pin the
    // SHAPE (non-empty string) rather than the exact bytes because
    // Node's fs error messages drift between minor versions; pin EISDIR
    // specifically because that's the OS signal our directory-collision
    // sabotage produces, and a regression catching+swallowing system
    // errors before they reach the audit row would surface here.
    expect(typeof rows[1]!.details?.["error"]).toBe("string");
    expect((rows[1]!.details?.["error"] as string).length).toBeGreaterThan(0);
    expect(rows[1]!.details?.["error"] as string).toMatch(/EISDIR|is a directory/i);

    // Console.error fires once per candidate failure (generate.ts:161);
    // the line carries `<source>:<lineStart>` so operators can grep
    // their build logs back to the source location. A regression
    // routing the error to console.log or dropping the location prefix
    // would surface here.
    expect(errs.some((e) => e.includes("src/solo.cfc"))).toBe(true);
  });

  // ORDERING invariant (CLAUDE.md "Key conventions"): when the chain-of-
  // correction retry fires, the `retried` audit entry MUST be appended
  // BEFORE the `generate` entry for the same candidate. Downstream
  // tooling (replay, feedback/[pageId] drill-down, signal #4) reads the
  // log sequentially and expects to see the retry context before the
  // final outcome. A regression that swapped the two appendAuditEntry
  // calls in generate.ts (or dropped the retried append entirely) would
  // compile clean and pass every other test here because readGenerateRows
  // filters to operation==="generate" and never checks ordering.
  //
  // To drive the retry path without a real API key we use the injectable
  // llmFn seam on extractUseCase (surfaced via GenerateOptions.llmFn):
  //   - call 1 returns {} (fails all three error-severity checks)
  //   - call 2 (retry) returns a minimal valid draft
  // This lets runGenerate exercise the real chain-of-correction logic in
  // extractor.ts while staying fully offline.
  it("writes retried entry BEFORE generate entry in audit.jsonl when retry fires (ordering invariant)", async () => {
    await fs.writeFile(
      path.join(dir, "src", "solo.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );

    let callCount = 0;
    const testLlmFn: LlmFn = async () => {
      callCount++;
      if (callCount === 1) {
        // Broken draft: triggers error-severity issues for summary, actor,
        // and main_flow length (all three are absence-checks in validator.ts).
        return {};
      }
      // Valid retry draft: clears all error-severity checks.
      return {
        title: "Solo",
        actor: "An application caller",
        summary: "Solo executes a unit of work for the calling system.",
        trigger: "The caller invokes solo.",
        main_flow: [
          { step: "The system receives the invocation." },
          { step: "Control returns to the caller." },
        ],
        postconditions: ["The operation completes."],
        confidence: "low" as const,
        confidence_reason: "test stub",
      };
    };

    await runGenerate({ cwd: dir, mock: true, llmFn: testLlmFn });

    // Read ALL entries (retried + generate) from raw audit.jsonl.
    const raw = await fs.readFile(
      path.join(dir, ".code2wiki", "audit.jsonl"),
      "utf-8",
    );
    const entries = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { operation: string; page: string; outcome: string; details?: Record<string, unknown> });

    expect(entries).toHaveLength(2);

    // Ordering: retried must precede generate.
    expect(entries[0]!.operation).toBe("retried");
    expect(entries[1]!.operation).toBe("generate");

    // Both entries reference the same page slug.
    expect(entries[0]!.page).toBe(entries[1]!.page);

    // retried entry content: the first draft had errors, the retry recovered.
    expect(entries[0]!.outcome).toBe("recovered");
    expect(
      (entries[0]!.details?.["firstIssues"] as unknown[]).length,
    ).toBeGreaterThan(0);
    expect(entries[0]!.details?.["firstErrorCount"]).toBeGreaterThan(0);
    expect(entries[0]!.details?.["retriedErrorCount"]).toBe(0);
    expect(entries[0]!.details?.["promptVersion"]).toBe(PROMPT_VERSION);

    // generate entry follows as a normal created row.
    expect(entries[1]!.outcome).toBe("created");

    // llmFn was called exactly twice (first draft + retry, no extra calls).
    expect(callCount).toBe(2);
  });

  // validSlugs wiring (commit 905c1c3): the two-pass flow MUST collect
  // every successfully-extracted use case's slug into a Set in pass 1,
  // then pass that Set into renderUseCase() in pass 2 so related-use-
  // case items pointing at speculative-but-not-emitted slugs degrade to
  // plain text. This pins BOTH wires at the generate.ts integration
  // level (renderer.test.ts covers the renderer alone; that's not
  // sufficient because a regression dropping `validSlugs.add(useCase.slug)`
  // in pass 1 OR dropping the second argument from `renderUseCase(useCase,
  // validSlugs)` in pass 2 would compile clean and pass every existing
  // generate.test.ts case).
  //
  // Two-page fixture (alpha + beta both real, in-run); each page's
  // mocked LLM result references the other page (in-run, should link)
  // AND a speculative slug that no candidate produces (out-of-run,
  // should degrade to plain text). The assertions check both directions
  // on both pages so an iteration-order bug (e.g. validSlugs grown
  // during pass 2 instead of populated upfront) surfaces here too.
  it("renderUseCase receives validSlugs containing every in-run slug; speculative cross-refs degrade to plain text", async () => {
    await fs.writeFile(
      path.join(dir, "src", "two.cfc"),
      FIXTURE_TWO,
      "utf-8",
    );

    const testLlmFn: LlmFn = async ({ candidate }) => {
      // Differentiate by candidate.name so each function gets its own
      // related[] list. Both titles slugify deterministically so the
      // expected slugs are stable: "Alpha Feature" -> "alpha-feature",
      // "Beta Feature" -> "beta-feature".
      const isAlpha = candidate.name === "alpha";
      const title = isAlpha ? "Alpha Feature" : "Beta Feature";
      return {
        title,
        actor: "An application caller",
        summary: `${title} executes a unit of work for the calling system.`,
        trigger: `The caller invokes ${candidate.name}.`,
        main_flow: [
          { step: "The system receives the invocation." },
          { step: "Control returns to the caller." },
        ],
        postconditions: ["The operation completes."],
        related: [
          // In-run cross-ref: the OTHER candidate's emitted slug. Must
          // render as a Markdown link [Title](slug).
          isAlpha
            ? { slug: "beta-feature", title: "Beta Feature" }
            : { slug: "alpha-feature", title: "Alpha Feature" },
          // Out-of-run speculative ref: no candidate produces this slug.
          // Must render as plain text "- Speculative Title" (NO `[..](..)`).
          isAlpha
            ? { slug: "ghost-feature", title: "Ghost Feature" }
            : { slug: "phantom-feature", title: "Phantom Feature" },
        ],
        confidence: "low" as const,
        confidence_reason: "test stub",
      };
    };

    await runGenerate({ cwd: dir, mock: true, llmFn: testLlmFn });

    const outDir = path.join(dir, "docs", "use-cases");
    const alphaMd = await fs.readFile(
      path.join(outDir, "alpha-feature.md"),
      "utf-8",
    );
    const betaMd = await fs.readFile(
      path.join(outDir, "beta-feature.md"),
      "utf-8",
    );

    // In-run cross-ref MUST be a Markdown link on both pages.
    // A regression dropping `validSlugs.add(useCase.slug)` in pass 1
    // would leave validSlugs empty, so even in-run slugs would render
    // as plain text and these assertions would fail.
    expect(alphaMd).toContain("- [Beta Feature](beta-feature)");
    expect(betaMd).toContain("- [Alpha Feature](alpha-feature)");

    // Out-of-run speculative ref MUST be plain text on both pages.
    // A regression dropping the `validSlugs` arg from `renderUseCase(useCase,
    // validSlugs)` in pass 2 would render every related item as a link
    // (the renderer falls back to "link everything" when validSlugs is
    // undefined), so the speculative slugs would surface as anchors and
    // these toContain checks would fire.
    expect(alphaMd).toContain("- Ghost Feature");
    expect(alphaMd).not.toContain("(ghost-feature)");
    expect(betaMd).toContain("- Phantom Feature");
    expect(betaMd).not.toContain("(phantom-feature)");

    // Belt-and-suspenders: each page's "Related use cases" section MUST
    // exist (a regression that filtered the section out entirely when
    // validSlugs was non-empty would surface here).
    expect(alphaMd).toContain("## Related use cases");
    expect(betaMd).toContain("## Related use cases");
  });
});

describe("runGenerate --estimate-cost dry-run path", () => {
  // Pins the --estimate-cost flow. Three load-bearing surfaces:
  //   1. Zero LLM calls and zero filesystem side effects (no audit
  //      log, no output dir, no .md files). The estimate is a pre-
  //      flight check; touching disk would surprise an operator who
  //      ran it just to sanity-check the bill.
  //   2. Printed totals match hand-computed values from the same
  //      pricing constants the cost helper consumes. A regression
  //      that flipped the cache discount, swapped the input/output
  //      rates, or changed the 3000-tokens-per-page projection would
  //      show up as a numeric mismatch here.
  //   3. $5 warn threshold: fires when total > $5, suppressed when
  //      total <= $5. The warning is the only signal an operator
  //      gets that they should pass --limit before the real run.
  let dir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-gen-cost-"));
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({
        output: "./docs/use-cases",
        include: ["src/**/*.cfc"],
        maxCandidates: 50,
      }),
      "utf-8",
    );
    savedEnv = {
      CODE2WIKI_MOCK: process.env["CODE2WIKI_MOCK"],
      ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
    };
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["CODE2WIKI_MOCK"];
  });

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // Two-candidate setup (alpha + beta from FIXTURE_TWO).
  async function writeTwoCandidateFixture(): Promise<void> {
    await fs.writeFile(
      path.join(dir, "src", "two.cfc"),
      FIXTURE_TWO,
      "utf-8",
    );
  }

  it("prints hand-computed totals from mocked countTokens and makes ZERO LLM + filesystem-write calls", async () => {
    await writeTwoCandidateFixture();
    // Mock countTokens to return deterministic values per candidate:
    //   systemTokens=500, userTokens=1500
    // With 2 candidates:
    //   totalSystem  = 1000
    //   totalUser    = 3000
    //   estOutput    = 2 × 3000 = 6000
    //   cachedInput  = 1000 × ($3 / 1M) × 0.5 = $0.0015
    //   uncachedIn   = 3000 × ($3 / 1M)       = $0.0090
    //   output       = 6000 × ($15 / 1M)      = $0.0900
    //   total        = $0.1005 → printed as "$0.10"
    // All values pinned literally so a regression in any constant
    // (input rate, output rate, cache discount, output-tokens-per-
    // page projection) surfaces here.
    const countTokensFn = vi.fn(async () => ({
      systemTokens: 500,
      userTokens: 1500,
    }));
    // llmFn must NEVER be called on the estimate path. Pass one that
    // throws so a regression falling through to extraction surfaces as
    // a test failure (not a silent token spend).
    const llmFn = vi.fn(async () => {
      throw new Error(
        "llmFn called during --estimate-cost; expected to be skipped entirely.",
      );
    });

    const logs: string[] = [];
    const warns: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args: unknown[]): void => {
      logs.push(args.map(String).join(" "));
    };
    console.warn = (...args: unknown[]): void => {
      warns.push(args.map(String).join(" "));
    };
    try {
      await runGenerate({
        cwd: dir,
        estimateCost: true,
        countTokensFn,
        llmFn,
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }

    // countTokensFn was called once per candidate.
    expect(countTokensFn).toHaveBeenCalledTimes(2);
    // llmFn never invoked, the dry-run path returned before extraction.
    expect(llmFn).not.toHaveBeenCalled();

    // No audit log written.
    await expect(
      fs.stat(path.join(dir, ".code2wiki", "audit.jsonl")),
    ).rejects.toThrow();
    // No output directory created.
    await expect(
      fs.stat(path.join(dir, "docs", "use-cases")),
    ).rejects.toThrow();

    // Pin the printed total to the hand-computed $0.10. The exact
    // string "$0.10" is the operator-facing signal; a regression in
    // any constant shifts this.
    const totalLog = logs.find((l) => l.includes("Total:"));
    expect(totalLog).toBeDefined();
    expect(totalLog).toContain("$0.10");

    // Pin candidate count + per-row token breakdown (operator sanity
    // check: did the estimate cover the candidates they expected?).
    expect(logs.some((l) => l.includes("Candidates: 2"))).toBe(true);
    // 1,000 system / 3,000 user (with toLocaleString thousands sep).
    expect(
      logs.some(
        (l) =>
          l.includes("1,000 system") &&
          l.includes("3,000 user"),
      ),
    ).toBe(true);
    // Output projection: 2 × 3000 = 6,000.
    expect(logs.some((l) => l.includes("6,000"))).toBe(true);

    // No threshold warning at $0.10.
    expect(warns.some((w) => w.includes("Estimate exceeds"))).toBe(false);
  });

  it("warns when the estimate exceeds $5 (over-threshold path)", async () => {
    await writeTwoCandidateFixture();
    // Mocked counts that push us over $5:
    //   systemTokens=100,000, userTokens=1,000,000 per candidate × 2:
    //     totalSystem  = 200,000
    //     totalUser    = 2,000,000
    //     estOutput    = 6,000
    //     cachedInput  = 200,000 × $3/1M × 0.5 = $0.30
    //     uncachedIn   = 2,000,000 × $3/1M      = $6.00
    //     output       = 6,000 × $15/1M         = $0.09
    //     total        = $6.39 → triggers $5 warning
    const countTokensFn = vi.fn(async () => ({
      systemTokens: 100_000,
      userTokens: 1_000_000,
    }));
    const llmFn = vi.fn(async () => {
      throw new Error("llmFn must not be invoked on estimate path");
    });

    const logs: string[] = [];
    const warns: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args: unknown[]): void => {
      logs.push(args.map(String).join(" "));
    };
    console.warn = (...args: unknown[]): void => {
      warns.push(args.map(String).join(" "));
    };
    try {
      await runGenerate({
        cwd: dir,
        estimateCost: true,
        countTokensFn,
        llmFn,
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }

    // Total printed at the hand-computed $6.39.
    const totalLog = logs.find((l) => l.includes("Total:"));
    expect(totalLog).toContain("$6.39");

    // The warn fires AND mentions --limit (the operator's escape
    // hatch). A regression dropping either piece (silent warn, or
    // warn that doesn't tell the operator what to do) surfaces here.
    const warning = warns.find((w) => w.includes("Estimate exceeds"));
    expect(warning).toBeDefined();
    expect(warning).toContain("$5");
    expect(warning).toContain("--limit");

    // Still zero LLM calls on the over-threshold path.
    expect(llmFn).not.toHaveBeenCalled();
  });

  // Pins generate.ts:102-106: "--estimate-cost is placed AFTER scan + filters
  // + maxCandidates cap". A regression moving estimateCost before the filter
  // blocks would call countTokensFn on ALL candidates, silently over-estimating
  // cost for every `--estimate-cost --only <dir>` or `--estimate-cost --limit N`
  // invocation. Operators rely on accurate estimates to decide whether to narrow
  // the run; a 4x over-estimate triggers the $5 warn unnecessarily.
  //
  // Setup: 4 candidates across 4 files; only src/auth/login.cfc matches
  // --only "auth". Correct: countTokensFn called 1 time. Wrong (pre-filter
  // estimate): called 4 times.
  it("--only filter applies before token counting: countTokensFn called once for the single matching candidate", async () => {
    await fs.mkdir(path.join(dir, "src", "auth"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "aaa.cfc"), FIXTURE_SINGLE, "utf-8");
    await fs.writeFile(
      path.join(dir, "src", "auth", "login.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );
    await fs.writeFile(path.join(dir, "src", "ccc.cfc"), FIXTURE_SINGLE, "utf-8");
    await fs.writeFile(path.join(dir, "src", "zzz.cfc"), FIXTURE_SINGLE, "utf-8");

    const countTokensFn = vi.fn(async () => ({
      systemTokens: 100,
      userTokens: 200,
    }));
    const llmFn = vi.fn(async () => {
      throw new Error("llmFn must not be called on estimate path");
    });

    await runGenerate({
      cwd: dir,
      estimateCost: true,
      only: "auth",
      countTokensFn,
      llmFn,
    });

    // Exactly 1 candidate matches; a pre-filter regression produces 4 here.
    expect(countTokensFn).toHaveBeenCalledTimes(1);
    // Still zero LLM calls: estimate path exits before extraction.
    expect(llmFn).not.toHaveBeenCalled();
  });
});

describe("runGenerate --min-confidence filter", () => {
  // Pins the confidence-gating path in generate.ts. Three load-bearing
  // surfaces:
  //   1. --min-confidence=high: writes only high-confidence pages; skips
  //      medium + low and emits audit entries with outcome=skipped.
  //   2. --min-confidence=medium: writes high + medium; skips low.
  //   3. --min-confidence=low (default): writes everything regardless of
  //      confidence; pre-existing behavior unchanged.
  let dir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-gen-conf-"));
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({
        output: "./docs/use-cases",
        include: ["src/**/*.cfc"],
        maxCandidates: 50,
      }),
      "utf-8",
    );
    savedEnv = {
      CODE2WIKI_MOCK: process.env["CODE2WIKI_MOCK"],
      ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
    };
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["CODE2WIKI_MOCK"] = "1";
  });

  afterEach(async () => {
    process.env["CODE2WIKI_MOCK"] = savedEnv["CODE2WIKI_MOCK"];
    if (savedEnv["ANTHROPIC_API_KEY"] !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = savedEnv["ANTHROPIC_API_KEY"];
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Minimal valid LLM draft with a given confidence level. Reused across tests.
  function makeDraft(confidence: "high" | "medium" | "low", name: string) {
    return {
      title: name,
      actor: "A user",
      summary: `${name} performs its operation.`,
      trigger: `The user invokes ${name}.`,
      main_flow: [
        { step: "The system processes the request." },
        { step: "Control returns to the caller." },
      ],
      postconditions: ["The operation completes."],
      confidence,
      confidence_reason: "test stub",
    };
  }

  it("--min-confidence=high skips medium + low pages and emits outcome=skipped audit entries", async () => {
    await fs.writeFile(path.join(dir, "src", "two.cfc"), FIXTURE_TWO, "utf-8");

    // alpha → high, beta → low
    let callCount = 0;
    const llmFn: LlmFn = async () => {
      callCount++;
      return callCount === 1
        ? makeDraft("high", "Alpha")
        : makeDraft("low", "Beta");
    };

    await runGenerate({ cwd: dir, minConfidence: "high", llmFn });

    const allEntries = await fs
      .readFile(path.join(dir, ".code2wiki", "audit.jsonl"), "utf-8")
      .then((raw) =>
        raw
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as AuditRow),
      );
    const generate = allEntries.filter((e) => e.operation === "generate");

    // Alpha written (high >= high), Beta skipped (low < high).
    const written = generate.filter((e) => e.outcome !== "skipped");
    const skipped = generate.filter((e) => e.outcome === "skipped");
    expect(written).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.details?.["skipReason"]).toBe("below_min_confidence");
    expect(skipped[0]!.details?.["confidence"]).toBe("low");

    // The alpha .md was written to disk; beta was not.
    const outFiles = await fs.readdir(path.join(dir, "docs", "use-cases"));
    expect(outFiles).toHaveLength(1);
  });

  it("--min-confidence=medium skips low-confidence pages only", async () => {
    await fs.writeFile(path.join(dir, "src", "two.cfc"), FIXTURE_TWO, "utf-8");

    let callCount = 0;
    const llmFn: LlmFn = async () => {
      callCount++;
      return callCount === 1
        ? makeDraft("medium", "Alpha")
        : makeDraft("low", "Beta");
    };

    await runGenerate({ cwd: dir, minConfidence: "medium", llmFn });

    const rows = await readGenerateRows(dir);
    const written = rows.filter((e) => e.outcome !== "skipped");
    const skipped = rows.filter((e) => e.outcome === "skipped");
    // medium >= medium → written; low < medium → skipped.
    expect(written).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  it("--min-confidence=low (default) writes all pages regardless of confidence", async () => {
    await fs.writeFile(path.join(dir, "src", "two.cfc"), FIXTURE_TWO, "utf-8");

    // Both pages are low-confidence; with the default threshold both should
    // still be written.
    let callCount = 0;
    const llmFn: LlmFn = async () => {
      callCount++;
      return makeDraft("low", callCount === 1 ? "Alpha" : "Beta");
    };

    await runGenerate({ cwd: dir, llmFn }); // no minConfidence → default "low"

    const rows = await readGenerateRows(dir);
    const skipped = rows.filter((e) => e.outcome === "skipped");
    expect(skipped).toHaveLength(0);
    // Both pages written.
    const outFiles = await fs.readdir(path.join(dir, "docs", "use-cases"));
    expect(outFiles).toHaveLength(2);
  });

  // Mirrors the outcome=created audit-invariant pin at line 441-458 (every
  // generate row must carry promptVersion + mock + source + lines + a
  // sensible content_hash for replay --since-version filtering, the
  // dashboard's per-run cards, and audit verification). The skipped path
  // emits its own appendAuditEntry call (generate.ts:330-344) that is
  // structurally separate from the success path; a regression dropping any
  // one field there would compile clean (details is Record<string, unknown>)
  // and silently break the corresponding downstream surface. content_hash
  // MUST be null on a skipped row because no .md is written (audit.ts:12,
  // "or null for skips"); a regression that started populating it would
  // mis-classify the row as a write in audit verify.
  it("skipped audit row carries promptVersion + mock + source + lines and a null content_hash", async () => {
    await fs.writeFile(path.join(dir, "src", "two.cfc"), FIXTURE_TWO, "utf-8");

    let callCount = 0;
    const llmFn: LlmFn = async () => {
      callCount++;
      return callCount === 1
        ? makeDraft("high", "Alpha")
        : makeDraft("low", "Beta");
    };

    await runGenerate({ cwd: dir, minConfidence: "high", llmFn });
    const rows = await readGenerateRows(dir);
    const skipped = rows.filter((e) => e.outcome === "skipped");
    expect(skipped).toHaveLength(1);
    const row = skipped[0]!;
    expect(row.content_hash).toBeNull();
    expect(row.details?.["promptVersion"]).toBe(PROMPT_VERSION);
    expect(row.details?.["mock"]).toBe(true);
    expect(row.details?.["source"]).toBe("src/two.cfc");
    expect(row.details?.["lines"]).toMatch(/^\d+-\d+$/);
    expect(row.details?.["confidence"]).toBe("low");
    expect(row.details?.["skipReason"]).toBe("below_min_confidence");
  });

  // Pins the defensive `?? 1` fallback in meetsConfidenceThreshold
  // (generate.ts:64) for confidence values outside the {high, medium, low}
  // enum. The extractor stamps the LLM's confidence verbatim (extractor.ts:
  // 162, no Zod parse on the inbound draft) so an llmFn that returns an
  // unrecognized value flows through to the gate. Current behavior: treat
  // unknown as level 1 ("low"), i.e., skip under --min-confidence=medium
  // and skip under --min-confidence=high; pass under --min-confidence=low.
  // A regression flipping the fallback (e.g. `?? 3` "treat unknown as
  // high, write everything") would silently change customer-visible
  // behavior with no compile error.
  it("unknown confidence value falls back to level 'low' (skipped under --min-confidence=medium)", async () => {
    await fs.writeFile(
      path.join(dir, "src", "solo.cfc"),
      FIXTURE_SINGLE,
      "utf-8",
    );

    const llmFn: LlmFn = async () =>
      ({
        ...makeDraft("low", "Solo"),
        // Cast bypasses the TS enum; the runtime extractor doesn't Zod-
        // parse the inbound draft so an unrecognized value reaches the
        // gate verbatim. Real-world trigger: a future prompt version
        // adding a new bucket (e.g., "unknown") that pre-stamp audit
        // tooling hasn't been taught.
        confidence: "n/a",
      }) as unknown as ReturnType<typeof makeDraft>;

    await runGenerate({ cwd: dir, minConfidence: "medium", llmFn });

    const rows = await readGenerateRows(dir);
    const skipped = rows.filter((e) => e.outcome === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.details?.["confidence"]).toBe("n/a");
    expect(skipped[0]!.details?.["skipReason"]).toBe("below_min_confidence");
    // No .md written.
    const outFiles = await fs.readdir(path.join(dir, "docs", "use-cases"));
    expect(outFiles).toHaveLength(0);
  }, 30000);
});

