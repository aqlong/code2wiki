import { describe, expect, it } from "vitest";
import { extractUseCase, pairAspxCandidates, type LlmFn } from "./extractor.js";
import { defaultConfig } from "./config.js";
import {
  formatRetryHint,
  validateUseCaseDraft,
} from "./feedback/validator.js";
import type { Candidate } from "./types.js";

const CANDIDATE: Candidate = {
  language: "java",
  filePath: "/repo/src/Foo.java",
  relativePath: "src/Foo.java",
  name: "Foo.bar",
  kind: "controller-method",
  lineStart: 10,
  lineEnd: 25,
  source: '@GetMapping("/x") public String bar() { return "x"; }',
  hints: {
    annotations: ["Controller", "GetMapping"],
    httpRoute: { method: "GET", path: "/x" },
    parameters: [],
    callees: [],
  },
};

const META = { commit: "abc1234", generatedAt: "2026-05-08T00:00:00Z" };

const GOOD_DRAFT = {
  title: "Bar method",
  actor: "Authenticated buyer",
  summary:
    "The buyer hits /x; the system returns the canonical x response.",
  trigger: "GET /x is requested.",
  preconditions: ["The buyer is signed in."],
  main_flow: [
    { step: "The system receives a GET request to /x." },
    { step: "The system returns the response body 'x'." },
  ],
  alternate_flows: [],
  postconditions: ["The response body 'x' is returned."],
  business_rules: [],
  test_scenarios: [],
  related: [],
  tags: ["controller"],
  confidence: "medium" as const,
  confidence_reason: "Straightforward.",
};

// A draft that the validator flags as having errors: empty summary +
// single-step main_flow + empty actor.
const BROKEN_DRAFT = {
  ...GOOD_DRAFT,
  summary: "",
  actor: "",
  main_flow: [{ step: "Solo step." }],
};

describe("extractUseCase chain-of-correction retry", () => {
  it("does NOT retry when the first draft is structurally clean (and reports retry: null)", async () => {
    let calls = 0;
    const llmFn: LlmFn = async () => {
      calls++;
      return GOOD_DRAFT;
    };
    const config = defaultConfig();
    const { useCase, retry } = await extractUseCase(
      CANDIDATE,
      "test-project",
      config,
      META,
      llmFn,
    );
    expect(calls).toBe(1);
    expect(useCase.summary).toBe(GOOD_DRAFT.summary);
    expect(retry).toBeNull();
  });

  it("retries ONCE when the first draft has error-level validator issues, and reports outcome 'recovered'", async () => {
    const calls: Array<{ retryHint: string | undefined }> = [];
    const drafts = [BROKEN_DRAFT, GOOD_DRAFT];
    const llmFn: LlmFn = async (opts) => {
      calls.push({ retryHint: opts.retryHint });
      return drafts.shift()!;
    };
    const config = defaultConfig();
    const { useCase, retry } = await extractUseCase(
      CANDIDATE,
      "test-project",
      config,
      META,
      llmFn,
    );
    expect(calls.length).toBe(2);
    // First call has no retry hint; second call carries the
    // validator's complaint.
    expect(calls[0]?.retryHint).toBeUndefined();
    expect(calls[1]?.retryHint).toMatch(/summary|main_flow|actor/);
    // The final use case used the GOOD draft (not the broken first one).
    expect(useCase.summary).toBe(GOOD_DRAFT.summary);
    expect(useCase.actor).toBe(GOOD_DRAFT.actor);
    expect(useCase.main_flow).toHaveLength(GOOD_DRAFT.main_flow.length);
    // Retry record is populated for the audit-log emitter.
    expect(retry).not.toBeNull();
    expect(retry?.outcome).toBe("recovered");
    expect(retry?.firstIssues.some((i) => i.field === "summary")).toBe(true);
    expect(retry?.retriedIssues).toEqual([]);
  });

  it("never loops past 2 calls, if the retry is just as broken, fall back to the first draft and report 'no_help'", async () => {
    let calls = 0;
    const llmFn: LlmFn = async () => {
      calls++;
      return BROKEN_DRAFT;
    };
    const config = defaultConfig();
    const { useCase, retry } = await extractUseCase(
      CANDIDATE,
      "test-project",
      config,
      META,
      llmFn,
    );
    // Bounded: exactly 2 LLM calls (one initial + one retry), never
    // more, even when the retry didn't help.
    expect(calls).toBe(2);
    // The structured-default fallbacks in extractor.ts (?? "...")
    // only fire on null/undefined, the broken draft's empty strings
    // pass through. That's by design: the audit log preserves the
    // "what the LLM actually produced" signal so downstream feedback
    // loops (#1 edit-back, #3 confidence calibration) see the truth.
    expect(useCase.summary).toBe("");
    expect(useCase.actor).toBe("");
    // Retry record reports the outcome for audit-log persistence.
    expect(retry?.outcome).toBe("no_help");
    expect(
      retry?.firstIssues.filter((i) => i.severity === "error").length,
    ).toBeGreaterThan(0);
    expect(
      retry?.retriedIssues.filter((i) => i.severity === "error").length,
    ).toBeGreaterThan(0);
  });

  it("treats equal-error-count retry as no_help (boundary: < not <=)", async () => {
    // Validator emits errors for: empty summary, empty actor,
    // main_flow.length<2, empty-step in main_flow. Craft a first
    // draft with exactly TWO errors (empty actor + empty summary) and
    // a retried draft with a DIFFERENT pair of two errors
    // (single-step main_flow + empty-step). A regression flipping
    // `recovered = retriedErrorCount < firstErrorCount` to `<=` would
    // accept this retry; the pin keeps the strict-less-than semantic
    // so a retry that swaps one bug for another doesn't get adopted.
    const firstDraft = {
      ...GOOD_DRAFT,
      title: "first-title",
      summary: "",
      actor: "",
    };
    const retriedDraft = {
      ...GOOD_DRAFT,
      title: "retried-title",
      main_flow: [{ step: "" }],
    };
    const drafts = [firstDraft, retriedDraft];
    const llmFn: LlmFn = async () => drafts.shift()!;
    const { useCase, retry } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmFn,
    );
    // Use the FIRST draft (retried wasn't strictly better).
    expect(useCase.title).toBe("first-title");
    expect(retry?.outcome).toBe("no_help");
    // Both first and retried had exactly 2 error-level issues each.
    const firstErrors = retry?.firstIssues.filter(
      (i) => i.severity === "error",
    ).length;
    const retriedErrors = retry?.retriedIssues.filter(
      (i) => i.severity === "error",
    ).length;
    expect(firstErrors).toBe(retriedErrors);
  });

  it("accepts the retried draft when it has fewer (but still >0) errors", async () => {
    // BROKEN_DRAFT has 3 error-level issues (summary="" + actor="" +
    // single-step main_flow). Retried draft has exactly ONE
    // (single-step main_flow); 1 < 3 → recovered. Pins the
    // "any reduction counts as recovery" semantic, a regression
    // requiring zero retried errors to call it recovered would
    // discard partial-recovery wins.
    const partialDraft = {
      ...GOOD_DRAFT,
      title: "partially-recovered",
      main_flow: [{ step: "Single step." }],
    };
    const drafts = [BROKEN_DRAFT, partialDraft];
    const llmFn: LlmFn = async () => drafts.shift()!;
    const { useCase, retry } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmFn,
    );
    expect(useCase.title).toBe("partially-recovered");
    expect(retry?.outcome).toBe("recovered");
    expect(
      retry?.retriedIssues.filter((i) => i.severity === "error").length,
    ).toBe(1);
    expect(
      retry?.firstIssues.filter((i) => i.severity === "error").length,
    ).toBe(3);
  });

  it("propagates ALL retried-draft fields on recovery, not just summary", async () => {
    // The existing recovered-path test happens to share most fields
    // between BROKEN_DRAFT and GOOD_DRAFT (BROKEN_DRAFT spreads
    // ...GOOD_DRAFT and only overrides summary/actor/main_flow). So a
    // regression that returned `firstDraft` for everything OTHER
    // than summary/actor/main_flow would pass undetected. This test
    // varies title, preconditions, postconditions, tags, confidence,
    // and confidence_reason between the broken first draft and the
    // clean retried draft so the propagation pin catches a partial
    // copy.
    const firstDraft = {
      ...BROKEN_DRAFT,
      title: "first-draft-title",
      preconditions: ["first-pre-1"],
      postconditions: ["first-post-1"],
      tags: ["first-tag"],
      confidence: "low" as const,
      confidence_reason: "first reason",
    };
    const retriedDraft = {
      ...GOOD_DRAFT,
      title: "retried-draft-title",
      preconditions: ["retried-pre-1", "retried-pre-2"],
      postconditions: ["retried-post-1"],
      tags: ["retried-tag-a", "retried-tag-b"],
      confidence: "high" as const,
      confidence_reason: "retried reason",
    };
    const drafts = [firstDraft, retriedDraft];
    const llmFn: LlmFn = async () => drafts.shift()!;
    const { useCase, retry } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmFn,
    );
    expect(retry?.outcome).toBe("recovered");
    // Every distinguishing field is the retried-draft value.
    expect(useCase.title).toBe("retried-draft-title");
    expect(useCase.slug).toBe("retried-draft-title");
    expect(useCase.preconditions).toEqual(["retried-pre-1", "retried-pre-2"]);
    expect(useCase.postconditions).toEqual(["retried-post-1"]);
    expect(useCase.tags).toEqual(["retried-tag-a", "retried-tag-b"]);
    expect(useCase.confidence).toBe("high");
    expect(useCase.confidence_reason).toBe("retried reason");
  });
});

describe("extractUseCase threads config.validator.maxMainFlowSteps", () => {
  // Regression guard for ff822ee (validator main_flow upper-bound +
  // config.validator.maxMainFlowSteps customer override). The extractor
  // MUST pass config.validator.maxMainFlowSteps into validateUseCaseDraft
  // on BOTH the first-draft AND the retry-draft path. validator.test.ts
  // pins the validator's own behavior; nothing pins the threading. A
  // regression dropping the options arg on either site (or hardcoding
  // 12) would silently neuter the customer-facing override: customers
  // bumping the ceiling to e.g. 20 would still see 13-step flows
  // surface a main_flow warn in audit retried-entry details, even
  // though their config says 13 is fine.
  //
  // Test shape: a draft with an empty summary (forces the retry path so
  // retry.firstIssues + retry.retriedIssues become observable) AND 13
  // valid main_flow steps (above the default 12 ceiling, below the
  // override 20). At default config the warn fires on both sides; with
  // the override it fires on neither. A hardcode-12 regression would
  // fail the override case on at least one of the two issue surfaces.
  function makeBrokenDraftWith13Steps(): typeof GOOD_DRAFT {
    return {
      ...GOOD_DRAFT,
      summary: "",
      main_flow: Array.from({ length: 13 }, (_, i) => ({
        step: `Step ${i + 1}.`,
      })),
    };
  }

  it("default ceiling (12): main_flow warn fires on BOTH first and retried issues at 13 steps", async () => {
    const draft = makeBrokenDraftWith13Steps();
    const llmFn: LlmFn = async () => draft;
    const { retry } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmFn,
    );
    const firstMainFlowWarns = (retry?.firstIssues ?? []).filter(
      (i) => i.field === "main_flow" && i.severity === "warn",
    );
    const retriedMainFlowWarns = (retry?.retriedIssues ?? []).filter(
      (i) => i.field === "main_flow" && i.severity === "warn",
    );
    expect(firstMainFlowWarns.length).toBe(1);
    expect(retriedMainFlowWarns.length).toBe(1);
    // Sanity: the warn references the configured ceiling, not some
    // other number; pins that ConfigSchema's .default(12) actually
    // reaches the validator.
    expect(firstMainFlowWarns[0]?.message).toMatch(/<= 12/);
  });

  it("config override (20): main_flow warn fires on NEITHER first nor retried issues at 13 steps", async () => {
    const draft = makeBrokenDraftWith13Steps();
    const llmFn: LlmFn = async () => draft;
    const config = defaultConfig();
    config.validator.maxMainFlowSteps = 20;
    const { retry } = await extractUseCase(
      CANDIDATE,
      "test-project",
      config,
      META,
      llmFn,
    );
    const firstMainFlowWarns = (retry?.firstIssues ?? []).filter(
      (i) => i.field === "main_flow" && i.severity === "warn",
    );
    const retriedMainFlowWarns = (retry?.retriedIssues ?? []).filter(
      (i) => i.field === "main_flow" && i.severity === "warn",
    );
    // A hardcoded-12 regression on the FIRST-draft path leaks a warn
    // here; a hardcoded-12 regression on the RETRY path leaks a warn on
    // retriedMainFlowWarns. Independently observable, so the failure
    // points at the broken site.
    expect(firstMainFlowWarns.length).toBe(0);
    expect(retriedMainFlowWarns.length).toBe(0);
    // The non-main_flow error-level issue (empty summary) still fires,
    // so the retry path is genuinely exercised under the override.
    expect(
      (retry?.firstIssues ?? []).some(
        (i) => i.field === "summary" && i.severity === "error",
      ),
    ).toBe(true);
  });
});

describe("extractUseCase threads config.validator.tagJargonBlocklist", () => {
  // Regression guard parallel to maxMainFlowSteps threading above. The
  // extractor passes config.validator.tagJargonBlocklist into
  // validateUseCaseDraft on BOTH the first-draft AND the retry-draft path.
  // validator.test.ts pins the validator's own behavior; nothing pins the
  // threading. A regression dropping the options arg on either site (or
  // falling back to DEFAULT_TAG_JARGON_BLOCKLIST unconditionally) would
  // silently ignore a customer's `tagJargonBlocklist: []` escape-hatch:
  // their tech-audience docs would still surface jargon warns in the audit
  // log even after they explicitly disabled the check.
  //
  // Test shape: a draft with an empty summary (forces retry so both
  // firstIssues + retriedIssues are observable) AND tags containing jargon
  // terms from the default blocklist ("ssl", "json"). At default config
  // both issue arrays carry a tags warn; with an empty blocklist neither
  // does. A hardcoded-default regression would fail the override case.
  function makeDraftWithJargonTags(): typeof GOOD_DRAFT {
    return {
      ...GOOD_DRAFT,
      summary: "",
      tags: ["ssl", "json"],
    };
  }

  it("default blocklist: tags warn fires on BOTH first and retried issues when tags include jargon", async () => {
    const draft = makeDraftWithJargonTags();
    const llmFn: LlmFn = async () => draft;
    const { retry } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmFn,
    );
    const firstTagWarns = (retry?.firstIssues ?? []).filter(
      (i) => i.field === "tags" && i.severity === "warn",
    );
    const retriedTagWarns = (retry?.retriedIssues ?? []).filter(
      (i) => i.field === "tags" && i.severity === "warn",
    );
    expect(firstTagWarns.length).toBe(1);
    expect(retriedTagWarns.length).toBe(1);
    // Sanity: the warn message names the offending terms; pins that
    // the default blocklist actually reaches the validator, not just
    // that SOME warn fired.
    expect(firstTagWarns[0]?.message).toMatch(/ssl|json/);
  });

  it("empty-blocklist override: tags warn fires on NEITHER first nor retried issues", async () => {
    const draft = makeDraftWithJargonTags();
    const llmFn: LlmFn = async () => draft;
    const config = defaultConfig();
    config.validator.tagJargonBlocklist = [];
    const { retry } = await extractUseCase(
      CANDIDATE,
      "test-project",
      config,
      META,
      llmFn,
    );
    const firstTagWarns = (retry?.firstIssues ?? []).filter(
      (i) => i.field === "tags" && i.severity === "warn",
    );
    const retriedTagWarns = (retry?.retriedIssues ?? []).filter(
      (i) => i.field === "tags" && i.severity === "warn",
    );
    // A hardcoded-DEFAULT regression on the first-draft path leaks a warn
    // here; on the retry path leaks one on retriedTagWarns. Independently
    // observable so the failure points at the broken site.
    expect(firstTagWarns.length).toBe(0);
    expect(retriedTagWarns.length).toBe(0);
    // The summary error still fires, confirming the retry path ran.
    expect(
      (retry?.firstIssues ?? []).some(
        (i) => i.field === "summary" && i.severity === "error",
      ),
    ).toBe(true);
  });
});

describe("extractUseCase threads validateNotesPropagated", () => {
  // Regression guard for the notes-propagation call added alongside the
  // NOTE_KEYWORDS map in validator.ts. extractor.ts wires
  // validateNotesPropagated(llmResult, candidate.hints.notes) on BOTH the
  // first-draft AND the retry-draft path. validator.test.ts pins the
  // validator's own behavior; nothing pins the threading. A regression
  // dropping the call on either path would silently let un-surfaced
  // compliance signals (email, HTTP, transactions, etc.) pass through
  // without any audit-log record of the miss.
  //
  // Test shape A: draft with an empty summary (forces retry path so both
  // firstIssues + retriedIssues are observable) AND a candidate whose
  // hints.notes contains "Sends email". The LLM mock never surfaces an
  // email-related word. Both issue arrays MUST carry the notes-propagation
  // warn. A regression dropping the call on EITHER path fails the
  // corresponding assertion independently.
  //
  // Test shape B: first draft is broken (empty summary), retried draft
  // surfaces the compliance signal. retriedIssues must NOT carry the warn,
  // confirming the retry path re-runs validateNotesPropagated on the new
  // draft rather than re-using the first-draft issues.
  const NOTES_CANDIDATE: Candidate = {
    ...CANDIDATE,
    hints: { ...CANDIDATE.hints, notes: ["Sends email"] },
  };

  it("notes-propagation warn appears in BOTH firstIssues and retriedIssues when the LLM never surfaces the note", async () => {
    const draft = { ...BROKEN_DRAFT }; // empty summary forces retry; no email text anywhere
    const llmFn: LlmFn = async () => draft;
    const { retry } = await extractUseCase(
      NOTES_CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmFn,
    );
    const firstNotesWarns = (retry?.firstIssues ?? []).filter(
      (i) => i.severity === "warn" && i.message.includes("Sends email"),
    );
    const retriedNotesWarns = (retry?.retriedIssues ?? []).filter(
      (i) => i.severity === "warn" && i.message.includes("Sends email"),
    );
    expect(firstNotesWarns.length).toBe(1);
    expect(retriedNotesWarns.length).toBe(1);
  });

  it("notes-propagation warn disappears from retriedIssues when the retried draft surfaces the signal", async () => {
    // First draft is broken + missing email; retried draft is structurally
    // clean AND mentions email. retriedIssues must have zero notes warns,
    // confirming the retry path calls validateNotesPropagated on the new
    // draft rather than forwarding the first-draft issue list.
    const firstDraft = { ...BROKEN_DRAFT };
    const retriedDraft = {
      ...GOOD_DRAFT,
      business_rules: [{ rule: "A confirmation email is sent to the buyer." }],
    };
    const drafts = [firstDraft, retriedDraft];
    const llmFn: LlmFn = async () => drafts.shift()!;
    const { retry } = await extractUseCase(
      NOTES_CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmFn,
    );
    expect(retry?.outcome).toBe("recovered");
    const firstNotesWarns = (retry?.firstIssues ?? []).filter(
      (i) => i.severity === "warn" && i.message.includes("Sends email"),
    );
    const retriedNotesWarns = (retry?.retriedIssues ?? []).filter(
      (i) => i.severity === "warn" && i.message.includes("Sends email"),
    );
    // First draft didn't surface email → warn in firstIssues.
    expect(firstNotesWarns.length).toBe(1);
    // Retried draft DID surface email → no warn in retriedIssues.
    expect(retriedNotesWarns.length).toBe(0);
  });
});

describe("extractUseCase field mapping", () => {
  const llmReturning = (draft: unknown): LlmFn => async () => draft;

  it("falls back to humanized candidate.name when the LLM omits title", async () => {
    // GOOD_DRAFT has title="Bar method"; strip it so the fallback fires.
    // candidate.name = "Foo.bar" → humanizeName → "Foo bar".
    const { title: _omit, ...withoutTitle } = GOOD_DRAFT;
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning(withoutTitle),
    );
    expect(useCase.title).toBe("Foo bar");
  });

  it("falls back to humanized candidate.name when the LLM returns an empty-string title", async () => {
    // The `title.length > 0` guard MUST treat "" as "absent". A
    // regression to plain `?? humanizeName(...)` would publish a page
    // with no human-visible heading.
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning({ ...GOOD_DRAFT, title: "" }),
    );
    expect(useCase.title).toBe("Foo bar");
  });

  it("uses the LLM title verbatim when it is a non-empty string", async () => {
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning({ ...GOOD_DRAFT, title: "Buyer fetches X response" }),
    );
    expect(useCase.title).toBe("Buyer fetches X response");
  });

  it("derives slug from the FINAL title via slugify (LLM-supplied path)", async () => {
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning({ ...GOOD_DRAFT, title: "Buyer Fetches X Response" }),
    );
    expect(useCase.slug).toBe("buyer-fetches-x-response");
  });

  it("derives slug from the FINAL title via slugify (fallback-title path)", async () => {
    // Omit title → title = humanizeName("Foo.bar") = "Foo bar" →
    // slug = "foo-bar". Pins the slug-tracks-FINAL-title invariant
    // (a regression slugifying the LLM's raw title would yield "" here).
    const { title: _omit, ...withoutTitle } = GOOD_DRAFT;
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning(withoutTitle),
    );
    expect(useCase.slug).toBe("foo-bar");
  });

  it("derives code2wiki_id from language + relativePath + name, NEVER from title", async () => {
    // CLAUDE.md "Key conventions": code2wiki_id is the stable upsert
    // key; slug is the URL form. A regression hashing title would
    // create a new page on every rename.
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning(GOOD_DRAFT),
    );
    expect(useCase.code2wiki_id).toBe("java-src-foo-foo-bar-v1");
  });

  it("preserves code2wiki_id when the LLM returns a different title for the same candidate", async () => {
    // Two runs against the SAME candidate produce the SAME id even
    // if the LLM picks different titles. This is the "renaming a page
    // must preserve the ID" guarantee.
    const first = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning({ ...GOOD_DRAFT, title: "First name" }),
    );
    const second = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning({ ...GOOD_DRAFT, title: "Wholly different" }),
    );
    expect(first.useCase.code2wiki_id).toBe(second.useCase.code2wiki_id);
    expect(first.useCase.title).not.toBe(second.useCase.title);
  });

  it("emits exactly one source_files entry with relativePath + 'lineStart-lineEnd'", async () => {
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning(GOOD_DRAFT),
    );
    expect(useCase.source_files).toEqual([
      { path: "src/Foo.java", lines: "10-25" },
    ]);
  });

  it("defaults tags to [language, kind] when the LLM omits them", async () => {
    const { tags: _omit, ...withoutTags } = GOOD_DRAFT;
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning(withoutTags),
    );
    expect(useCase.tags).toEqual(["java", "controller-method"]);
  });

  it("passes LLM tags through verbatim when provided", async () => {
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning({ ...GOOD_DRAFT, tags: ["payments", "buyer-flow"] }),
    );
    expect(useCase.tags).toEqual(["payments", "buyer-flow"]);
  });

  it("fills actor / actor_detail / summary / trigger / confidence with sentinel defaults when the LLM omits them", async () => {
    // Pins every `?? "..."` fallback in one shot. A regression dropping
    // any single one (e.g. summary `?? ""` instead of the user-visible
    // "(no summary produced)" sentinel) would silently publish blank
    // bullets that a BA would skip over rather than flag.
    const minimal = {} as Partial<typeof GOOD_DRAFT>;
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning(minimal),
    );
    expect(useCase.actor).toBe("Unknown caller");
    expect(useCase.actor_detail).toBe("");
    expect(useCase.summary).toBe("(no summary produced)");
    expect(useCase.trigger).toBe("");
    expect(useCase.confidence).toBe("low");
    expect(useCase.confidence_reason).toBe("");
    expect(useCase.preconditions).toEqual([]);
    expect(useCase.main_flow).toEqual([]);
    expect(useCase.alternate_flows).toEqual([]);
    expect(useCase.postconditions).toEqual([]);
    expect(useCase.business_rules).toEqual([]);
    expect(useCase.test_scenarios).toEqual([]);
    expect(useCase.related).toEqual([]);
  });

  it("status is always 'active', the LLM cannot drive it", async () => {
    // Regression guard: a draft trying to set status='deprecated' must
    // be ignored. status is a workflow field owned by the audit log +
    // claim flow (ADR-016), not the LLM.
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      META,
      llmReturning({ ...GOOD_DRAFT, status: "deprecated" }),
    );
    expect(useCase.status).toBe("active");
  });

  it("passes meta.commit and meta.generatedAt through to last_commit and last_generated verbatim", async () => {
    const meta = {
      commit: "deadbeef1234",
      generatedAt: "2027-01-02T03:04:05Z",
    };
    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      defaultConfig(),
      meta,
      llmReturning(GOOD_DRAFT),
    );
    expect(useCase.last_commit).toBe("deadbeef1234");
    expect(useCase.last_generated).toBe("2027-01-02T03:04:05Z");
  });

  it("humanizes candidate.name: snake_case → 'Snake case' via the title-fallback path", async () => {
    const candidate = { ...CANDIDATE, name: "register_new_pet_owner" };
    const { title: _omit, ...withoutTitle } = GOOD_DRAFT;
    const { useCase } = await extractUseCase(
      candidate,
      "test-project",
      defaultConfig(),
      META,
      llmReturning(withoutTitle),
    );
    expect(useCase.title).toBe("Register new pet owner");
  });

  it("humanizes candidate.name: camelCase → 'Camel Case' via the title-fallback path", async () => {
    // The interior caps stay capitalized because the regex `/([A-Z])/g`
    // only inserts a leading space, it does NOT downcase. A regression
    // adding `.toLowerCase()` would yield "Register new pet owner" from
    // "registerNewPetOwner" and lose the title-case readability for
    // multi-word camelCase identifiers.
    const candidate = { ...CANDIDATE, name: "registerNewPetOwner" };
    const { title: _omit, ...withoutTitle } = GOOD_DRAFT;
    const { useCase } = await extractUseCase(
      candidate,
      "test-project",
      defaultConfig(),
      META,
      llmReturning(withoutTitle),
    );
    expect(useCase.title).toBe("Register New Pet Owner");
  });

  it("humanizes candidate.name: Java 'ClassName.method' → 'Class Name method' via the title-fallback path", async () => {
    // Java candidates always use the 'ClassName.method' dot-notation
    // produced by parseJava (e.g. 'HelloController.registerPet').
    // humanizeName expands camelCase FIRST (inserting spaces), then
    // replaces dots with spaces, so the dot lands between two word
    // groups and is itself replaced. A regression dropping the
    // `/[._]/g` replacement would leave 'Hello Controller.register Pet'
    // (literal dot) in the fallback title, breaking every mock-mode
    // or LLM-failure title for Java pages.
    const candidate = { ...CANDIDATE, name: "HelloController.registerPet" };
    const { title: _omit, ...withoutTitle } = GOOD_DRAFT;
    const { useCase } = await extractUseCase(
      candidate,
      "test-project",
      defaultConfig(),
      META,
      llmReturning(withoutTitle),
    );
    expect(useCase.title).toBe("Hello Controller register Pet");
  });
});

// Captures the exact opts each llmFn invocation received, then returns
// drafts in order. The existing retry tests inspect retry.outcome and
// the final use case shape but never pin the SHAPE of the retry call's
// arguments. A refactor that mutated `candidate`, rebuilt `config`, or
// substituted a different `projectName` between the first and retry
// calls would silently desync the retry hint from the candidate it was
// computed against, A/B-test the wrong config object, or break
// audit-log metadata, all while the existing tests pass green.
type LlmCallArgs = {
  candidate: Candidate;
  projectName: string;
  config: ReturnType<typeof defaultConfig>;
  retryHint?: string;
};

function captureLlm(drafts: unknown[]): {
  llmFn: LlmFn;
  calls: LlmCallArgs[];
} {
  const calls: LlmCallArgs[] = [];
  const queue = [...drafts];
  const llmFn: LlmFn = async (opts) => {
    calls.push({
      candidate: opts.candidate,
      projectName: opts.projectName,
      config: opts.config as ReturnType<typeof defaultConfig>,
      retryHint: opts.retryHint,
    });
    if (queue.length === 0) {
      throw new Error("captureLlm: queue exhausted");
    }
    return queue.shift()!;
  };
  return { llmFn, calls };
}

describe("extractUseCase chain-of-correction retry, argument passthrough", () => {
  it("retry call's `candidate` is the SAME object reference as the first call", async () => {
    // Defensive against a refactor that re-clones or substitutes the
    // candidate between attempts: the retry hint is computed against
    // the FIRST candidate's draft, so the retry MUST see the same
    // candidate or the hint becomes meaningless.
    const { llmFn, calls } = captureLlm([BROKEN_DRAFT, GOOD_DRAFT]);
    await extractUseCase(CANDIDATE, "test-project", defaultConfig(), META, llmFn);
    expect(calls.length).toBe(2);
    expect(calls[0]!.candidate).toBe(CANDIDATE);
    expect(calls[1]!.candidate).toBe(CANDIDATE);
    expect(calls[1]!.candidate).toBe(calls[0]!.candidate);
  });

  it("retry call's `projectName` is byte-identical to the first call's projectName", async () => {
    // projectName flows into the prompt header AND the audit log's
    // retried-entry metadata. A regression rebuilding the string (e.g.
    // re-resolving from a config field with different normalization)
    // could ship a mismatched retried-vs-generate pair.
    const { llmFn, calls } = captureLlm([BROKEN_DRAFT, GOOD_DRAFT]);
    const projectName = "test-project-with-distinctive-name";
    await extractUseCase(CANDIDATE, projectName, defaultConfig(), META, llmFn);
    expect(calls.length).toBe(2);
    expect(calls[0]!.projectName).toBe(projectName);
    expect(calls[1]!.projectName).toBe(projectName);
    expect(calls[1]!.projectName).toBe(calls[0]!.projectName);
  });

  it("retry call's `config` is the SAME object reference as the first call", async () => {
    // config carries tools, promptStyle, and (after b17f6f1) the
    // promptVersion stamp written to the audit log. A refactor that
    // built a new config object inside the retry branch could silently
    // diverge prompt behavior between attempts of the same candidate.
    const { llmFn, calls } = captureLlm([BROKEN_DRAFT, GOOD_DRAFT]);
    const config = defaultConfig();
    await extractUseCase(CANDIDATE, "test-project", config, META, llmFn);
    expect(calls.length).toBe(2);
    expect(calls[0]!.config).toBe(config);
    expect(calls[1]!.config).toBe(config);
  });

  it("retry call's `retryHint` is exactly formatRetryHint(validateUseCaseDraft(firstDraft))", async () => {
    // The hint string IS the validator's complaint serialized; the
    // extractor MUST NOT hand-roll its own message format. A regression
    // that built the hint from a different code path (or stripped
    // newlines, etc.) would slip silently past the existing
    // /summary|main_flow|actor/ regex test at L94. Pin the exact bytes.
    const { llmFn, calls } = captureLlm([BROKEN_DRAFT, GOOD_DRAFT]);
    await extractUseCase(CANDIDATE, "test-project", defaultConfig(), META, llmFn);
    expect(calls.length).toBe(2);
    expect(calls[0]!.retryHint).toBeUndefined();
    const expectedHint = formatRetryHint(validateUseCaseDraft(BROKEN_DRAFT));
    expect(calls[1]!.retryHint).toBe(expectedHint);
    expect(expectedHint.length).toBeGreaterThan(0);
  });

  it("on the clean-first-draft path, the single LLM call carries retryHint: undefined", async () => {
    // Defensive against a refactor that pre-computes a retry hint
    // before the validator runs and leaks it into the no-retry path:
    // the first call MUST be a clean prompt (retryHint absent) so the
    // model isn't biased by a phantom complaint. Existing test at L56
    // verifies calls=1 + final shape but never inspects call[0].
    const { llmFn, calls } = captureLlm([GOOD_DRAFT]);
    await extractUseCase(CANDIDATE, "test-project", defaultConfig(), META, llmFn);
    expect(calls.length).toBe(1);
    expect(calls[0]!.retryHint).toBeUndefined();
  });

  it("on the no_help path (retry returns equally-broken draft), candidate/projectName/config identity STILL holds", async () => {
    // The recovered + no_help branches share the same retry-call site
    // in extractor.ts:108, but a future refactor that bifurcated the
    // two could regress one branch's args contract without touching
    // the other. Pin the no_help branch independently so a slip in
    // EITHER recovered-only OR no_help-only fixturing is caught.
    const { llmFn, calls } = captureLlm([BROKEN_DRAFT, BROKEN_DRAFT]);
    const config = defaultConfig();
    const { retry } = await extractUseCase(
      CANDIDATE,
      "test-project",
      config,
      META,
      llmFn,
    );
    expect(retry?.outcome).toBe("no_help");
    expect(calls.length).toBe(2);
    expect(calls[1]!.candidate).toBe(CANDIDATE);
    expect(calls[1]!.projectName).toBe("test-project");
    expect(calls[1]!.config).toBe(config);
    expect(calls[1]!.retryHint).toBe(
      formatRetryHint(validateUseCaseDraft(BROKEN_DRAFT)),
    );
  });
});

// ---------------------------------------------------------------------------
// pairAspxCandidates: ADR-040 D4 markup + code-behind pairing
// ---------------------------------------------------------------------------

describe("pairAspxCandidates", () => {
  function aspxCandidate(relativePath: string): Candidate {
    return {
      language: "csharp",
      filePath: `/repo/${relativePath}`,
      relativePath,
      name: relativePath.split("/").pop() ?? relativePath,
      kind: "aspx-page",
      lineStart: 1,
      lineEnd: 10,
      source: `<form runat="server"><asp:Button runat="server" OnClick="x" /></form>`,
      hints: {},
      companionFile: `${relativePath}.cs`,
      handlerNames: ["x"],
    };
  }

  function webformsHandlerCandidate(
    relativePath: string,
    methodName: string,
  ): Candidate {
    return {
      language: "csharp",
      filePath: `/repo/${relativePath}`,
      relativePath,
      name: `Default#${methodName}`,
      kind: "webforms-handler",
      lineStart: 5,
      lineEnd: 10,
      source: `protected void ${methodName}(object sender, EventArgs e) { }`,
      hints: {},
    };
  }

  it("pairs a Default.aspx candidate with its Default.aspx.cs sibling", () => {
    const candidates: Candidate[] = [
      aspxCandidate("Web/Default.aspx"),
      webformsHandlerCandidate("Web/Default.aspx.cs", "Page_Load"),
    ];
    const fileSources = new Map<string, string>([
      ["Web/Default.aspx.cs", "public partial class Default : Page {\n  protected void Page_Load(object sender, EventArgs e) { }\n}"],
    ]);
    const paired = pairAspxCandidates(candidates, fileSources);
    const aspx = paired.find((c) => c.kind === "aspx-page")!;
    expect(aspx.companionSources).toHaveLength(1);
    expect(aspx.companionSources?.[0]).toEqual({
      path: "Web/Default.aspx.cs",
      content: "public partial class Default : Page {\n  protected void Page_Load(object sender, EventArgs e) { }\n}",
    });
    // Code-behind candidates themselves do NOT receive companionSources;
    // the pairing is only attached to the aspx-page side.
    const handler = paired.find((c) => c.kind === "webforms-handler")!;
    expect(handler.companionSources).toBeUndefined();
  });

  it("pairs a Menu.ascx user control with its Menu.ascx.cs sibling", () => {
    const candidates: Candidate[] = [
      aspxCandidate("Controls/Menu.ascx"),
      webformsHandlerCandidate("Controls/Menu.ascx.cs", "rpt_ItemDataBound"),
    ];
    const fileSources = new Map<string, string>([
      ["Controls/Menu.ascx.cs", "// menu code-behind"],
    ]);
    const paired = pairAspxCandidates(candidates, fileSources);
    const aspx = paired.find((c) => c.kind === "aspx-page")!;
    expect(aspx.companionSources?.[0]?.path).toBe("Controls/Menu.ascx.cs");
    expect(aspx.companionSources?.[0]?.content).toBe("// menu code-behind");
  });

  it("leaves aspx candidates unpaired when no code-behind candidate exists and fileSources is empty", () => {
    // Standalone .aspx page (no .aspx.cs sibling parsed in this run, no
    // companion content pre-loaded) must pass through with companionSources
    // undefined; not an error.
    const candidates: Candidate[] = [aspxCandidate("Web/Standalone.aspx")];
    const fileSources = new Map<string, string>();
    const paired = pairAspxCandidates(candidates, fileSources);
    expect(paired).toHaveLength(1);
    expect(paired[0].kind).toBe("aspx-page");
    expect(paired[0].companionSources).toBeUndefined();
  });

  it("pairs via companionFile hint when no .cs candidate exists but fileSources has the companion content", () => {
    // When the user's config only includes *.aspx (not *.cs), no
    // webforms-handler candidates are in the list and codeBehindPaths is
    // empty. The caller (generate/replay) pre-loads the companion file into
    // fileSources; pairAspxCandidates must use the companionFile hint as a
    // fallback so the LLM still receives the code-behind context.
    const aspx = aspxCandidate("Web/Payment.aspx");
    const candidates: Candidate[] = [aspx];
    const fileSources = new Map<string, string>([
      ["Web/Payment.aspx.cs", "protected void btnPay_Click(object sender, EventArgs e) { ChargeCard(); }"],
    ]);
    const paired = pairAspxCandidates(candidates, fileSources);
    const pairedAspx = paired.find((c) => c.kind === "aspx-page")!;
    expect(pairedAspx.companionSources).toHaveLength(1);
    expect(pairedAspx.companionSources![0]).toEqual({
      path: "Web/Payment.aspx.cs",
      content: "protected void btnPay_Click(object sender, EventArgs e) { ChargeCard(); }",
    });
  });

  it("collapses multiple webforms-handler candidates from the same code-behind into one companionSources entry", () => {
    // One .aspx.cs file may emit many webforms-handler Candidates (one per
    // event method). They should all map to the same file path, so the
    // aspx-page candidate sees a single companionSources entry pointing at
    // that file rather than N duplicates.
    const candidates: Candidate[] = [
      aspxCandidate("Web/Checkout.aspx"),
      webformsHandlerCandidate("Web/Checkout.aspx.cs", "Page_Load"),
      webformsHandlerCandidate("Web/Checkout.aspx.cs", "btnPay_Click"),
      webformsHandlerCandidate("Web/Checkout.aspx.cs", "btnCancel_Click"),
    ];
    const fileSources = new Map<string, string>([
      ["Web/Checkout.aspx.cs", "// checkout code-behind"],
    ]);
    const paired = pairAspxCandidates(candidates, fileSources);
    const aspx = paired.find((c) => c.kind === "aspx-page")!;
    expect(aspx.companionSources).toHaveLength(1);
    expect(aspx.companionSources?.[0]?.path).toBe("Web/Checkout.aspx.cs");
  });

  it("passes Java and CFML candidates through untouched", () => {
    // Non-WebForms candidates have no pairing key and must be returned
    // identically; the pairer should not mutate language="java" or
    // language="cfml" inputs in any way.
    const javaCandidate: Candidate = {
      language: "java",
      filePath: "/repo/src/Foo.java",
      relativePath: "src/Foo.java",
      name: "Foo.bar",
      kind: "controller-method",
      lineStart: 1,
      lineEnd: 5,
      source: "public String bar() { return null; }",
      hints: { annotations: ["GetMapping"] },
    };
    const cfmlCandidate: Candidate = {
      language: "cfml",
      filePath: "/repo/foo.cfm",
      relativePath: "foo.cfm",
      name: "foo",
      kind: "cf-tag-function",
      lineStart: 1,
      lineEnd: 3,
      source: "<cfset x = 1>",
      hints: {},
    };
    const paired = pairAspxCandidates([javaCandidate, cfmlCandidate]);
    expect(paired).toHaveLength(2);
    // Identity preservation: untouched candidates come back by reference.
    expect(paired[0]).toBe(javaCandidate);
    expect(paired[1]).toBe(cfmlCandidate);
    expect(paired[0].companionSources).toBeUndefined();
    expect(paired[1].companionSources).toBeUndefined();
  });

  it("ignores .vb files (no pairing) and passes them through unchanged", () => {
    // VB.NET code-behind is out of scope per ADR-040 D1. The pairing-key
    // regex only matches .aspx / .ascx / .asax (+ their .cs duals); .vb
    // has no key, so it never matches and never gains companionSources.
    const aspx = aspxCandidate("Web/VbPage.aspx");
    const vbCandidate: Candidate = {
      language: "csharp", // parser surface is still csharp-shaped if it ever lands
      filePath: "/repo/Web/VbPage.aspx.vb",
      relativePath: "Web/VbPage.aspx.vb",
      name: "VbPage#Page_Load",
      kind: "webforms-handler",
      lineStart: 1,
      lineEnd: 5,
      source: "Protected Sub Page_Load() End Sub",
      hints: {},
    };
    const fileSources = new Map<string, string>([
      ["Web/VbPage.aspx.vb", "Protected Sub Page_Load() End Sub"],
    ]);
    const paired = pairAspxCandidates([aspx, vbCandidate], fileSources);
    // VB file passes through by identity.
    expect(paired[1]).toBe(vbCandidate);
    // aspx candidate has no .cs sibling so no companionSources is attached.
    const pairedAspx = paired[0];
    expect(pairedAspx.kind).toBe("aspx-page");
    expect(pairedAspx.companionSources).toBeUndefined();
  });
});
