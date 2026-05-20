/**
 * Pandoc/GFM-style footnote handling for the publisher renderers.
 *
 * The LLM frequently emits markdown footnotes using the syntax:
 *
 *   Step one references the auth check. [^step1]
 *   [^step1]: Lines 42-47
 *
 * Neither `marked` (Confluence path) nor our line-based
 * `markdownToNotionBlocks` (Notion path) handle this natively, so
 * unprocessed text bleeds through as literal `[^step1]` in published
 * pages. This transform normalises the input to plain markdown that
 * BOTH renderers handle correctly:
 *
 * - Inline references `[^id]` become `[N]` plain text (sequential by
 *   first mention). Plain `[N]` is readable in Confluence body text and
 *   in Notion paragraphs without needing platform-specific superscript
 *   support (Notion's rich_text has no superscript annotation; HTML
 *   `<sup>` would survive marked → Confluence but appear as literal
 *   `<sup>[1]</sup>` in Notion).
 *
 * - Definition lines `[^id]: content` are stripped from where they
 *   originally appear and collected into a `## Footnotes` section at
 *   the very end of the document, formatted as a numbered list.
 *
 * - Footnote IDs are case-sensitive and may contain alphanumerics,
 *   underscores, or hyphens (matches Pandoc behaviour).
 *
 * No-op when the input contains no footnote-shaped tokens.
 */

const REF_RE = /\[\^([A-Za-z0-9_-]+)\]/g;
const DEF_LINE_RE = /^\[\^([A-Za-z0-9_-]+)\]:\s*(.+)$/;

export function transformFootnotes(markdown: string): string {
  const lines = markdown.split("\n");

  // Pass 1: extract definitions in document order (last-write-wins on
  // duplicate ids; mirrors Pandoc's behaviour). Keep their line indices
  // so we can drop them in pass 3.
  const defContent = new Map<string, string>();
  const defLineIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const m = DEF_LINE_RE.exec(lines[i]!);
    if (m) {
      defContent.set(m[1]!, m[2]!.trim());
      defLineIndices.add(i);
    }
  }
  if (defContent.size === 0) return markdown;

  // Pass 2: scan only the body (excluding definition lines) for inline
  // references in first-mention order. This is the user-visible numbering.
  const idToNum = new Map<string, number>();
  let counter = 1;
  for (let i = 0; i < lines.length; i++) {
    if (defLineIndices.has(i)) continue;
    const line = lines[i]!;
    REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REF_RE.exec(line)) !== null) {
      const id = m[1]!;
      if (!idToNum.has(id) && defContent.has(id)) {
        idToNum.set(id, counter++);
      }
    }
  }
  // Definitions that exist but are never referenced still get a slot at
  // the end so the operator notices the dangling definition.
  for (const id of defContent.keys()) {
    if (!idToNum.has(id)) idToNum.set(id, counter++);
  }

  // Pass 3: emit body with refs replaced and definition lines removed.
  const bodyLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (defLineIndices.has(i)) continue;
    const replaced = lines[i]!.replace(REF_RE, (raw, id: string) => {
      const n = idToNum.get(id);
      return n === undefined ? raw : `[${n}]`;
    });
    bodyLines.push(replaced);
  }
  // Trim trailing blank lines so the appended Footnotes section sits
  // cleanly. Then append the section.
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.trim() === "") {
    bodyLines.pop();
  }

  const sortedIds = Array.from(idToNum.entries()).sort(
    (a, b) => a[1] - b[1],
  );
  const footnoteLines: string[] = ["", "", "## Footnotes", ""];
  for (const [id, n] of sortedIds) {
    const content = defContent.get(id) ?? "(missing definition)";
    footnoteLines.push(`${n}. ${content}`);
  }

  return bodyLines.join("\n") + footnoteLines.join("\n") + "\n";
}
