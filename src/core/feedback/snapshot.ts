import { createHash } from "node:crypto";
import matter from "gray-matter";

const FENCE_RE =
  /<!--\s*code2wiki:managed:start[^>]*-->([\s\S]*?)<!--\s*code2wiki:managed:end\s*-->/;

const SECTION_RE = /^##\s+(.+?)\s*$/gm;

/**
 * Structural fingerprint of a generated use-case Markdown page. Computed from
 * pure stdlib + string diff so the same input always produces the same
 * snapshot, with no LLM in the loop. The body and managed-fence hashes are
 * separated because the fence carries a timestamp + commit sha that change on
 * every regeneration; hashing them together would make the snapshot unstable
 * across runs that produced semantically identical output.
 *
 * Building block for the `examples/` self-test (docs/self-learning.md, signal
 * source #2). A future iteration consumes this from a baseline.snapshot.json
 * sitting next to expected.md and asserts no drift.
 */
export interface MarkdownSnapshot {
  contentHash: string;
  managedBlockHash: string;
  frontmatterKeys: string[];
  sections: string[];
  bodyLineCount: number;
}

export function computeMarkdownSnapshot(text: string): MarkdownSnapshot {
  const parsed = matter(text);
  const frontmatterKeys = Object.keys(parsed.data).sort();

  const fenceMatch = parsed.content.match(FENCE_RE);
  const managedBody = fenceMatch ? fenceMatch[1].trim() : "";
  const bodyWithoutFence = parsed.content.replace(FENCE_RE, "").trim();

  const sections = Array.from(bodyWithoutFence.matchAll(SECTION_RE)).map((m) =>
    m[1].trim(),
  );

  const bodyLineCount = bodyWithoutFence
    ? bodyWithoutFence.split("\n").length
    : 0;

  return {
    contentHash: sha256(bodyWithoutFence),
    managedBlockHash: sha256(managedBody),
    frontmatterKeys,
    sections,
    bodyLineCount,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
