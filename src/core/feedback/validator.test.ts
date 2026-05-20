import { describe, expect, it } from "vitest";
import {
  formatRetryHint,
  hasErrors,
  validateUseCaseDraft,
} from "./validator.js";

const GOOD = {
  summary:
    "A signed-in buyer submits a checkout form; the system validates payment and persists the order.",
  actor: "Authenticated buyer",
  trigger: "POST /checkout submitted from the cart page.",
  main_flow: [
    { step: "The buyer submits the cart form." },
    { step: "The system charges the buyer's saved card." },
    { step: "An order row is persisted with status='paid'." },
  ],
  postconditions: [
    "A new order row exists with status='paid'.",
    "The cart is cleared.",
  ],
};

describe("validateUseCaseDraft", () => {
  it("returns no issues for a fully-formed draft", () => {
    expect(validateUseCaseDraft(GOOD)).toEqual([]);
    expect(hasErrors(validateUseCaseDraft(GOOD))).toBe(false);
  });

  it("flags empty summary as an error", () => {
    const issues = validateUseCaseDraft({ ...GOOD, summary: "" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("summary");
    expect(issues[0]?.severity).toBe("error");
  });

  it("flags whitespace-only fields as empty (not just literal '')", () => {
    const issues = validateUseCaseDraft({ ...GOOD, summary: "   \n  " });
    expect(issues.find((i) => i.field === "summary")).toBeDefined();
  });

  it("flags single-step main_flow as an error", () => {
    const issues = validateUseCaseDraft({
      ...GOOD,
      main_flow: [{ step: "The system enters the function." }],
    });
    const flowIssue = issues.find((i) => i.field === "main_flow");
    expect(flowIssue?.severity).toBe("error");
    expect(flowIssue?.message).toMatch(/at least 2/);
  });

  it("flags an empty step inside an otherwise valid main_flow", () => {
    const issues = validateUseCaseDraft({
      ...GOOD,
      main_flow: [
        { step: "Step one." },
        { step: "" },
        { step: "Step three." },
      ],
    });
    const flowIssue = issues.find(
      (i) => i.field === "main_flow" && i.message.includes("empty"),
    );
    expect(flowIssue).toBeDefined();
    expect(flowIssue?.severity).toBe("error");
  });

  it("flags missing actor as an error and missing trigger as a warn", () => {
    const issues = validateUseCaseDraft({
      ...GOOD,
      actor: "",
      trigger: "",
    });
    expect(issues.find((i) => i.field === "actor")?.severity).toBe("error");
    expect(issues.find((i) => i.field === "trigger")?.severity).toBe("warn");
  });

  it("flags empty postconditions as a warn (not an error)", () => {
    const issues = validateUseCaseDraft({ ...GOOD, postconditions: [] });
    const post = issues.find((i) => i.field === "postconditions");
    expect(post?.severity).toBe("warn");
    // Warns alone don't trigger a retry.
    expect(hasErrors(issues)).toBe(false);
  });

  it("hasErrors only returns true when at least one error-severity issue is present", () => {
    expect(hasErrors([])).toBe(false);
    expect(
      hasErrors([{ field: "trigger", severity: "warn", message: "x" }]),
    ).toBe(false);
    expect(
      hasErrors([
        { field: "trigger", severity: "warn", message: "x" },
        { field: "summary", severity: "error", message: "y" },
      ]),
    ).toBe(true);
  });
});

describe("validateUseCaseDraft main_flow upper bound", () => {
  // Pins the warn-severity ceiling on main_flow length. Surfaced by the
  // 2026-05-16 Roller run + earlier petclinic-rest run: technically-
  // accurate but 11+ step flows past the BA's working-memory limit.
  // The check is warn-severity so it doesn't trigger a retry (would
  // cost a second LLM call for a quality concern, not a correctness
  // one), but lands in the audit-log retried-entry details when the
  // page also has an error-severity issue. Future signal for prompt
  // tuning.
  function mk(stepCount: number): typeof GOOD {
    const steps = Array.from({ length: stepCount }, (_, i) => ({
      step: `Step ${i + 1}.`,
    }));
    return { ...GOOD, main_flow: steps };
  }

  it("does NOT flag a 12-step flow at the default threshold (boundary held)", () => {
    const issues = validateUseCaseDraft(mk(12));
    expect(issues.find((i) => i.field === "main_flow")).toBeUndefined();
  });

  it("flags a 13-step flow as warn at the default threshold", () => {
    const issues = validateUseCaseDraft(mk(13));
    const flowIssue = issues.find((i) => i.field === "main_flow");
    expect(flowIssue?.severity).toBe("warn");
    expect(flowIssue?.message).toMatch(/13 steps/);
    expect(flowIssue?.message).toMatch(/<= 12/);
    // Critically: warn-severity does NOT make hasErrors true, so the
    // extractor will not fire a retry on this signal alone.
    expect(hasErrors(issues)).toBe(false);
  });

  it("respects the config override (lower threshold flags earlier)", () => {
    const issues = validateUseCaseDraft(mk(6), { maxMainFlowSteps: 5 });
    const flowIssue = issues.find((i) => i.field === "main_flow");
    expect(flowIssue?.severity).toBe("warn");
    expect(flowIssue?.message).toMatch(/<= 5/);
    // Symmetric: same draft, default threshold, no flag.
    expect(
      validateUseCaseDraft(mk(6)).find((i) => i.field === "main_flow"),
    ).toBeUndefined();
  });
});

describe("validateUseCaseDraft tag jargon blocklist", () => {
  // Pins the tag-content warn surfaced 2026-05-16 from a ColdBox run
  // that tagged a navigation page with `["ssl","ses","query-string",
  // "jsonb"]`. Warn-severity (no retry; one retry per page is reserved
  // for correctness, not stylistic concerns); the operator sees it in
  // the audit log's retried-entry details when the page ALSO has an
  // error-severity issue.
  it("emits no tag-warn for business-readable tags", () => {
    const issues = validateUseCaseDraft({
      ...GOOD,
      tags: ["navigation", "url-building", "modules"],
    });
    expect(issues.find((i) => i.field === "tags")).toBeUndefined();
  });

  it("warns when any tag appears in the default blocklist (case-insensitive)", () => {
    // ssl is lowercase in DEFAULT_TAG_JARGON_BLOCKLIST; the SSL/Ssl
    // variants pin the case-insensitive match. A regression to a
    // case-sensitive includes() would silently let an "SSL"-tagged
    // page through with no warn.
    for (const variant of ["ssl", "SSL", "Ssl"]) {
      const issues = validateUseCaseDraft({
        ...GOOD,
        tags: ["navigation", variant],
      });
      const tagIssue = issues.find((i) => i.field === "tags");
      expect(tagIssue?.severity).toBe("warn");
      expect(tagIssue?.message).toContain(variant);
    }
  });

  it("lists every offending tag in the warn message (not just the first)", () => {
    // Direct mirror of the real-world failure mode: the operator needs
    // to see ALL the jargon tags to decide whether to fix the prompt
    // or carve out an exception, not play whack-a-mole one rename at
    // a time.
    const issues = validateUseCaseDraft({
      ...GOOD,
      tags: ["navigation", "ssl", "ses", "query-string", "modules"],
    });
    const tagIssue = issues.find((i) => i.field === "tags");
    expect(tagIssue?.severity).toBe("warn");
    expect(tagIssue?.message).toContain("ssl");
    expect(tagIssue?.message).toContain("ses");
    expect(tagIssue?.message).toContain("query-string");
    // Non-offending tags must NOT appear in the message.
    expect(tagIssue?.message).not.toContain("navigation");
    expect(tagIssue?.message).not.toContain("modules");
  });

  it("respects an empty-array config override (security/networking app opts out)", () => {
    // A customer whose audience IS technical can suppress the warn
    // entirely via config.validator.tagJargonBlocklist=[]. Pin this
    // path so a regression hardcoding the default in the validator
    // body (instead of consuming options.tagJargonBlocklist) surfaces
    // here. Symmetric assertion: same draft, default blocklist, warn
    // fires.
    const draft = { ...GOOD, tags: ["ssl", "navigation"] };
    expect(
      validateUseCaseDraft(draft, { tagJargonBlocklist: [] }).find(
        (i) => i.field === "tags",
      ),
    ).toBeUndefined();
    expect(
      validateUseCaseDraft(draft).find((i) => i.field === "tags")?.severity,
    ).toBe("warn");
  });

  it("respects a custom blocklist (operator-supplied terms beyond the default)", () => {
    // Threading guard: the validator must consume options.tagJargonBlocklist,
    // not a hardcoded reference to the default. A custom term not in
    // the default list MUST fire when included by the operator.
    const issues = validateUseCaseDraft(
      { ...GOOD, tags: ["legacy-internal-api"] },
      { tagJargonBlocklist: ["legacy-internal-api"] },
    );
    const tagIssue = issues.find((i) => i.field === "tags");
    expect(tagIssue?.severity).toBe("warn");
    expect(tagIssue?.message).toContain("legacy-internal-api");
  });

  it("warn-only: a tag-jargon issue alone does NOT trigger retry (no false-positive LLM call)", () => {
    // Tag noise is a quality concern, not a correctness one. Spending
    // a second LLM call to re-roll tags would double the per-page
    // cost for a problem the operator can fix with a one-line prompt
    // tweak. Pin warn-only so a refactor accidentally bumping the
    // severity to "error" surfaces here.
    const issues = validateUseCaseDraft({
      ...GOOD,
      tags: ["ssl", "ses"],
    });
    expect(hasErrors(issues)).toBe(false);
  });
});

describe("formatRetryHint", () => {
  it("emits an empty string when there are no issues", () => {
    expect(formatRetryHint([])).toBe("");
  });

  it("includes only error-severity issues when any errors are present", () => {
    const hint = formatRetryHint([
      {
        field: "summary",
        severity: "error",
        message: "summary is empty.",
      },
      {
        field: "trigger",
        severity: "warn",
        message: "trigger is empty.",
      },
    ]);
    expect(hint).toContain("summary");
    expect(hint).not.toContain("trigger");
  });

  it("includes warn-only issues when there are no errors (so a fully-warns retry still gets context)", () => {
    const hint = formatRetryHint([
      {
        field: "trigger",
        severity: "warn",
        message: "trigger is empty.",
      },
    ]);
    expect(hint).toContain("trigger");
  });
});

// Coverage backfill flagged in 05ed278's needs-you (option c):
// validator.ts is consumed by the extractor's chain-of-correction loop
// (src/core/extractor.ts:105-133). The existing tests above cover the
// canonical issue-by-issue contracts but leave several load-bearing edges
// unpinned: the empty-draft case (when the LLM returns essentially nothing
// - happens on token-budget overruns and tool-use failures), the `?? []`
// fallback for undefined main_flow / postconditions arrays (a refactor
// inlining `draft.main_flow.length` would TypeError mid-extract for any
// LLM that emits an incomplete shape), hasContent's narrow-string contract
// against non-string values (a refactor to `Boolean(value)` would silently
// accept `0`, `false`, `[]`, `{}`), and the EXACT shape of formatRetryHint's
// output - the LLM-facing retry hint's preamble + bullet format is the
// only signal the model gets about what was wrong; a regression dropping
// the preamble or restructuring the bullets degrades retry recovery rate.
describe("validateUseCaseDraft edge cases", () => {
  // The all-empty draft is the worst-case LLM output we need to handle
  // gracefully (token-budget overrun, malformed tool-use response). Pin
  // both the issue COUNT and the ORDER: extractor.ts:130 stores
  // `firstIssues` in the audit log's `retried.firstIssues`, and the
  // /dashboard/audit "Validator-flagged fields" surface tallies field
  // names in input order via jsonb_array_elements_text - a reorder would
  // shift which field appears in the top-N "flagged" rankings.
  it("returns 5 issues for an empty draft in declared field order", () => {
    const issues = validateUseCaseDraft({});
    expect(issues.map((i) => i.field)).toEqual([
      "summary",
      "actor",
      "trigger",
      "main_flow",
      "postconditions",
    ]);
    expect(issues.map((i) => i.severity)).toEqual([
      "error",
      "error",
      "warn",
      "error",
      "warn",
    ]);
    // Three errors trigger retry; two warns alone wouldn't.
    expect(hasErrors(issues)).toBe(true);
  });

  // `?? []` fallback on draft.main_flow at validator.ts:74. A regression
  // inlining `draft.main_flow.length` (or refactor switching to a non-
  // null-coalescing access) would TypeError mid-extract for any LLM that
  // emits an incomplete shape - extractor.ts wraps this in the same call
  // path as the chain-of-correction retry, so a crash here means the
  // entire run fails instead of producing a (degraded but renderable)
  // page. Two distinct missing-shape inputs both produce the same
  // "0 step(s)" message; pins both the fallback AND the message format.
  it("treats undefined main_flow as length 0 and reports '0 step(s)'", () => {
    const undef = validateUseCaseDraft({
      summary: "ok",
      actor: "ok",
      main_flow: undefined,
    });
    const emptyArr = validateUseCaseDraft({
      summary: "ok",
      actor: "ok",
      main_flow: [],
    });
    for (const issues of [undef, emptyArr]) {
      const flow = issues.find((i) => i.field === "main_flow");
      expect(flow?.severity).toBe("error");
      expect(flow?.message).toContain("0 step(s)");
    }
  });

  // Separate `?? []` fallback on draft.postconditions at validator.ts:91.
  // The warn-branch fallback is a different code path from the error-
  // branch one above, so a regression dropping it would surface
  // independently - pin separately. Defensive negative against treating
  // undefined as "no warn" (which would suppress the dashboard's
  // postconditions-flagged-as-empty signal entirely).
  it("treats undefined postconditions as empty and emits the warn", () => {
    const issues = validateUseCaseDraft({
      summary: "ok",
      actor: "ok",
      main_flow: [{ step: "a" }, { step: "b" }],
      postconditions: undefined,
    });
    const post = issues.find((i) => i.field === "postconditions");
    expect(post?.severity).toBe("warn");
    expect(post?.message).toMatch(/empty/);
  });

  // hasContent at validator.ts:126 narrows to `typeof value === "string"`.
  // A refactor to `Boolean(value)` would silently accept arrays / numbers
  // / null and skip the error, then the LLM's malformed draft would reach
  // the renderer with broken types. Pin three distinct non-string shapes
  // all firing the SAME summary-error path. (Using `as unknown as string`
  // to bypass the Partial<UseCase> declared types - this models what an
  // off-schema LLM tool-use response would actually be at runtime.)
  it("flags non-string summary values (number, null, array) as empty", () => {
    for (const bad of [42, null, ["not a string"]]) {
      const issues = validateUseCaseDraft({
        summary: bad as unknown as string,
        actor: "ok",
        main_flow: [{ step: "a" }, { step: "b" }],
      });
      const summary = issues.find((i) => i.field === "summary");
      expect(summary?.severity).toBe("error");
    }
  });

  // The inner flow predicate at validator.ts:82 is
  // `flow.some((s) => !hasContent(s.step))`. Two failure modes worth
  // pinning: (a) a step entry missing the `step` key entirely (s.step is
  // undefined → hasContent false → fires); (b) s.step as a non-string
  // (number) → hasContent's typeof guard catches it → fires. A regression
  // to `flow.some((s) => !s.step)` would PASS the number case (0 is the
  // only falsy number; positive numbers would silently render as step
  // text "5" with no warning).
  it("flags main_flow entries with missing or non-string step", () => {
    const missingKey = validateUseCaseDraft({
      summary: "ok",
      actor: "ok",
      main_flow: [{ step: "a" }, {} as { step: string }, { step: "c" }],
    });
    const nonString = validateUseCaseDraft({
      summary: "ok",
      actor: "ok",
      main_flow: [
        { step: "a" },
        { step: 5 as unknown as string },
        { step: "c" },
      ],
    });
    for (const issues of [missingKey, nonString]) {
      const flow = issues.find(
        (i) => i.field === "main_flow" && i.message.includes("empty"),
      );
      expect(flow?.severity).toBe("error");
    }
  });
});

describe("formatRetryHint output shape", () => {
  // The retry hint is the entire signal the LLM gets about what to fix
  // on retry - extractor.ts:108-113 passes it as `retryHint` to the
  // second llmFn call. Pin the preamble byte-for-byte (a regression
  // softening or restructuring it would shift recovery rate in a way
  // we'd never notice in tests but would surface as degraded
  // retried-entry recovered% on the dashboard). Pin the bullet format
  // `- ${field}: ${message}` (a switch to JSON or YAML would compile +
  // pass every other test but force the LLM to parse a different
  // structure). Pin no-trailing-whitespace (a refactor adding "\n" at
  // the end would render as a blank instruction line to the model).
  it("emits the canonical preamble + bullet format + no trailing whitespace", () => {
    const hint = formatRetryHint([
      { field: "summary", severity: "error", message: "msg-a" },
      { field: "main_flow", severity: "error", message: "msg-b" },
    ]);
    expect(hint).toBe(
      "Your previous output had structural problems. Fix these specifically and emit the corrected JSON:\n\n- summary: msg-a\n- main_flow: msg-b",
    );
  });
});
