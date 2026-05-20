import { describe, expect, it } from "vitest";
import { transformFootnotes } from "./footnotes.js";

describe("transformFootnotes", () => {
  it("is a no-op when the input has no footnote tokens", () => {
    const input = "# Title\n\nJust plain text.\n";
    expect(transformFootnotes(input)).toBe(input);
  });

  it("renumbers refs to sequential integers in first-mention order", () => {
    const input = [
      "First reference [^bravo] then second [^alpha] then bravo again [^bravo].",
      "[^alpha]: A def",
      "[^bravo]: B def",
    ].join("\n");
    const out = transformFootnotes(input);
    // bravo appears first → [1], alpha second → [2]
    expect(out).toContain("First reference [1] then second [2] then bravo again [1].");
  });

  it("strips definition lines from their original location", () => {
    const input = [
      "Some text [^x].",
      "[^x]: definition body",
      "More text.",
    ].join("\n");
    const out = transformFootnotes(input);
    expect(out).not.toContain("[^x]:");
    expect(out).toContain("Some text [1].");
    expect(out).toContain("More text.");
  });

  it("appends a Footnotes section in number order at the end", () => {
    const input = [
      "Para [^a] and [^b].",
      "[^a]: alpha",
      "[^b]: bravo",
    ].join("\n");
    const out = transformFootnotes(input);
    expect(out).toMatch(/## Footnotes\n+1\. alpha\n2\. bravo\n$/);
  });

  it("keeps dangling references unchanged (no matching definition)", () => {
    const input = "Mentions [^unknown] but defines [^known].\n[^known]: real";
    const out = transformFootnotes(input);
    // [^unknown] stays literal because there's no def to attach a number to.
    expect(out).toContain("[^unknown]");
    expect(out).toContain("[1]"); // known got number 1
  });

  it("includes orphan definitions (defined, never referenced) at the bottom", () => {
    const input = "No references here.\n[^orphan]: still defined";
    const out = transformFootnotes(input);
    expect(out).toContain("## Footnotes");
    expect(out).toContain("1. still defined");
  });

  it("preserves the body's original line structure (paragraphs, lists)", () => {
    const input = [
      "# Title",
      "",
      "Para one [^a].",
      "",
      "- bullet [^b]",
      "- another",
      "",
      "[^a]: alpha def",
      "[^b]: bravo def",
    ].join("\n");
    const out = transformFootnotes(input);
    // Heading and bullets preserved.
    expect(out).toContain("# Title");
    expect(out).toMatch(/- bullet \[2\]/);
    expect(out).toMatch(/- another/);
  });

  it("handles ids with letters, digits, underscores, and hyphens", () => {
    const input = "Ref [^step_1] and [^rule-2a].\n[^step_1]: a\n[^rule-2a]: b";
    const out = transformFootnotes(input);
    expect(out).toContain("Ref [1] and [2].");
    expect(out).toContain("1. a");
    expect(out).toContain("2. b");
  });

  it("is idempotent on input that contains no footnote refs and has Footnotes section pre-rendered", () => {
    const input = "Body.\n\n## Footnotes\n\n1. existing\n";
    // No `[^...]` tokens, so transform should leave it as-is.
    expect(transformFootnotes(input)).toBe(input);
  });

  it("is a no-op when refs are present but no definitions are (all-orphan refs)", () => {
    // Pins the `defContent.size === 0` short-circuit. A regression dropping
    // that early return would fall into the rewrite path and emit a
    // `## Footnotes` section with zero entries, producing an empty section
    // header at the end of every page that uses ref syntax without defs.
    const input = "First ref [^a] then [^b] and a third [^c].\n";
    expect(transformFootnotes(input)).toBe(input);
  });

  it("last-write-wins on duplicate definition ids (Pandoc parity)", () => {
    // Pins the documented "last-write-wins on duplicate ids" contract at
    // footnotes.ts:46. A regression flipping to first-write-wins or
    // throw-on-duplicate would silently change what BAs see in published
    // pages when the LLM emits two `[^x]:` lines (rare but observed).
    const input = [
      "Reference [^x] once.",
      "[^x]: first definition",
      "[^x]: second definition",
    ].join("\n");
    const out = transformFootnotes(input);
    expect(out).toContain("1. second definition");
    expect(out).not.toContain("first definition");
  });

  it("strips trailing blank lines from the body before the Footnotes section", () => {
    // Pins lines 86-88 (the body-trim loop). A regression dropping the
    // trim would yield 4+ blank lines between body and `## Footnotes` on
    // every page with a footnoted final paragraph (LLM emits a trailing
    // blank after the last body line), shifting BA-edit-back inlineDiffSize
    // and degrading the calibrator's noise floor.
    const input = [
      "Para [^a].",
      "",
      "",
      "",
      "[^a]: alpha",
    ].join("\n");
    const out = transformFootnotes(input);
    // Body line is followed by exactly one blank line (two consecutive \n)
    // before `## Footnotes`. Three trailing blanks in the input were stripped;
    // without the trim, four-plus consecutive \n would land between body and
    // heading on every page with a footnoted final paragraph.
    expect(out).toMatch(/^Para \[1\]\.\n\n## Footnotes\n\n1\. alpha\n$/);
  });
});
