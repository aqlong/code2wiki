import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildUserPrompt, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompts.js";
import { COMPLIANCE_NOTE_PREFIXES } from "../feedback/validator.js";
import type { Candidate, CandidateHints } from "../types.js";

/**
 * Pins the buildUserPrompt LLM-input contract. This is the single entry
 * point that constructs the user-message body for every Anthropic call,
 * so silent regressions surface as drift in EVERY page produced. Surfaces
 * pinned:
 *
 *  1. Header keys + ordering (Project / Source file / Focus region / Language
 *     / Kind). A rename or swap breaks prompt-cache hits on the
 *     system-prompt boundary (everything below the system prompt is the
 *     dynamic half; the LLM cache hit relies on the shape staying
 *     identical run-to-run for the SAME source file).
 *  2. Fence-language selection: `coldfusion` for CFML, `csharp` for C#,
 *     `python`/`ruby` for those languages, `java` for everything else
 *     (including `unknown`). These map to highlight.js language aliases
 *     used by `code2wiki preview` HTML output.
 *  3. Parser-hints block is fully omitted when no hint fields are
 *     populated. A regression emitting an empty `## Parser hints\n`
 *     stub burns tokens AND leaks a trailing blank line that varies
 *     by candidate, busting prompt-cache hits.
 *  4. Hint field formatting + ordering: annotations (comma), httpRoute
 *     (`METHOD PATH` with `(see source)` fallback when path is empty;
 *     the java parser leaves the path in source-text deliberately per
 *     the 2026-05-11 java.test.ts pin), parameters (`name:type` typed /
 *     bare-name untyped), callees (comma, hard-capped at 15 to bound
 *     prompt size; a regression to slice(0,30) or no slice would
 *     2-3x prompt cost for fan-out controllers), databaseTables
 *     (comma), notes (`; ` semicolon-space joiner so notes containing
 *     commas don't get falsely split downstream). Stable ordering matters
 *     for cache stability.
 *  5. Full-file context inclusion under the 3000-line cap (ADR-011).
 *     Cross-file business rules (class-level @InitBinder, sibling DTO
 *     validators) are CRITICAL for accurate use-case extraction. A
 *     regression flipping the comparator (`< 3000` instead of `<= 3000`)
 *     would silently drop the cap to 2999 and degrade just under the
 *     boundary. A regression removing the try/catch would crash whenever
 *     `filePath` is unreadable (rare but real; symlinks, permission
 *     races) instead of degrading gracefully to region-only.
 *  6. The focus-region fenced block contains `candidate.source` verbatim,
 *     not the full file. A regression confusing these would either
 *     double-emit the file (token cost) or replace the focus region with
 *     full-file content (LLM documents the wrong region).
 *  7. PROMPT_VERSION format (`v<integer>`). The audit-log replay flow
 *     (`replay --since-version vN`) compares versions as `vN` strings;
 *     a freeform string ("v1.1", "v1-experimental") breaks `promptVersionLte`.
 *     Comment in prompts.ts ALREADY references this regex pin as if it
 *     existed; this test closes that gap.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-prompt-"));
});

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function makeCandidate(opts: {
  language?: Candidate["language"];
  kind?: Candidate["kind"];
  name?: string;
  relativePath?: string;
  fullFile?: string;
  source?: string;
  hints?: CandidateHints;
  lineStart?: number;
  lineEnd?: number;
  filePath?: string;
  companionSources?: Candidate["companionSources"];
}): Promise<Candidate> {
  const relativePath = opts.relativePath ?? "src/Foo.java";
  let filePath = opts.filePath;
  if (filePath === undefined) {
    filePath = path.join(dir, relativePath);
    if (opts.fullFile !== undefined) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, opts.fullFile, "utf-8");
    }
  }
  return {
    language: opts.language ?? "java",
    filePath,
    relativePath,
    name: opts.name ?? "Foo.bar",
    kind: opts.kind ?? "controller-method",
    lineStart: opts.lineStart ?? 10,
    lineEnd: opts.lineEnd ?? 20,
    source: opts.source ?? 'public String bar() { return "hi"; }',
    hints: opts.hints ?? {},
    companionSources: opts.companionSources,
  };
}

describe("buildUserPrompt", () => {
  describe("header", () => {
    it("includes project name, source file, focus region + line range, language, kind", async () => {
      const c = await makeCandidate({
        relativePath: "src/Foo.java",
        name: "Foo.bar",
        lineStart: 42,
        lineEnd: 99,
        language: "java",
        kind: "controller-method",
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("## Project: demo");
      expect(out).toContain("## Source file: src/Foo.java");
      expect(out).toContain("## Focus region: Foo.bar (lines 42-99)");
      expect(out).toContain("## Language: java");
      expect(out).toContain("## Kind: controller-method");
    });
  });

  describe("fence language", () => {
    it("emits ```coldfusion fences for cfml candidates", async () => {
      const c = await makeCandidate({
        language: "cfml",
        source: "<cffunction />",
        relativePath: "foo.cfc",
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("```coldfusion");
      expect(out).not.toContain("```java");
      expect(out).not.toContain("```cfml");
    });

    it("emits ```java fences for java candidates", async () => {
      const c = await makeCandidate({ language: "java" });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("```java");
      expect(out).not.toContain("```coldfusion");
    });

    it("emits ```csharp fences for csharp candidates", async () => {
      const c = await makeCandidate({ language: "csharp" });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("```csharp");
      expect(out).not.toContain("```java");
    });

    it("emits ```java fences for unknown-language candidates (default fallback)", async () => {
      const c = await makeCandidate({ language: "unknown" });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("```java");
      expect(out).not.toContain("```coldfusion");
    });
  });

  describe("Parser hints block", () => {
    it("omits the heading entirely when all hint fields are empty", async () => {
      const c = await makeCandidate({ hints: {} });
      const out = buildUserPrompt(c, "demo");
      expect(out).not.toContain("## Parser hints");
    });

    it("emits annotations comma-joined", async () => {
      const c = await makeCandidate({
        hints: { annotations: ["Controller", "GetMapping"] },
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("## Parser hints");
      expect(out).toContain("Annotations: Controller, GetMapping");
    });

    it("emits httpRoute verbatim when method + path are populated", async () => {
      const c = await makeCandidate({
        hints: { httpRoute: { method: "POST", path: "/api/users" } },
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("HTTP route: POST /api/users");
    });

    it('falls back to "(see source)" when httpRoute.path is empty', async () => {
      const c = await makeCandidate({
        hints: { httpRoute: { method: "GET", path: "" } },
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("HTTP route: GET (see source)");
    });

    it("formats typed parameters as name:type and untyped as bare name in one comma-joined line", async () => {
      const c = await makeCandidate({
        hints: {
          parameters: [
            { name: "id", type: "long" },
            { name: "siteid" },
            { name: "items", type: "List<String>" },
          ],
        },
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("Parameters: id:long, siteid, items:List<String>");
    });

    it("emits up to 15 callees comma-joined when under the cap", async () => {
      const c = await makeCandidate({ hints: { callees: ["a", "b", "c"] } });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("Calls: a, b, c");
    });

    it("caps callees at 15 to bound prompt size (regression guard for fan-out controllers)", async () => {
      const many = Array.from({ length: 25 }, (_, i) => `fn${i}`);
      const c = await makeCandidate({ hints: { callees: many } });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain(
        "Calls: fn0, fn1, fn2, fn3, fn4, fn5, fn6, fn7, fn8, fn9, fn10, fn11, fn12, fn13, fn14",
      );
      // anything from fn15 onward must NOT appear in the Calls line
      expect(out).not.toMatch(/Calls:[^\n]*\bfn15\b/);
      expect(out).not.toMatch(/Calls:[^\n]*\bfn24\b/);
    });

    it("emits databaseTables comma-joined", async () => {
      const c = await makeCandidate({
        hints: { databaseTables: ["users", "orders", "audit_log"] },
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("DB tables touched: users, orders, audit_log");
    });

    it("bullet-formats notes (one per line, '- ' prefix) so colon-bearing entries stay parseable", async () => {
      const c = await makeCandidate({
        hints: {
          notes: [
            "uses announceEvent",
            "scope=public, all sites",
            "Calls stored procedure(s): sp_GetOrders",
          ],
        },
      });
      const out = buildUserPrompt(c, "demo");
      // Each note on its own bulleted line; preserves notes that contain commas
      // and notes whose body has an embedded colon.
      expect(out).toContain(
        "Notes:\n- uses announceEvent\n- scope=public, all sites\n- Calls stored procedure(s): sp_GetOrders",
      );
      // Defensive: no semicolon-joined fallback.
      expect(out).not.toContain("uses announceEvent; scope=public");
    });

    it("emits handlerNames comma-joined as 'Handler names:' for aspx-page candidates", async () => {
      const c = await makeCandidate({
        kind: "aspx-page",
        language: "csharp",
        hints: {},
      });
      c.handlerNames = ["btnSubmit_Click", "ddl_SelectedIndexChanged"];
      const out = buildUserPrompt(c, "shop");
      expect(out).toContain("## Parser hints");
      expect(out).toContain("Handler names: btnSubmit_Click, ddl_SelectedIndexChanged");
    });

    it("omits 'Handler names:' line when handlerNames is absent or empty", async () => {
      const withEmpty = await makeCandidate({ hints: {} });
      withEmpty.handlerNames = [];
      const withAbsent = await makeCandidate({ hints: {} });
      for (const c of [withEmpty, withAbsent]) {
        const out = buildUserPrompt(c, "demo");
        expect(out).not.toContain("Handler names:");
      }
    });

    it("emits hint kinds in a stable order: annotations → httpRoute → parameters → callees → databaseTables → handlerNames → notes", async () => {
      const c = await makeCandidate({
        kind: "aspx-page",
        language: "csharp",
        hints: {
          notes: ["n"],
          databaseTables: ["t"],
          callees: ["c"],
          parameters: [{ name: "p" }],
          httpRoute: { method: "GET", path: "/x" },
          annotations: ["A"],
        },
      });
      c.handlerNames = ["btn_Click"];
      const out = buildUserPrompt(c, "demo");
      const order = [
        "Annotations:",
        "HTTP route:",
        "Parameters:",
        "Calls:",
        "DB tables touched:",
        "Handler names:",
        "Notes:",
      ];
      let prev = -1;
      for (const label of order) {
        const idx = out.indexOf(label);
        expect(idx, `${label} should appear after the previous label`).toBeGreaterThan(prev);
        prev = idx;
      }
    });
  });

  describe("full-file context (ADR-011 3000-line cap)", () => {
    it("includes the entire file inside a fenced block when ≤ 3000 lines", async () => {
      const fullFile = ["line 1", "line 2", "line 3"].join("\n");
      const c = await makeCandidate({
        fullFile,
        source: "line 2",
        lineStart: 2,
        lineEnd: 2,
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("## Full source file (for cross-region context)");
      expect(out).toContain(
        "The function/region you are documenting is at lines 2-2.",
      );
      expect(out).toContain(fullFile);
    });

    it("includes the full-file section at the 3000-line boundary (inclusive)", async () => {
      const fullFile = Array.from(
        { length: 3000 },
        (_, i) => `line ${i + 1}`,
      ).join("\n");
      const c = await makeCandidate({
        fullFile,
        source: "line 1",
        lineStart: 1,
        lineEnd: 1,
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("## Full source file (for cross-region context)");
    });

    it("omits the full-file section when the file exceeds 3000 lines", async () => {
      const fullFile = Array.from(
        { length: 3001 },
        (_, i) => `line ${i + 1}`,
      ).join("\n");
      const c = await makeCandidate({
        fullFile,
        source: "line 100",
        lineStart: 100,
        lineEnd: 100,
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).not.toContain("## Full source file (for cross-region context)");
      // sanity: the focus-region source still ships in the Focus region block
      expect(out).toContain("line 100");
    });

    it("omits the full-file section when the focus region spans the whole file (aspx-page / cfm page-level)", async () => {
      // aspx-page and cfm page-level candidates set lineStart=1,
      // lineEnd=totalLines. Including a full-file block would be identical
      // to the focus-region block, doubling token cost and emitting the
      // misleading "use the rest of the file" instruction when there IS no
      // rest. The focus-region block alone is enough context.
      const fullFile = ["<form runat='server'>", "  <asp:Button runat='server' />", "</form>"].join("\n");
      const c = await makeCandidate({
        fullFile,
        source: fullFile,
        lineStart: 1,
        lineEnd: 3,
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).not.toContain("## Full source file (for cross-region context)");
      // Focus-region source still emitted.
      expect(out).toContain(fullFile);
    });

    it("includes the full-file section when focus is a sub-region of a whole-file-spanning candidate (lineEnd < totalLines)", async () => {
      // Regression guard: spansWholeFile must check BOTH lineStart===1 AND
      // lineEnd>=lineCount-1. A candidate starting at line 1 but ending at
      // line 1 of a 3-line file should still get the full-file context block.
      const fullFile = ["line 1", "line 2", "line 3"].join("\n");
      const c = await makeCandidate({
        fullFile,
        source: "line 1",
        lineStart: 1,
        lineEnd: 1,
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).toContain("## Full source file (for cross-region context)");
    });

    it("gracefully omits the full-file section when filePath does not exist (degrades to region-only)", async () => {
      const c = await makeCandidate({
        filePath: path.join(dir, "this", "path", "does", "not", "exist.java"),
      });
      const out = buildUserPrompt(c, "demo");
      expect(out).not.toContain("## Full source file (for cross-region context)");
      // focus-region source still emitted
      expect(out).toContain(c.source);
    });
  });

  describe("focus region", () => {
    it("emits exactly candidate.source inside the Focus region source fence (NOT the full file)", async () => {
      const fullFile = "alpha\nbeta\ngamma\n";
      const region = "beta";
      const c = await makeCandidate({
        fullFile,
        source: region,
        lineStart: 2,
        lineEnd: 2,
      });
      const out = buildUserPrompt(c, "demo");
      // Slice everything below the "Focus region source" heading and assert
      // the region content is the body of the fence; not the full file.
      const parts = out.split("## Focus region source");
      expect(parts).toHaveLength(2);
      const focusBlock = parts[1]!;
      expect(focusBlock).toContain("```java\n" + region + "\n```");
      // The focus block must NOT contain sibling lines from the full file;
      // those belong in the full-file section above.
      expect(focusBlock).not.toContain("alpha");
      expect(focusBlock).not.toContain("gamma");
    });

    it("emits the trailing schema-instruction line at the very end of the prompt", async () => {
      const c = await makeCandidate({});
      const out = buildUserPrompt(c, "demo");
      expect(out.trimEnd().endsWith("Document ONLY the focus region.")).toBe(
        true,
      );
    });
  });
});

describe("PROMPT_VERSION", () => {
  it("matches the v<integer> format the bump checklist documents (replay --since-version parses this)", () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/);
  });
});

/**
 * Pins SYSTEM_PROMPT contract surfaces. CI's source-file em-dash sweep
 * catches literal em dashes in checked-in source, but it cannot catch
 * the ABSENCE of the PUNCTUATION prohibition rule. The rule itself is
 * the only runtime defense against LLM-emitted em dashes in generated
 * docs; the renderer interpolates LLM string fields directly and the
 * validator does not scan output for em dashes. A refactor that drops
 * or paraphrases the rule (merge conflict, "tidy up the prompt" pass)
 * would silently regress every published page and only surface when a
 * design partner complained about em dashes back in their wiki.
 *
 * The schema-field presence test pins the second runtime contract:
 * the LLM emits a JSON object the client parses against UseCase. A
 * regression dropping a field name from the schema description (e.g.
 * the prompt drifts from "main_flow" to "steps" while UseCase still
 * keys on "main_flow") would silently produce empty pages with no
 * source-side test failure.
 */
describe("SYSTEM_PROMPT", () => {
  it("contains the explicit em-dash prohibition rule (the only runtime defense against LLM-emitted em dashes)", () => {
    expect(SYSTEM_PROMPT).toContain("PUNCTUATION");
    expect(SYSTEM_PROMPT).toContain("NEVER");
    expect(SYSTEM_PROMPT).toContain("em dash");
    expect(SYSTEM_PROMPT).toContain("U+2014");
  });

  it("itself contains no em dash (a prompt that forbids em dashes must not contain one)", () => {
    // U+2014 (em dash) referenced via JS escape so the source file is
    // literal-char-free per the strip-em-dashes CI rule.
    expect(SYSTEM_PROMPT).not.toContain("\u2014");
  });

  it("names every required UseCase schema field so the JSON parser at the client boundary has a field-by-field contract", () => {
    // Keep this list in sync with src/core/types.ts UseCase. A regression
    // dropping any field name from the schema block silently degrades
    // every page; the renderer renders whatever the LLM emits.
    const requiredFields = [
      "title",
      "actor",
      "summary",
      "trigger",
      "preconditions",
      "main_flow",
      "alternate_flows",
      "postconditions",
      "business_rules",
      "test_scenarios",
      "related",
      "tags",
      "confidence",
      "confidence_reason",
    ];
    for (const field of requiredFields) {
      expect(SYSTEM_PROMPT).toContain(field);
    }
  });

  it("retains the load-bearing reasoning-guide section headers (ACTOR, BLAST RADIUS, CRITICAL RULES, OUTPUT FORMAT)", () => {
    // Each header anchors a block the LLM relies on. ACTOR drives the
    // unauthenticated-visitor inference; BLAST RADIUS drives the
    // "for all sites" surfacing; CRITICAL RULES holds the non-em-dash
    // rule and several others; OUTPUT FORMAT pins the JSON-only output.
    expect(SYSTEM_PROMPT).toContain("CRITICAL RULES");
    expect(SYSTEM_PROMPT).toContain("ACTOR");
    expect(SYSTEM_PROMPT).toContain("BLAST RADIUS");
    expect(SYSTEM_PROMPT).toContain("OUTPUT FORMAT");
  });

  it("mentions every COMPLIANCE_NOTE_PREFIXES entry verbatim (parser-prompt-validator three-way contract)", () => {
    // The parser emits notes like "Sends email (ActionMailer)"; the prompt's
    // BLAST RADIUS section instructs the LLM to surface them as business
    // rules; the validator's NOTE_KEYWORDS map watches the LLM output for
    // the same prefixes and warns when a compliance signal silently drops.
    //
    // The three sides only stay in sync by convention. A future prompt
    // simplification that drops "Sends message to broker" from BLAST RADIUS
    // without also pruning NOTE_KEYWORDS would leave the validator warning
    // about un-surfaced notes the LLM was no longer instructed to surface,
    // and vice versa for a new validator category forgotten in the prompt.
    // This pin closes the loop by failing the build any time the prompt
    // and validator drift apart on the prefix list.
    //
    // Per-prefix assertion (not a single bulk match) so a regression names
    // exactly which category went missing.
    for (const prefix of COMPLIANCE_NOTE_PREFIXES) {
      expect(
        SYSTEM_PROMPT,
        `SYSTEM_PROMPT must mention compliance-note prefix "${prefix}" (validator's NOTE_KEYWORDS watches it; the prompt must instruct the LLM to surface it)`,
      ).toContain(prefix);
    }
  });
});
