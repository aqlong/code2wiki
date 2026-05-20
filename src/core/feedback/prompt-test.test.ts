import { describe, it, expect } from "vitest";
import {
  aggregateSnapshot,
  countMainFlowWords,
  diffSnapshots,
  type PromptTestSnapshot,
} from "./prompt-test.js";

/**
 * Pins the diff + aggregator logic that backs scripts/run-prompt-test.mjs.
 * The orchestrator script handles I/O (cloning, spawning the CLI, walking
 * docs/use-cases/) and is hard to unit test; the pure functions here ARE
 * unit-testable and carry the load-bearing behaviour:
 *
 *   1. Empty inputs degrade gracefully (no NaN, no thrown).
 *   2. Missing fields default to 0 (so a partial audit log or older
 *      report shape doesn't break the diff).
 *   3. The 10-pp regression threshold is a closed boundary, exactly
 *      10pp drop fires, 9pp drop passes. A regression flipping `>=`
 *      to `>` would silently move the gate by one point and let the
 *      next prompt edit ship with a measurable but unflagged drop.
 */

describe("aggregateSnapshot", () => {
  it("returns zero-filled snapshot for empty pages + empty audit (no NaN)", () => {
    const snap = aggregateSnapshot({ pages: [], auditEntries: [] });
    expect(snap).toEqual({
      pages: 0,
      confidence: { high: 0, medium: 0, low: 0 },
      retriedCount: 0,
      validatorWarnCounts: {},
      avgMainFlowWords: 0,
      avgBodyLineCount: 0,
    });
    // Critically: avg fields must be 0, not NaN. Math.round(NaN/0) is
    // NaN, which would JSON-serialize to null and crash the diff's
    // toFixed call downstream.
    expect(Number.isNaN(snap.avgMainFlowWords)).toBe(false);
    expect(Number.isNaN(snap.avgBodyLineCount)).toBe(false);
  });

  it("treats missing per-page fields as 0 (mainFlowWordCount, bodyLineCount, confidence)", () => {
    // Three pages, none of which carries the optional fields. A
    // regression that coerced undefined via `+` would produce NaN
    // and propagate it through the averages.
    const snap = aggregateSnapshot({
      pages: [{}, {}, {}],
      auditEntries: [],
    });
    expect(snap.pages).toBe(3);
    // confidence buckets stay 0 because no page emits high/medium/low.
    expect(snap.confidence).toEqual({ high: 0, medium: 0, low: 0 });
    // Averages are over 3 pages worth of 0s = 0, not NaN.
    expect(snap.avgMainFlowWords).toBe(0);
    expect(snap.avgBodyLineCount).toBe(0);
  });

  it("counts confidence levels into the three known buckets and ignores garbage values", () => {
    const snap = aggregateSnapshot({
      pages: [
        { confidence: "high" },
        { confidence: "high" },
        { confidence: "medium" },
        { confidence: "low" },
        // Garbage values must NOT inflate any bucket. The LLM has
        // emitted typos before; the aggregator silently drops them.
        { confidence: "HIGH" },
        { confidence: "unknown" },
        { confidence: undefined },
      ],
      auditEntries: [],
    });
    expect(snap.confidence).toEqual({ high: 2, medium: 1, low: 1 });
  });

  it("averages mainFlowWordCount and bodyLineCount (rounded to 2dp)", () => {
    const snap = aggregateSnapshot({
      pages: [
        { mainFlowWordCount: 100, bodyLineCount: 30 },
        { mainFlowWordCount: 50, bodyLineCount: 20 },
        { mainFlowWordCount: 75, bodyLineCount: 25 },
      ],
      auditEntries: [],
    });
    expect(snap.avgMainFlowWords).toBe(75);
    expect(snap.avgBodyLineCount).toBe(25);
  });

  it("counts only `retried` audit operations toward retriedCount", () => {
    const snap = aggregateSnapshot({
      pages: [],
      auditEntries: [
        { operation: "generate", outcome: "created" },
        { operation: "retried", outcome: "recovered" },
        { operation: "retried", outcome: "no_help" },
        { operation: "publish", outcome: "updated" },
        // Defensive: an operation field that's missing or unrecognized
        // must NOT count. The aggregator runs against future audit
        // logs that may carry op types we haven't seen here.
        { operation: undefined },
        { operation: "future-op-type" },
      ],
    });
    expect(snap.retriedCount).toBe(2);
  });

  it("aggregates warn-severity validator issues from retried entries' firstIssues", () => {
    const snap = aggregateSnapshot({
      pages: [],
      auditEntries: [
        {
          operation: "retried",
          outcome: "recovered",
          details: {
            firstIssues: [
              { field: "trigger", severity: "warn" },
              { field: "postconditions", severity: "warn" },
              // Errors are NOT counted in validatorWarnCounts; the
              // surface is specifically the warn signal (per the
              // operator-facing motivation in the docs).
              { field: "summary", severity: "error" },
            ],
          },
        },
        {
          operation: "retried",
          outcome: "no_help",
          details: {
            firstIssues: [{ field: "trigger", severity: "warn" }],
          },
        },
      ],
    });
    expect(snap.validatorWarnCounts).toEqual({
      trigger: 2,
      postconditions: 1,
    });
  });

  it("defaults missing issue.field to 'unknown' (defensive on malformed audit details)", () => {
    const snap = aggregateSnapshot({
      pages: [],
      auditEntries: [
        {
          operation: "retried",
          outcome: "recovered",
          details: {
            firstIssues: [
              { severity: "warn" }, // no field key
            ],
          },
        },
      ],
    });
    expect(snap.validatorWarnCounts).toEqual({ unknown: 1 });
  });

  it("treats missing details.firstIssues as no issues (older audit shape)", () => {
    const snap = aggregateSnapshot({
      pages: [],
      auditEntries: [
        { operation: "retried", outcome: "recovered" },
        { operation: "retried", outcome: "no_help", details: {} },
      ],
    });
    // retriedCount still increments; just no warn counts to collect.
    expect(snap.retriedCount).toBe(2);
    expect(snap.validatorWarnCounts).toEqual({});
  });
});

describe("countMainFlowWords", () => {
  // Regex under test: /^##\s+Main flow\s*$([\s\S]*?)(?=^##\s|$(?![\r\n]))/m.
  // Load-bearing for avgMainFlowWords in the prompt-test snapshot. A
  // regression that broke the heading match would silently report 0
  // words on every page; a regression on the EOF lookahead would clip
  // the last section's body when it isn't followed by a sibling `##`.

  it("counts words in a Main flow body that ends at the next `## ` heading", () => {
    // The lazy `*?` plus the `(?=^##\s)` lookahead must stop the capture
    // before the next sibling heading. Without the `?` (greedy), the
    // capture would eat the rest of the document.
    const content =
      "## Trigger\nopener\n\n## Main flow\n1. step one two\n2. step three\n\n## Postconditions\nignored\n";
    expect(countMainFlowWords(content)).toBe(7);
  });

  it("counts words in a Main flow body that ends at EOF (no trailing heading)", () => {
    // The `$(?![\r\n])` half of the lookahead specifically defends the
    // last-section-in-file case. Dropping the negative lookahead would
    // stop at the FIRST end-of-line and return 0.
    const content = "## Main flow\nfinal step alpha beta gamma";
    expect(countMainFlowWords(content)).toBe(5);
  });

  it("returns 0 when the Main flow heading is absent", () => {
    const content = "## Trigger\nsome content\n\n## Postconditions\nmore\n";
    expect(countMainFlowWords(content)).toBe(0);
  });

  it("returns 0 when the Main flow body is empty (heading immediately followed by next heading)", () => {
    // Capture group ends up as "\n"; .trim() yields "" so the early
    // return fires before the split. Defends against a regression that
    // skipped the empty-body short-circuit and returned 1 (from
    // [""].filter(Boolean) being [] but the length math going wrong).
    const content = "## Main flow\n\n## Postconditions\nignored\n";
    expect(countMainFlowWords(content)).toBe(0);
  });

  it("returns 0 when the Main flow body is whitespace-only", () => {
    // After trim, "" -> early return. A regression dropping the trim
    // would split "   \n  \t " on whitespace and return 0 anyway because
    // every token is empty, but we pin the early-return path explicitly
    // so the body-presence semantic is unambiguous.
    const content = "## Main flow\n   \n  \t \n\n## Postconditions\nignored\n";
    expect(countMainFlowWords(content)).toBe(0);
  });

  it("collapses runs of mixed whitespace between words into a single delimiter", () => {
    // `split(/\s+/).filter(Boolean)` defends against multi-space /
    // tab / mixed-newline runs producing empty tokens. A regression
    // switching to `split(" ")` would count 9 tokens here (5 words +
    // 4 empties from the double spaces) and inflate the average.
    const content =
      "## Main flow\nfirst   second\tthird\n\nfourth\n\n\nfifth\n";
    expect(countMainFlowWords(content)).toBe(5);
  });

  it("requires at least one space after `##` (does not match a `##Main flow` heading)", () => {
    // `\s+` in the heading match means a malformed heading without
    // whitespace after the hashes is treated as absent. Pins the
    // narrow contract; a regression widening to `\s*` would start
    // counting body words on a malformed page.
    const content = "##Main flow\nstep one two three\n";
    expect(countMainFlowWords(content)).toBe(0);
  });

  it("matches the first Main flow section when more than one is present (lazy + non-global)", () => {
    // `match` (non-global) returns the first match; the lazy `*?` makes
    // the capture stop at the EARLIEST possible boundary. So the first
    // occurrence wins. Today's documents have exactly one Main flow
    // section, but this pins the behaviour if a page ever has two
    // (which would itself be a validator bug we'd want to surface).
    const content =
      "## Main flow\nalpha beta\n\n## Postconditions\nignored\n\n## Main flow\ngamma delta epsilon\n";
    expect(countMainFlowWords(content)).toBe(2);
  });
});

describe("diffSnapshots regression-gate threshold boundary", () => {
  // Helper: build a snapshot with one repo at a known confidence split.
  // 80/10/10 mix = 80% high; 70/20/10 = 70% high; 71/19/10 = 71% high.
  function snap(
    repo: string,
    h: number,
    m: number,
    l: number,
  ): PromptTestSnapshot {
    return {
      ranAt: "2026-05-16T00:00:00Z",
      promptVersion: "v1",
      repos: {
        [repo]: {
          pages: h + m + l,
          confidence: { high: h, medium: m, low: l },
          retriedCount: 0,
          validatorWarnCounts: {},
          avgMainFlowWords: 0,
          avgBodyLineCount: 0,
        },
      },
    };
  }

  it("flags a regression at EXACTLY a 10-pp drop (closed boundary)", () => {
    // prior high% = 80, current high% = 70 -> deltaPP = -10 -> regression.
    // A regression to `>` (vs `>=`) would silently let this through.
    const prior = snap("petclinic", 80, 10, 10);
    const current = snap("petclinic", 70, 20, 10);
    const diff = diffSnapshots(prior, current);
    expect(diff.regressed).toBe(true);
    expect(diff.repos["petclinic"]?.confidenceHighPct?.regressed).toBe(true);
    expect(diff.repos["petclinic"]?.confidenceHighPct?.deltaPP).toBe(-10);
  });

  it("does NOT flag a regression at a 9-pp drop (just below threshold)", () => {
    // prior = 80%, current = 71% -> deltaPP = -9 -> pass.
    const prior = snap("petclinic", 80, 10, 10);
    const current = snap("petclinic", 71, 19, 10);
    const diff = diffSnapshots(prior, current);
    expect(diff.regressed).toBe(false);
    expect(diff.repos["petclinic"]?.confidenceHighPct?.regressed).toBe(false);
    expect(diff.repos["petclinic"]?.confidenceHighPct?.deltaPP).toBe(-9);
  });

  it("respects a custom threshold (lower bar trips at smaller drops)", () => {
    // 5-pp drop fires at threshold=5 but not at the default 10.
    const prior = snap("petclinic", 80, 10, 10);
    const current = snap("petclinic", 75, 15, 10);
    expect(diffSnapshots(prior, current, { threshold: 5 }).regressed).toBe(
      true,
    );
    expect(diffSnapshots(prior, current).regressed).toBe(false);
  });

  it("does NOT flag a regression on an INCREASE in high-share", () => {
    // prior = 70%, current = 80% (10-pp gain) -> not a regression even
    // though the absolute deltaPP magnitude equals the threshold.
    const prior = snap("petclinic", 70, 20, 10);
    const current = snap("petclinic", 80, 10, 10);
    const diff = diffSnapshots(prior, current);
    expect(diff.regressed).toBe(false);
    expect(diff.repos["petclinic"]?.confidenceHighPct?.deltaPP).toBe(10);
  });
});

describe("diffSnapshots field defaults and repo-set handling", () => {
  it("treats null prior or null current as 'all repos onlyIn current/prior'", () => {
    const current: PromptTestSnapshot = {
      ranAt: "2026-05-16T00:00:00Z",
      promptVersion: "v1",
      repos: {
        petclinic: {
          pages: 10,
          confidence: { high: 8, medium: 1, low: 1 },
          retriedCount: 0,
          validatorWarnCounts: {},
          avgMainFlowWords: 0,
          avgBodyLineCount: 0,
        },
      },
    };
    const diff = diffSnapshots(null, current);
    expect(diff.regressed).toBe(false);
    expect(diff.repos["petclinic"]?.onlyIn).toBe("current");
    // No baseline -> no confidence comparison to gate on.
    expect(diff.repos["petclinic"]?.confidenceHighPct).toBeUndefined();
  });

  it("marks repos absent from current as onlyIn:prior and skips the gate for them", () => {
    const prior: PromptTestSnapshot = {
      ranAt: "2026-05-15T00:00:00Z",
      promptVersion: "v0",
      repos: {
        petclinic: {
          pages: 10,
          confidence: { high: 10, medium: 0, low: 0 },
          retriedCount: 0,
          validatorWarnCounts: {},
          avgMainFlowWords: 0,
          avgBodyLineCount: 0,
        },
        contentbox: {
          pages: 5,
          confidence: { high: 4, medium: 1, low: 0 },
          retriedCount: 0,
          validatorWarnCounts: {},
          avgMainFlowWords: 0,
          avgBodyLineCount: 0,
        },
      },
    };
    const current: PromptTestSnapshot = {
      ranAt: "2026-05-16T00:00:00Z",
      promptVersion: "v1",
      repos: {
        petclinic: prior.repos["petclinic"]!,
      },
    };
    const diff = diffSnapshots(prior, current);
    // contentbox is only in prior, no gate fires for it.
    expect(diff.repos["contentbox"]?.onlyIn).toBe("prior");
    expect(diff.regressed).toBe(false);
  });

  it("defaults missing per-repo fields to 0 in the delta output (no NaN)", () => {
    // Hand-crafted minimal snapshots that omit retriedCount /
    // avgMainFlowWords / avgBodyLineCount. Mimics an older report
    // shape that the operator points --against to. The diff must
    // not crash or produce NaN deltas.
    const prior = {
      ranAt: "2026-05-15T00:00:00Z",
      promptVersion: "v0",
      repos: {
        petclinic: {
          pages: 1,
          confidence: { high: 1, medium: 0, low: 0 },
        },
      },
    } as unknown as PromptTestSnapshot;
    const current = {
      ranAt: "2026-05-16T00:00:00Z",
      promptVersion: "v1",
      repos: {
        petclinic: {
          pages: 1,
          confidence: { high: 1, medium: 0, low: 0 },
        },
      },
    } as unknown as PromptTestSnapshot;
    const diff = diffSnapshots(prior, current);
    expect(diff.regressed).toBe(false);
    expect(diff.repos["petclinic"]?.retriedCount).toEqual({
      prior: 0,
      current: 0,
      delta: 0,
    });
    expect(diff.repos["petclinic"]?.avgMainFlowWords?.delta).toBe(0);
    expect(diff.repos["petclinic"]?.avgBodyLineCount?.delta).toBe(0);
    expect(
      Number.isNaN(diff.repos["petclinic"]?.avgMainFlowWords?.delta),
    ).toBe(false);
  });

  it("reports validator-warn maps verbatim (no implicit merge or subtract)", () => {
    const prior: PromptTestSnapshot = {
      ranAt: "2026-05-15T00:00:00Z",
      promptVersion: "v0",
      repos: {
        petclinic: {
          pages: 5,
          confidence: { high: 5, medium: 0, low: 0 },
          retriedCount: 2,
          validatorWarnCounts: { trigger: 2, postconditions: 1 },
          avgMainFlowWords: 0,
          avgBodyLineCount: 0,
        },
      },
    };
    const current: PromptTestSnapshot = {
      ranAt: "2026-05-16T00:00:00Z",
      promptVersion: "v1",
      repos: {
        petclinic: {
          pages: 5,
          confidence: { high: 5, medium: 0, low: 0 },
          retriedCount: 1,
          validatorWarnCounts: { trigger: 1, tags: 3 },
          avgMainFlowWords: 0,
          avgBodyLineCount: 0,
        },
      },
    };
    const diff = diffSnapshots(prior, current);
    // Caller compares the maps; the diff just shows both verbatim.
    // Don't pre-aggregate (avoids losing per-field signal).
    expect(diff.repos["petclinic"]?.validatorWarns).toEqual({
      prior: { trigger: 2, postconditions: 1 },
      current: { trigger: 1, tags: 3 },
    });
  });

  it("returns deltaPP=0 and regressed=false when both sides have 0 pages (empty-repo guard)", () => {
    const empty: PromptTestSnapshot = {
      ranAt: "2026-05-16T00:00:00Z",
      promptVersion: "v1",
      repos: {
        petclinic: {
          pages: 0,
          confidence: { high: 0, medium: 0, low: 0 },
          retriedCount: 0,
          validatorWarnCounts: {},
          avgMainFlowWords: 0,
          avgBodyLineCount: 0,
        },
      },
    };
    const diff = diffSnapshots(empty, empty);
    expect(diff.regressed).toBe(false);
    expect(diff.repos["petclinic"]?.confidenceHighPct?.deltaPP).toBe(0);
  });
});
