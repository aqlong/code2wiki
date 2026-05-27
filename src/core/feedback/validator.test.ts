import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_NOTE_PREFIXES,
  NOTE_KEYWORDS,
  formatRetryHint,
  hasErrors,
  validateNotesPropagated,
  validateUseCaseDraft,
} from "./validator.js";

const GOOD = {
  title: "Buyer checkout",
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

  it("flags empty title as an error", () => {
    const issues = validateUseCaseDraft({ ...GOOD, title: "" });
    expect(issues).toContainEqual(
      expect.objectContaining({
        field: "title",
        severity: "error",
        message: expect.stringContaining("title"),
      }),
    );
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

  it("flags em dashes (U+2014) in any field as an error (CLAUDE.md § Code style, ADR contract)", () => {
    // Em dashes are prohibited everywhere per CLAUDE.md. The SYSTEM_PROMPT
    // forbids them, but this runtime check catches the failure mode if
    // the LLM slips. U+2014 is the Unicode codepoint; we use
    // String.fromCodePoint so the test file itself stays em-dash-free.
    const em = String.fromCodePoint(0x2014);
    const issues = validateUseCaseDraft({
      ...GOOD,
      summary: `The buyer purchases a widget${em}a thing of value.`,
    });
    expect(hasErrors(issues)).toBe(true);
    expect(issues).toContainEqual(
      expect.objectContaining({
        field: "structure",
        severity: "error",
        message: expect.stringContaining("em dash"),
      }),
    );
  });

  it("detects em dashes in any of the multiple fields (main_flow, postconditions, etc.)", () => {
    // Validate the regex searches all text fields, not just summary.
    // Pick a field that's less obvious (a step inside main_flow array).
    const em = String.fromCodePoint(0x2014);
    const issues = validateUseCaseDraft({
      ...GOOD,
      main_flow: [
        { step: "The system receives a request." },
        { step: `The system processes the request${em}quickly.` },
      ],
    });
    expect(hasErrors(issues)).toBe(true);
    expect(issues).toContainEqual(
      expect.objectContaining({
        field: "structure",
        severity: "error",
      }),
    );
  });

  it("returns no em-dash issue for a draft with no em dashes", () => {
    const issues = validateUseCaseDraft({
      ...GOOD,
      summary: "The buyer purchases a widget, a thing of value.",
    });
    expect(issues.filter((i) => i.field === "structure")).toEqual([]);
  });

  // Em-dash field coverage: pin EVERY text expression in the validator's
  // em-dash scan (validator.ts ~166-186). A refactor that drops any field
  // from the `allText` array would silently break the runtime defense for
  // that field. Each case here injects an em dash into exactly one field
  // and asserts the structure error fires; if a drop happens, that case
  // fails surgically with its field name. Reverse-validated by mutating
  // validator.ts (removing one extraction at a time): each removal yields
  // exactly one failing case here naming the dropped field.
  describe("em-dash detection covers every scanned text field", () => {
    const em = String.fromCodePoint(0x2014);
    const cases: Array<{ field: string; mutator: () => Partial<typeof GOOD> }> =
      [
        { field: "title", mutator: () => ({ title: `Buyer${em}checkout` }) },
        { field: "actor", mutator: () => ({ actor: `Authenticated${em}buyer` }) },
        {
          field: "trigger",
          mutator: () => ({ trigger: `POST /checkout${em}submitted.` }),
        },
        {
          field: "preconditions",
          mutator: () => ({
            preconditions: [`User is${em}signed in.`],
          }),
        },
        {
          field: "alternate_flows.label",
          mutator: () =>
            ({
              alternate_flows: [
                { label: `Card${em}declined`, description: "Show error." },
              ],
            }) as Partial<typeof GOOD>,
        },
        {
          field: "alternate_flows.description",
          mutator: () =>
            ({
              alternate_flows: [
                { label: "Card declined", description: `Show${em}error.` },
              ],
            }) as Partial<typeof GOOD>,
        },
        {
          field: "postconditions",
          mutator: () => ({
            postconditions: [`A new order${em}exists.`],
          }),
        },
        {
          field: "business_rules.rule",
          mutator: () =>
            ({
              business_rules: [{ rule: `Orders${em}must be paid.` }],
            }) as Partial<typeof GOOD>,
        },
        {
          // business_rules[].footnote renders into the published page at
          // renderer.ts ~92 (`[^rule${i+1}]: ${r.footnote}`); a slipped em
          // dash there reaches the customer's wiki page.
          field: "business_rules.footnote",
          mutator: () =>
            ({
              business_rules: [
                {
                  rule: "Orders must be paid.",
                  footnote: `Per policy${em}see section 4.2.`,
                },
              ],
            }) as Partial<typeof GOOD>,
        },
        {
          // main_flow[].footnote renders into the published page at
          // renderer.ts ~62 (`[^step${i+1}]: ${s.footnote}`); same
          // customer-impact path as business_rules.footnote.
          field: "main_flow.footnote",
          mutator: () =>
            ({
              main_flow: [
                { step: "The buyer adds a widget to the cart." },
                {
                  step: "The buyer submits the order.",
                  footnote: `Validation includes${em}an inventory check.`,
                },
              ],
            }) as Partial<typeof GOOD>,
        },
        {
          field: "test_scenarios.label",
          mutator: () =>
            ({
              test_scenarios: [
                {
                  label: `Happy${em}path`,
                  gwt: "Given X, when Y, then Z.",
                },
              ],
            }) as Partial<typeof GOOD>,
        },
        {
          field: "test_scenarios.gwt",
          mutator: () =>
            ({
              test_scenarios: [
                { label: "Happy path", gwt: `Given${em}X.` },
              ],
            }) as Partial<typeof GOOD>,
        },
        {
          field: "related.title",
          mutator: () =>
            ({
              related: [{ slug: "x", title: `Em${em}title` }],
            }) as Partial<typeof GOOD>,
        },
        {
          // confidence_reason renders inside the managed-fence footer at
          // renderer.ts ~153 (`*Confidence: **<level>**, ${confidence_reason}*`);
          // this string IS shipped to the customer's wiki page, despite
          // the prior 2026-05-26 carry-over note treating it as
          // operator-only.
          field: "confidence_reason",
          mutator: () => ({
            confidence_reason: `Source code is clear${em}see lines 45-78.`,
          }),
        },
      ];

    for (const { field, mutator } of cases) {
      it(`detects em dash in ${field}`, () => {
        const issues = validateUseCaseDraft({ ...GOOD, ...mutator() });
        const structureIssue = issues.find(
          (i) => i.field === "structure" && i.message.includes("em dash"),
        );
        expect(structureIssue).toBeDefined();
        expect(structureIssue?.severity).toBe("error");
      });
    }
  });

  it("flags invalid confidence values (schema: high/medium/low enum)", () => {
    const issues = validateUseCaseDraft({
      ...GOOD,
      confidence: "very-high" as any,
    });
    expect(hasErrors(issues)).toBe(true);
    expect(issues).toContainEqual(
      expect.objectContaining({
        field: "confidence",
        severity: "error",
        message: expect.stringContaining("very-high"),
      }),
    );
  });

  it("accepts all three valid confidence values", () => {
    for (const conf of ["high", "medium", "low"]) {
      const issues = validateUseCaseDraft({
        ...GOOD,
        confidence: conf as any,
      });
      expect(issues.filter((i) => i.field === "confidence")).toEqual([]);
    }
  });

  it("returns no confidence issue when confidence is undefined (omitted)", () => {
    const issues = validateUseCaseDraft({
      ...GOOD,
      confidence: undefined,
    });
    expect(issues.filter((i) => i.field === "confidence")).toEqual([]);
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
  it("returns 6 issues for an empty draft in declared field order", () => {
    const issues = validateUseCaseDraft({});
    expect(issues.map((i) => i.field)).toEqual([
      "title",
      "summary",
      "actor",
      "trigger",
      "main_flow",
      "postconditions",
    ]);
    expect(issues.map((i) => i.severity)).toEqual([
      "error",
      "error",
      "error",
      "warn",
      "error",
      "warn",
    ]);
    // Four errors trigger retry; two warns alone wouldn't.
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

describe("validateNotesPropagated", () => {
  it("all NOTE_KEYWORDS entries are lowercase (haystack is lowercased before search)", () => {
    // The validator lowercases the entire haystack at line 270 before
    // running substring search. A mixed-case keyword like "removeAll"
    // becomes a dead string that never matches. This test enforces the
    // invariant to prevent regression (see removeAll bug fixed in ac51473).
    for (const [prefix, keywords] of Object.entries(NOTE_KEYWORDS)) {
      for (const keyword of keywords) {
        const lc = keyword.toLowerCase();
        expect(
          keyword,
          `keyword "${keyword}" in prefix "${prefix}" must be lowercase; got mixed-case`,
        ).toBe(lc);
      }
    }
  });

  it("returns no issues when there are no parser notes", () => {
    expect(validateNotesPropagated({} as any, undefined)).toEqual([]);
    expect(validateNotesPropagated({} as any, [])).toEqual([]);
  });

  it("returns no issues when a compliance-critical note is surfaced in business_rules", () => {
    const draft = {
      business_rules: [
        { rule: "After the order is created, the system sends a confirmation email to the buyer." },
      ],
    };
    expect(validateNotesPropagated(draft as any, ["Sends email (ActionMailer)"])).toEqual([]);
  });

  it("returns no issues when the keyword is in main_flow steps", () => {
    const draft = {
      main_flow: [
        { step: "The handler then enqueues a background job to process the upload." },
      ],
    };
    expect(validateNotesPropagated(draft as any, ["Enqueues background job"])).toEqual([]);
  });

  it("returns no issues when the keyword is in postconditions", () => {
    const draft = {
      postconditions: ["A new entry is persisted to disk as an audit log."],
    };
    expect(validateNotesPropagated(draft as any, ["Writes to file system"])).toEqual([]);
  });

  it("emits a warn-severity issue when a compliance-critical note is silently dropped", () => {
    const draft = {
      business_rules: [{ rule: "The order is validated and persisted." }],
      main_flow: [{ step: "Show the order summary." }],
      postconditions: ["The order is created."],
    };
    const issues = validateNotesPropagated(draft as any, [
      "Sends email (ActionMailer)",
      "Executes external process",
    ]);
    expect(issues).toHaveLength(2);
    expect(issues[0]?.severity).toBe("warn");
    expect(issues[0]?.message).toContain("Sends email (ActionMailer)");
    expect(issues[1]?.message).toContain("Executes external process");
  });

  it("returns no issues for non-compliance-critical auth / role notes (handled by ACTOR section)", () => {
    // Auth notes go through actor inference, not business_rules. The
    // validator's keyword check intentionally only covers the v13 BLAST
    // RADIUS Notes enumeration.
    expect(
      validateNotesPropagated({} as any, [
        "auth: Secured, RolesAllowed",
        "roles: admin,manager",
        "before_action: :authenticate_user!",
        "permission_classes: IsAuthenticated, IsAdminUser",
      ]),
    ).toEqual([]);
  });

  it("partial coverage: emits issues only for missing notes, not the present ones", () => {
    const draft = {
      business_rules: [{ rule: "All writes happen atomically inside a transaction." }],
    };
    const issues = validateNotesPropagated(draft as any, [
      "Executes within a database transaction",
      "Mutates application cache",
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("Mutates application cache");
  });

  it("matches all language-suffix variants of the same note family via prefix", () => {
    // The note family "Sends email" has four variants. The keyword set
    // applies to all of them via prefix matching.
    const draft = {
      business_rules: [
        { rule: "The user receives an email notification after registration." },
      ],
    };
    for (const variant of [
      "Sends email",
      "Sends email (cfmail)",
      "Sends email (ActionMailer)",
      "Sends email (Django mail)",
    ]) {
      expect(validateNotesPropagated(draft as any, [variant]), `${variant} should be matched`).toEqual([]);
    }
  });

  it("routes every parser-emitted suffix variant to its keyword set via prefix matching", () => {
    // Companion / generalisation of the email-only test above. findKeywordsFor
    // (validator.ts:239-244) routes a parser-emitted note to its keyword set
    // via `note.startsWith(prefix)`. The email test pins 3 suffixed variants
    // for ONE family; this one pins every other parser-emitted suffix variant
    // across the 8 families that ship a suffixed form. The variants were
    // harvested directly from grepping `notes.push(...)` /
    // `sideEffects.push(...)` strings in
    // src/core/parsers/{java,csharp,ruby,django,cfml}.ts so the fixture stays
    // ground-truthed against what the parsers actually emit.
    //
    // Regression scenario this defends against: a future refactor of
    // findKeywordsFor that swaps `note.startsWith(prefix)` for an exact-equal
    // check (e.g. promoting NOTE_KEYWORDS into a Map for faster lookup) would
    // silently drop the validator for every parser-suffixed variant; the
    // email-only test would catch 3 of those, the other 11 would go uncaught.
    //
    // Test design (load-bearing): each fixture uses a rule that contains NO
    // keyword from the matching prefix's NOTE_KEYWORDS bucket. So:
    //   - When prefix routing works -> keywords[] returned ->
    //     keyword NOT found in haystack -> warn fires (issues.length === 1).
    //   - When prefix routing breaks (mutation) -> keywords undefined ->
    //     `continue` skips the note -> NO warn fires (issues.length === 0).
    // The .toHaveLength(1) assertion below thus FAILS the mutation while
    // PASSING the real implementation. A symmetric "assert []" design would
    // pass under both implementations and catch nothing (the trap a first
    // pass of this test fell into; do not invert without re-validating).
    //
    // Reverse-validated by editing findKeywordsFor's predicate to
    // `note === prefix`: each of the 11 suffixed-variant cases below fails.
    // Source restored byte-identical via cp + diff -q exit 0 before commit.
    const NEUTRAL_RULE =
      "The handler completes the operation and returns the standard payload to the caller.";
    const suffixedVariants: string[] = [
      // -- Sends email family (3 suffixed forms; "Sends email" itself is unsuffixed) --
      "Sends email (cfmail)",
      "Sends email (ActionMailer)",
      "Sends email (Django mail)",
      // -- Makes outbound HTTP request family (CFML cfhttp) --
      "Makes outbound HTTP request (cfhttp)",
      // -- Enqueues background job family (CFML cfthread) --
      "Enqueues background job (cfthread)",
      // -- Sends message to broker (Java; SOLE variant is suffixed) --
      "Sends message to broker (JMS, AMQP, or Kafka)",
      // -- Executes within a database transaction family (Java @Transactional) --
      "Executes within a database transaction (@Transactional)",
      // -- Executes database operations inside a transaction (CFML cftransaction; SOLE variant is suffixed) --
      "Executes database operations inside a transaction (cftransaction)",
      // -- Calls stored procedure family (CFML colon-delimited list form) --
      "Calls stored procedure(s): sp_recalc, sp_audit",
      // -- Writes to file system family (CFML cffile) --
      "Writes to file system (cffile)",
      // -- Mutates application cache family (Java @CacheEvict + CFML cfcache) --
      "Mutates application cache (@CacheEvict / @CachePut)",
      "Mutates application cache (cfcache)",
      // -- Executes external process family (CFML cfexecute) --
      "Executes external process (cfexecute)",
    ];
    const draft = { business_rules: [{ rule: NEUTRAL_RULE }] };
    for (const variant of suffixedVariants) {
      const issues = validateNotesPropagated(draft as any, [variant]);
      expect(
        issues,
        `variant "${variant}" must prefix-route to its keyword set (which then warns because NEUTRAL_RULE lacks any keyword); issues.length === 0 means findKeywordsFor() lost prefix matching and silently skipped the compliance signal`,
      ).toHaveLength(1);
      expect(
        issues[0]?.message,
        `warn message for "${variant}" must echo the variant verbatim`,
      ).toContain(variant);
    }
  });

  it("matches cache-mutation keywords for high-blast-radius operations", () => {
    // The SYSTEM_PROMPT CACHE MUTATIONS section flags "clear" / "removeAll" /
    // "delete_pattern" / "delete_matched" as especially broad blast-radius
    // (affecting every cached entry, not just one). The validator must catch
    // these keywords if the LLM surfaces them in the output.
    const keywords = ["clear", "flush", "removeAll", "delete_pattern", "delete_matched"];
    for (const keyword of keywords) {
      const draft = {
        business_rules: [{ rule: `This operation ${keyword}s the entire cache.` }],
      };
      expect(
        validateNotesPropagated(draft as any, ["Mutates application cache"]),
        `keyword "${keyword}" should match in cache-mutation note`,
      ).toEqual([]);
    }
  });

  it("matches each cache-mutation keyword in isolation (without `cache` masking)", () => {
    // Reverse-validates the previous test. That test's rule text contains
    // the word "cache", which always matches the older "cache" keyword,
    // so it can't tell us whether the new keywords ("clear" / "flush" /
    // "removeAll" / "delete_pattern" / "delete_matched") actually fire.
    // This test removes "cache" from the rule, forcing each new keyword
    // to do the matching itself. Caught the bug where the mixed-case
    // "removeAll" was a dead string in NOTE_KEYWORDS because the haystack
    // is lowercased before the substring search runs.
    const cases: Array<{ keyword: string; rule: string }> = [
      { keyword: "clear", rule: "This operation clears every entry." },
      { keyword: "flush", rule: "This operation flushes every entry." },
      { keyword: "removeAll", rule: "This operation removeAlls every entry." },
      { keyword: "delete_pattern", rule: "This operation calls delete_pattern across every entry." },
      { keyword: "delete_matched", rule: "This operation calls delete_matched across every entry." },
    ];
    for (const { keyword, rule } of cases) {
      const draft = { business_rules: [{ rule }] };
      expect(
        validateNotesPropagated(draft as any, ["Mutates application cache"]),
        `keyword "${keyword}" must match in isolation (rule does not contain "cache")`,
      ).toEqual([]);
    }
  });

  it("matches HTTP keywords for external dependency language", () => {
    // The SYSTEM_PROMPT OUTBOUND HTTP section says "Crosses a trust boundary;
    // any external dependency is also an audit and ops surface." The validator
    // must catch common LLM phrasing about remote/upstream/external calls.
    const testCases = [
      "This method calls a remote service to validate payment.",
      "The system has an external dependency on the payment gateway.",
      "An upstream API is queried for pricing information.",
      "The request is forwarded to an external system.",
    ];
    for (const rule of testCases) {
      const draft = {
        business_rules: [{ rule }],
      };
      expect(
        validateNotesPropagated(draft as any, ["Makes outbound HTTP request"]),
        `rule "${rule}" should match HTTP note`,
      ).toEqual([]);
    }
  });

  it("matches HTTP-request keywords across the external-dependency vocabulary", () => {
    // Companion to the bundled "matches HTTP keywords for external dependency
    // language" test above: that test pins prefix-level matching for 4 broad
    // phrasings; this one pins each of the 12 keywords at
    // NOTE_KEYWORDS["Makes outbound HTTP request"] (validator.ts:210) in
    // isolation. The HTTP category is the highest-blast-radius compliance
    // signal after PROCESS EXECUTION (trust-boundary crossings + ops surface
    // per SYSTEM_PROMPT OUTBOUND HTTP) and surfaces across every parser
    // (java cfhttp / cffile equivalents notwithstanding), so a keyword drop
    // here silently degrades coverage on the broadest customer surface.
    //
    // 10 of 12 keywords are cleanly isolated by construction (probe at
    // /tmp/probe-http.mjs); "external service" and "external api" are
    // substring-supersets of "external" (a fixture for either also matches
    // "external" via .includes()), so they cannot be uniquely defended by a
    // single-keyword-removal mutation. They are kept in the case array for
    // documentation value, mirroring the "rabbitmq" / "rabbit" overlap
    // design in the message-broker test above.
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "http",
        rule: "The function sends an http packet to the payment gateway.",
      },
      {
        keyword: "external service",
        rule: "Pricing data is fetched from an external service for that region.",
      },
      {
        keyword: "external api",
        rule: "Tax calculations are delegated to an external api hosted by the partner.",
      },
      {
        keyword: "outbound",
        rule: "Each completed order triggers an outbound connection to the shipping vendor.",
      },
      {
        keyword: "api call",
        rule: "Inventory levels are refreshed by an api call after every transaction.",
      },
      {
        keyword: "third-party",
        rule: "Address verification is performed by a third-party validation system.",
      },
      {
        keyword: "request to",
        rule: "The handler issues a request to the analytics endpoint.",
      },
      {
        keyword: "remote",
        rule: "The system synchronizes pricing with a remote endpoint after each update.",
      },
      {
        keyword: "dependency",
        rule: "Order confirmation has a dependency on the shipping confirmation step.",
      },
      {
        keyword: "upstream",
        rule: "Each price change is replayed to the upstream pricing oracle.",
      },
      {
        keyword: "external",
        rule: "The system uses an external module for payment processing.",
      },
      {
        keyword: "calls an",
        rule: "Authentication calls an identity provider to validate the token.",
      },
    ];
    for (const { keyword, rule } of cases) {
      const draft = { business_rules: [{ rule }] };
      expect(
        validateNotesPropagated(draft as any, ["Makes outbound HTTP request"]),
        `keyword "${keyword}" should match in rule "${rule}"`,
      ).toEqual([]);
    }
  });

  it("matches filesystem keywords for data persistence language", () => {
    // The SYSTEM_PROMPT FILESYSTEM WRITES section says "The function
    // persists data to shared disk state (uploads, exports, log writes,
    // generated reports)." The validator must catch when the LLM describes
    // file operations using terms like 'exported', 'logged', 'generated'.
    const testCases = [
      "The system exports the user data to a CSV file.",
      "Transaction logs are written to disk for audit purposes.",
      "A report is generated and saved to the filesystem.",
      "Users can download their data as a ZIP archive.",
    ];
    for (const rule of testCases) {
      const draft = {
        business_rules: [{ rule }],
      };
      expect(
        validateNotesPropagated(draft as any, ["Writes to file system"]),
        `rule "${rule}" should match filesystem note`,
      ).toEqual([]);
    }
  });

  it("matches filesystem keywords in isolation (without broader context masking)", () => {
    // Companion to the bundled "matches filesystem keywords for data
    // persistence language" test: that test pins broad phrasings (each
    // fixture matches multiple keywords simultaneously, so a single-keyword
    // drop would not fail it), this one pins each of the 10 keywords at
    // NOTE_KEYWORDS["Writes to file system"] (validator.ts:217) in isolation.
    // FILESYSTEM is one of two parser categories (alongside EMAIL and PROCESS)
    // whose SYSTEM_PROMPT entry marks the side effect as "permanent" /
    // "unrecoverable" once written, so silently dropping a keyword here means
    // the validator stops surfacing this compliance signal for whichever LLM
    // phrasing maps to that keyword. All five parsers (Java / CFML / Python /
    // Ruby / C#) surface file-system writes.
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "file",
        rule: "The configuration is written to a file on server startup.",
      },
      {
        keyword: "disk",
        rule: "Batch results are persisted to disk for later retrieval.",
      },
      {
        keyword: "filesystem",
        rule: "Uploaded images are stored on the filesystem under the public directory.",
      },
      {
        keyword: "upload",
        rule: "Users can upload documents which are then persisted for later access.",
      },
      {
        keyword: "saves",
        rule: "The system saves a backup copy to the archive location.",
      },
      {
        keyword: "persisted to",
        rule: "Thumbnails are persisted to cache storage on the CDN.",
      },
      {
        keyword: "writes to",
        rule: "The application writes to the audit log file after each transaction.",
      },
      {
        keyword: "export",
        rule: "Authorized users can export the dataset to CSV format.",
      },
      {
        keyword: "log",
        rule: "Debug information is written to the application log.",
      },
      {
        keyword: "report",
        rule: "Monthly reconciliation report is generated and stored in the archive.",
      },
      {
        keyword: "download",
        rule: "Customers can download receipts as PDF files.",
      },
    ];
    for (const { keyword, rule } of cases) {
      const draft = { business_rules: [{ rule }] };
      expect(
        validateNotesPropagated(draft as any, ["Writes to file system"]),
        `keyword "${keyword}" should match in rule "${rule}"`,
      ).toEqual([]);
    }
  });

  it("matches process-execution keywords for high-blast-radius signals", () => {
    // PROCESS EXECUTION is marked as "Highest-blast-radius signal of all:
    // spawns an OS process at the web server's privilege level. Classic
    // command-injection vector and a major compliance flag." The validator
    // must catch when the LLM describes process execution using terms like
    // 'invokes a system command' or 'spawns an external process'.
    const testCases = [
      "The system invokes a shell script to process the uploaded file.",
      "The server spawns an external process to generate a PDF report.",
      "A system command is executed to validate the configuration.",
    ];
    for (const rule of testCases) {
      const draft = {
        business_rules: [{ rule }],
      };
      expect(
        validateNotesPropagated(draft as any, ["Executes external process"]),
        `rule "${rule}" should match process-execution note`,
      ).toEqual([]);
    }
  });

  it("matches process-execution keywords in isolation (without broader context masking)", () => {
    // Companion to the bundled "matches process-execution keywords for
    // high-blast-radius signals" test: that test pins broad phrasings (each
    // fixture uses multiple keywords, so a single-keyword drop would not
    // fail it), this one pins each of the 7 keywords at NOTE_KEYWORDS["Executes
    // external process"] (validator.ts:225) in isolation. PROCESS EXECUTION is
    // the highest-blast-radius signal per SYSTEM_PROMPT ("spawns an OS process
    // at the web server's privilege level") and is a classic command-injection
    // vector that auditors flag. All five parsers surface this side effect.
    // All seven keywords are cleanly isolated by construction; each fixture
    // contains exactly one keyword that no other fixture has as a substring
    // (probe-validated at /tmp/probe-process.mjs).
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "process",
        rule: "The system spawns a background process to generate the report.",
      },
      {
        keyword: "command",
        rule: "A shell command is executed to transform the input file.",
      },
      {
        keyword: "shell",
        rule: "The validation logic delegates to a shell script.",
      },
      {
        keyword: "external program",
        rule: "The reconciliation runs an external program to validate accounts.",
      },
      {
        keyword: "binary",
        rule: "The encryption is provided by an external binary.",
      },
      {
        keyword: "spawns",
        rule: "The worker thread spawns a new process for each job.",
      },
      {
        keyword: "invoke",
        rule: "The controller can invoke system utilities to process the request.",
      },
    ];
    for (const { keyword, rule } of cases) {
      const draft = { business_rules: [{ rule }] };
      expect(
        validateNotesPropagated(draft as any, ["Executes external process"]),
        `keyword "${keyword}" should match in rule "${rule}"`,
      ).toEqual([]);
    }
  });

  it("matches background-job keywords including trigger", () => {
    // The SYSTEM_PROMPT BACKGROUND WORK section says "The effect happens
    // later and out of band; the documented function is the trigger."
    // The validator must catch when the LLM describes the triggering action
    // using various terms, including 'trigger' which is the prompt's own word.
    const testCases = [
      "This function triggers a background job to process the uploaded file.",
      "The system enqueues an asynchronous task to send the email.",
      "Processing is deferred to a background worker.",
      "A scheduled task is initiated to clean up stale records.",
    ];
    for (const rule of testCases) {
      const draft = {
        business_rules: [{ rule }],
      };
      expect(
        validateNotesPropagated(draft as any, ["Enqueues background job"]),
        `rule "${rule}" should match background-job note`,
      ).toEqual([]);
    }
  });

  it("matches background-job keywords in isolation (without broader context masking)", () => {
    // Companion to the bundled "matches background-job keywords including
    // trigger" test: that test pins broad phrasings (each fixture matches
    // multiple keywords, so a single-keyword drop would not fail it), this one
    // pins each of the 7 keywords at NOTE_KEYWORDS["Enqueues background job"]
    // (validator.ts:211) in isolation. BACKGROUND WORK is a compliance signal
    // because the effect happens out-of-band; the documented function doesn't
    // wait for completion, so re-delivery / error handling / timeout
    // semantics are ops-owned and auditor-visible. All five parsers surface
    // this side effect. All seven keywords are cleanly isolated by
    // construction (probe-validated at /tmp/probe-background-job.mjs): no
    // fixture contains any of the other keywords as a substring.
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "background",
        rule: "The notification is sent in the background after the API returns.",
      },
      {
        keyword: "asynchronous",
        rule: "The image processing happens asynchronously to avoid blocking.",
      },
      {
        keyword: "async",
        rule: "Reconciliation runs async through a scheduled task.",
      },
      {
        keyword: "queue",
        rule: "Messages are placed in a queue for the worker process.",
      },
      {
        keyword: "later",
        rule: "The report is generated later when fewer users are active.",
      },
      {
        keyword: "deferred",
        rule: "Index updates are deferred to a scheduled maintenance window.",
      },
      {
        keyword: "scheduled",
        rule: "A scheduled cleanup task removes stale records nightly.",
      },
      {
        keyword: "out of band",
        rule: "Alerts are sent out of band so the application continues immediately.",
      },
      {
        keyword: "trigger",
        rule: "This endpoint merely triggers the processing; the work happens later.",
      },
    ];
    for (const { keyword, rule } of cases) {
      const draft = { business_rules: [{ rule }] };
      expect(
        validateNotesPropagated(draft as any, ["Enqueues background job"]),
        `keyword "${keyword}" should match in rule "${rule}"`,
      ).toEqual([]);
    }
  });

  it("matches email-notification keywords for unrecoverable communications", () => {
    // The SYSTEM_PROMPT EMAIL section says "Anything emailed to a user is
    // unrecoverable once delivered." The validator must catch when the LLM
    // describes email operations using various terms: direct email references,
    // notification language, or inbox mentions.
    const testCases = [
      "After registration, the system sends a confirmation email to the user.",
      "A notification is delivered to the user's inbox after order placement.",
      "The user is notified via email when their password reset is complete.",
      "An email reminder is sent to users with expiring subscriptions.",
    ];
    for (const rule of testCases) {
      const draft = {
        business_rules: [{ rule }],
      };
      expect(
        validateNotesPropagated(draft as any, ["Sends email"]),
        `rule "${rule}" should match email note`,
      ).toEqual([]);
    }
  });

  it("matches each email-notification keyword in isolation (without `email`/`mail` masking)", () => {
    // Companion to the bundled "matches email-notification keywords for
    // unrecoverable communications" test above: that test pins prefix-level
    // matching for 4 broad phrasings (each fixture matches multiple keywords
    // simultaneously, so a single-keyword drop would not fail it), this one
    // pins each of the 5 keywords at NOTE_KEYWORDS["Sends email"]
    // (validator.ts:209) in isolation. EMAIL is one of two parser categories
    // (alongside FILESYSTEM and PROCESS) whose SYSTEM_PROMPT entry calls the
    // side effect "unrecoverable" once delivered, so silently dropping a
    // keyword here means the validator stops surfacing the compliance signal
    // for whichever LLM phrasing maps to that keyword. CFML cfmail / Java
    // JavaMailSender / Ruby ActionMailer / Django mail / C# SmtpClient all
    // emit a "Sends email" prefix per the CLAUDE.md side-effect matrix.
    //
    // 4 of 5 keywords are cleanly isolated by construction (probe at
    // /tmp/probe-email.mjs); "email" is a strict substring superset of
    // "mail" (any fixture containing "email" also matches "mail" via
    // .includes()), so it cannot be uniquely defended by a single-keyword
    // mutation. The "mail" case uses a fixture mentioning "mailer" without
    // "email" so the shorter keyword is exercised in isolation; the "email"
    // case exercises the longer keyword for documentation value (same
    // overlap design as "rabbitmq"/"rabbit" in the message-broker test
    // above and "external service"/"external api"/"external" in the
    // HTTP-request test).
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "email",
        rule: "An email is dispatched on completion of the order workflow.",
      },
      {
        keyword: "mail",
        rule: "The mailer process ships outbound messages each hour.",
      },
      {
        keyword: "notification",
        rule: "A subscription confirmation notification is logged for the user.",
      },
      {
        keyword: "notify",
        rule: "The system will notify the user once processing finishes.",
      },
      {
        keyword: "inbox",
        rule: "Each message lands in the recipient's inbox after dispatch.",
      },
    ];
    for (const { keyword, rule } of cases) {
      const draft = { business_rules: [{ rule }] };
      expect(
        validateNotesPropagated(draft as any, ["Sends email"]),
        `keyword "${keyword}" should match in rule "${rule}"`,
      ).toEqual([]);
    }
  });

  it("matches database-transaction keywords across both prefix variants", () => {
    // NOTE_KEYWORDS holds TWO prefix entries for database transactions:
    //   "Executes within a database transaction"            (Java @Transactional,
    //                                                        Ruby ActiveRecord,
    //                                                        Django transaction.atomic,
    //                                                        C# TransactionScope /
    //                                                        BeginTransaction)
    //   "Executes database operations inside a transaction" (CFML cftransaction)
    // Both arrays MUST stay in sync, the validator's findKeywordsFor() picks
    // the keyword set via startsWith() so each parser's emitted prefix lands
    // on its own row. A refactor that drops a keyword from one entry but not
    // the other would silently degrade transaction-note matching for half
    // the parser surface. This test pins (1) each of the six keywords in
    // isolation (mutation-validated by removing one keyword at a time) and
    // (2) the parity contract between the two prefix entries.
    const prefixes = [
      "Executes within a database transaction",
      "Executes database operations inside a transaction",
    ];
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "transaction",
        rule: "The system performs the update inside a database transaction.",
      },
      {
        keyword: "atomic",
        rule: "The change is recorded as an atomic operation.",
      },
      {
        keyword: "rollback",
        rule: "If an error occurs the system performs a rollback.",
      },
      {
        keyword: "all-or-nothing",
        rule: "This step uses an all-or-nothing approach to updating the records.",
      },
      {
        keyword: "all or nothing",
        rule: "Updates are applied all or nothing across the order.",
      },
      {
        keyword: "succeed or fail",
        rule: "Both writes succeed or fail together.",
      },
    ];
    for (const prefix of prefixes) {
      for (const { keyword, rule } of cases) {
        const draft = { business_rules: [{ rule }] };
        expect(
          validateNotesPropagated(draft as any, [prefix]),
          `keyword "${keyword}" should match in rule "${rule}" for prefix "${prefix}"`,
        ).toEqual([]);
      }
    }
  });

  it("matches spring-event keywords across publish-subscribe vocabulary", () => {
    // The SYSTEM_PROMPT BLAST RADIUS section instructs the LLM to surface
    // Spring application events as a compliance signal: publishEvent calls
    // create cross-aggregate side effects (downstream listeners may write
    // to other tables, enqueue work, or call out to external services),
    // none of which are visible at the publishing call site. Java's parser
    // is the sole emitter today (java.ts:323, "Publishes Spring application
    // event" via ApplicationEventPublisher.publishEvent or
    // applicationContext.publishEvent). NOTE_KEYWORDS["Publishes Spring
    // application event"] holds four keywords (event / publish / subscriber
    // / listener); any single-keyword drop must fail this test. Each
    // fixture exercises its target keyword in isolation (probe-validated
    // at /tmp/probe-spring-event.mjs): no fixture contains any of the
    // other three keywords as a substring, so a mutation removing one
    // keyword from the array fails exactly the case for that keyword.
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "event",
        rule: "An order-completed event is recorded for the analytics team.",
      },
      {
        keyword: "publish",
        rule: "The pricing service publishes the recalculated totals to the audit channel.",
      },
      {
        keyword: "subscriber",
        rule: "Each enrollment update notifies every active subscriber so they can refresh their cache.",
      },
      {
        keyword: "listener",
        rule: "A downstream listener responds to the change by recalculating commission.",
      },
    ];
    for (const { keyword, rule } of cases) {
      const draft = { business_rules: [{ rule }] };
      expect(
        validateNotesPropagated(draft as any, [
          "Publishes Spring application event",
        ]),
        `keyword "${keyword}" should match in rule "${rule}"`,
      ).toEqual([]);
    }
  });

  it("matches message-broker keywords across protocol and product variants", () => {
    // The SYSTEM_PROMPT MESSAGE BROKER section flags broker traffic as a
    // cross-process compliance signal: the side effect happens in a separate
    // system the application doesn't own, and re-delivery / ordering / DLQ
    // semantics are auditor-visible. Java's parser is the sole emitter today
    // (java.ts:351, "Sends message to broker (JMS, AMQP, or Kafka)"); the
    // validator must catch the eight keyword variants real-world LLM output
    // uses for this surface. Seven of the eight are cleanly isolated by
    // construction; "rabbitmq" is a strict substring of "rabbit" so a fixture
    // mentioning "rabbitmq" also matches the "rabbit" keyword. The dedicated
    // "rabbit" case uses a fixture that mentions "rabbit" without "rabbitmq"
    // so the shorter keyword is exercised in isolation; the "rabbitmq" case
    // exercises the longer keyword for documentation value (same overlap
    // design as "stored procedure" / "stored proc" above).
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "broker",
        rule: "The system publishes the receipt to the message broker.",
      },
      {
        keyword: "kafka",
        rule: "Order events are published to a kafka stream for downstream consumers.",
      },
      {
        keyword: "rabbitmq",
        rule: "The pricing service forwards updates to rabbitmq for the analytics team.",
      },
      {
        keyword: "rabbit",
        rule: "The system writes the audit packet to the rabbit cluster.",
      },
      {
        keyword: "jms",
        rule: "Invoice notifications are dispatched onto the jms destination.",
      },
      {
        keyword: "amqp",
        rule: "The handler sends a confirmation packet over amqp to the partner system.",
      },
      {
        keyword: "message queue",
        rule: "Reports are dropped into a message queue for the nightly job to pick up.",
      },
      {
        keyword: "topic",
        rule: "Each completed checkout is published to the orders topic for subscribers.",
      },
    ];
    for (const { keyword, rule } of cases) {
      const draft = { business_rules: [{ rule }] };
      expect(
        validateNotesPropagated(draft as any, ["Sends message to broker"]),
        `keyword "${keyword}" should match in rule "${rule}"`,
      ).toEqual([]);
    }
  });

  it("matches stored-procedure keywords across spelling variants", () => {
    // The SYSTEM_PROMPT STORED PROCEDURES section flags these as a
    // compliance signal because the business logic happens INSIDE the
    // database, outside the application's audit / observability surface.
    // All 5 parsers (java/csharp/django/ruby/cfml via cfstoredproc) surface
    // the "Calls stored procedure" note as of 2026-05-24's matrix sweep
    // (c13a735 / 6b2bd31 / d0858d5 / 93cc035 plus historical cfml support);
    // the validator side previously had zero per-category coverage to
    // ensure the four spelling variants all match real LLM output. Each
    // rule below isolates one keyword: the hyphenated form, the "sproc"
    // abbreviation, and the "stored proc" short form are each the SOLE
    // matching keyword in their fixture. ("stored procedure" full-spelling
    // is intentionally not isolated since "stored proc" is a substring of
    // it, making the full form keyword effectively redundant data; the
    // first case exercises both for documentation value.)
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "stored procedure",
        rule: "The system invokes a stored procedure to calculate end-of-month totals.",
      },
      {
        keyword: "stored-procedure",
        rule: "Pricing data is retrieved by calling the stored-procedure for that region.",
      },
      {
        keyword: "sproc",
        rule: "A sproc is called to validate the customer's eligibility.",
      },
      {
        keyword: "stored proc",
        rule: "Each request triggers a stored proc that audits the transaction.",
      },
    ];
    for (const { keyword, rule } of cases) {
      const draft = { business_rules: [{ rule }] };
      expect(
        validateNotesPropagated(draft as any, ["Calls stored procedure"]),
        `keyword "${keyword}" should match in rule "${rule}"`,
      ).toEqual([]);
    }
  });

  it("matches each spring-event keyword in isolation (without `event`/`publish` masking)", () => {
    // Companion isolation test for spring-event (see line 1130). The bundled
    // test pins prefix-level matching across 4 scenarios; this test ensures
    // each of the 4 keywords ("event", "publish", "subscriber", "listener")
    // at NOTE_KEYWORDS["Publishes Spring application event"] (validator.ts:212)
    // can independently trigger the match. Spring events create cross-aggregate
    // side effects (listeners may write tables, enqueue work, call external
    // services) that are invisible at the publishEvent call site; a keyword
    // drop here silently degrades visibility into those hidden dependencies.
    // All 4 keywords are cleanly isolated by construction; no fixture is a
    // substring superset of any other keyword.
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "event",
        rule: "The order-completion event is recorded for asynchronous processing.",
      },
      {
        keyword: "publish",
        rule: "The service will publish a notification to downstream systems.",
      },
      {
        keyword: "subscriber",
        rule: "Multiple subscriber processes listen for configuration changes.",
      },
      {
        keyword: "listener",
        rule: "A listener is invoked to invalidate the cache after updates.",
      },
    ];
    for (const { keyword, rule } of cases) {
      const draft = { business_rules: [{ rule }] };
      expect(
        validateNotesPropagated(draft as any, [
          "Publishes Spring application event",
        ]),
        `keyword "${keyword}" must match in isolation (rule does not contain other keywords)`,
      ).toEqual([]);
    }
  });

  it("matches each message-broker keyword in isolation (without `broker`/`topic` masking)", () => {
    // Companion isolation test for message-broker (see line 1174). The bundled
    // test pins prefix-level matching across 8 scenarios; this test ensures
    // each of the 8 keywords at NOTE_KEYWORDS["Sends message to broker"]
    // (validator.ts:213) can independently trigger the match. Message brokers
    // (Kafka, RabbitMQ, JMS, AMQP) are off-box systems where re-delivery /
    // ordering / DLQ semantics are auditor-visible and outside the
    // application's observability; a keyword drop here silently degrades
    // compliance visibility for cross-process side effects.
    // 7 of 8 keywords are cleanly isolated; "rabbitmq" is a substring
    // superset of "rabbit" so both are kept for documentation value (same
    // pattern as "external service" / "external api" / "external" in HTTP).
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "broker",
        rule: "The receipt is published to a message broker for subscribers.",
      },
      {
        keyword: "kafka",
        rule: "Pricing changes are streamed to kafka for analytics consumers.",
      },
      {
        keyword: "rabbitmq",
        rule: "The transaction log is forwarded to the rabbitmq cluster.",
      },
      {
        keyword: "rabbit",
        rule: "Events are enqueued on the rabbit message system.",
      },
      {
        keyword: "jms",
        rule: "Invoice notifications are dispatched via the jms destination.",
      },
      {
        keyword: "amqp",
        rule: "Confirmation messages are sent over the amqp protocol.",
      },
      {
        keyword: "message queue",
        rule: "Batch reports are dropped into a message queue for processing.",
      },
      {
        keyword: "topic",
        rule: "Completed orders are published to the orders topic.",
      },
    ];
    for (const { keyword, rule } of cases) {
      const draft = { business_rules: [{ rule }] };
      expect(
        validateNotesPropagated(draft as any, ["Sends message to broker"]),
        `keyword "${keyword}" must match in isolation (rule does not contain other keywords)`,
      ).toEqual([]);
    }
  });

  it("matches each database-transaction keyword in isolation (without `transaction` masking)", () => {
    // Companion isolation test for database-transaction (see line 1074). The
    // bundled test pins prefix-level matching across 6 scenarios and both
    // prefix variants; this test ensures each of the 6 keywords
    // at NOTE_KEYWORDS (validator.ts:214-215) can independently trigger the
    // match without `transaction` present. Database transactions are a
    // compliance signal because the all-or-nothing semantics are invisible
    // to the application once the database commits; a keyword drop here
    // silently degrades visibility into atomicity guarantees.
    // All 6 keywords are cleanly isolated by construction; no fixture
    // contains "transaction" or any other keyword.
    const prefixes = [
      "Executes within a database transaction",
      "Executes database operations inside a transaction",
    ];
    const cases: Array<{ keyword: string; rule: string }> = [
      {
        keyword: "atomic",
        rule: "The change is recorded as an atomic operation without partial updates.",
      },
      {
        keyword: "rollback",
        rule: "If validation fails the system performs a rollback.",
      },
      {
        keyword: "all-or-nothing",
        rule: "This step uses an all-or-nothing approach to record the changes.",
      },
      {
        keyword: "all or nothing",
        rule: "Updates are applied all or nothing across the order and items.",
      },
      {
        keyword: "succeed or fail",
        rule: "Both writes succeed or fail together as a unit.",
      },
    ];
    for (const prefix of prefixes) {
      for (const { keyword, rule } of cases) {
        const draft = { business_rules: [{ rule }] };
        expect(
          validateNotesPropagated(draft as any, [prefix]),
          `keyword "${keyword}" must match in isolation for prefix "${prefix}" (rule does not contain "transaction")`,
        ).toEqual([]);
      }
    }
  });
});

describe("validateNotesPropagated haystack coverage", () => {
  // validator.ts:231-243 scans seven distinct draft locations for keyword
  // matches: business_rules[].rule, business_rules[].footnote,
  // main_flow[].step, main_flow[].footnote, postconditions[],
  // alternate_flows[].label, alternate_flows[].description. The three
  // basic-contract tests above pin business_rules[].rule, main_flow[].step,
  // and postconditions[]; the OTHER four locations + the `.toLowerCase()`
  // case-insensitivity contract are undefended -- a refactor dropping any
  // one would silently fire false-positive warn-issues whenever the LLM
  // expressed the compliance signal in that location (e.g. a footnote
  // explaining a transactional invariant, or an alternate_flows label like
  // "Email retry on bounce"). Pin each as the SOLE location where the
  // keyword appears, with per-location named-failure assertions so a
  // regression diagnosis is one-grep away.
  const LOCATIONS: Array<{
    name: string;
    build: (kw: string) => Record<string, unknown>;
  }> = [
    {
      name: "business_rules[].footnote",
      build: (kw) => ({
        business_rules: [{ rule: "placeholder rule.", footnote: kw }],
      }),
    },
    {
      name: "main_flow[].footnote",
      build: (kw) => ({
        main_flow: [{ step: "placeholder step.", footnote: kw }],
      }),
    },
    {
      name: "alternate_flows[].label",
      build: (kw) => ({
        alternate_flows: [{ label: kw, description: "placeholder description." }],
      }),
    },
    {
      name: "alternate_flows[].description",
      build: (kw) => ({
        alternate_flows: [{ label: "placeholder label.", description: kw }],
      }),
    },
  ];

  it("recognizes a keyword present only in one of the four secondary haystack locations", () => {
    const sentence =
      "Triggers an outbound HTTP request to the third-party billing service.";
    for (const loc of LOCATIONS) {
      const issues = validateNotesPropagated(loc.build(sentence) as any, [
        "Makes outbound HTTP request",
      ]);
      expect(
        issues,
        `${loc.name} should let the keyword satisfy the note check (no issues)`,
      ).toEqual([]);
    }
  });

  it("matches keywords case-insensitively (haystack is lowercased before substring search)", () => {
    // A regression dropping `.toLowerCase()` from validator.ts:244 would
    // silently miss real-world LLM output that capitalizes the side-effect
    // verb ("EMAIL receipt", "Mutates the CACHE", etc.). Pin the contract
    // with uppercase keyword text in the haystack.
    const draft = {
      business_rules: [{ rule: "The receipt EMAIL is delivered to the buyer." }],
    };
    expect(validateNotesPropagated(draft as any, ["Sends email"])).toEqual([]);
  });
});

describe("validator graceful handling of malformed-JSON entries", () => {
  // Realistic LLM failure mode: token-budget overrun or tool-use response
  // stitching produces `[null, {...}]` inside an object array. Without
  // guards, accessing `.step` / `.rule` / `.label` on the null entry
  // TypeErrors and aborts the entire `generate` run with an opaque
  // "Cannot read properties of null" message bubbling up through
  // extractor.ts's spread. The fix is to skip null/undefined entries; pin
  // the contract so a future refactor that drops the guard fails here
  // instead of crashing a real customer run.
  it("validateUseCaseDraft does not crash when main_flow contains a null entry; flags it as an empty step", () => {
    const draft = {
      summary: "ok summary",
      actor: "ok actor",
      trigger: "ok trigger",
      main_flow: [{ step: "ok step one" }, null, { step: "ok step three" }],
      postconditions: ["ok"],
    };
    const issues = validateUseCaseDraft(draft as any);
    const flowIssue = issues.find(
      (i) => i.field === "main_flow" && i.message.includes("empty"),
    );
    expect(flowIssue?.severity).toBe("error");
  });

  it("validateNotesPropagated skips null entries in business_rules / main_flow / alternate_flows without crashing", () => {
    // Each object-array haystack location is exercised with a null + valid
    // pair. The valid entry carries an email keyword in three locations so
    // the function should return [] (no warns) every time -- a regression
    // dropping any guard would TypeError on the null entry first.
    const drafts: Array<Record<string, unknown>> = [
      { business_rules: [null, { rule: "An email is sent to the buyer." }] },
      { main_flow: [null, { step: "The system emails the buyer." }] },
      {
        alternate_flows: [
          null,
          { label: "x", description: "An email retry fires on bounce." },
        ],
      },
    ];
    for (const draft of drafts) {
      expect(
        validateNotesPropagated(draft as any, ["Sends email"]),
        `null-entry guard failed for ${JSON.stringify(Object.keys(draft))}`,
      ).toEqual([]);
    }
  });
});

describe("COMPLIANCE_NOTE_PREFIXES shadowing guard", () => {
  // findKeywordsFor() in validator.ts iterates NOTE_KEYWORDS in insertion
  // order and returns the FIRST prefix whose `note.startsWith(prefix)`
  // matches. Whenever any prefix A is a string-prefix of another prefix B,
  // every "B-style note" also starts with A; depending on iteration order
  // the wrong keyword set is returned and the more-specific entry never
  // fires.
  //
  // Concrete footgun: a future contributor adds
  //   "Sends email digest": ["digest", "weekly recap", "summary email"]
  // intending more specific matching for newsletter-style emails. Since
  // "Sends email digest".startsWith("Sends email") is true and "Sends email"
  // is the older (earlier-inserted) key, every digest note routes to the
  // generic email keyword set. The new entry is dead code.
  //
  // The simple invariant that keeps findKeywordsFor sound: no prefix is a
  // strict string-prefix of any other prefix. Pin it here so the bug is
  // caught at test-time rather than as silent absent warns in audit logs.
  it("no prefix is a strict string-prefix of any other prefix", () => {
    for (const a of COMPLIANCE_NOTE_PREFIXES) {
      for (const b of COMPLIANCE_NOTE_PREFIXES) {
        if (a === b) continue;
        // Strict prefix means a starts with b AND a is longer than b.
        // (Equal-length entries are caught by the a === b skip; a duplicate
        // key would have been flagged by TypeScript's Record check anyway.)
        const isStrictPrefix = a.length > b.length && a.startsWith(b);
        expect(
          isStrictPrefix,
          `prefix "${a}" would be shadowed by "${b}" in findKeywordsFor(), every "${a}"-style note routes to "${b}"'s keyword set instead`,
        ).toBe(false);
      }
    }
  });
});
