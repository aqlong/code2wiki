#!/usr/bin/env -S npx tsx
// Regenerate baseline*.snapshot.json for every examples/<name>/expected*.md.
// Covers the primary expected.md and any additional expected-<variant>.md files
// (e.g. expected-edit-post.md, expected-delete-post.md in the Django example).
// Run after intentional spec changes to a hand-curated example.
import { computeMarkdownSnapshot } from "../src/core/feedback/snapshot.ts";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const examplesDir = new URL("../examples/", import.meta.url).pathname;

const dirs = readdirSync(examplesDir).filter((name) => {
  const p = join(examplesDir, name);
  return statSync(p).isDirectory();
});

let wrote = 0;
for (const dirName of dirs) {
  const dirPath = join(examplesDir, dirName);
  const expectedFiles = readdirSync(dirPath).filter((f) =>
    /^expected.*\.md$/.test(f),
  );
  for (const expectedFile of expectedFiles) {
    const expectedPath = join(dirPath, expectedFile);
    const baselineFile = expectedFile
      .replace(/^expected/, "baseline")
      .replace(/\.md$/, ".snapshot.json");
    const baselinePath = join(dirPath, baselineFile);
    const text = readFileSync(expectedPath, "utf8");
    const snap = computeMarkdownSnapshot(text);
    writeFileSync(baselinePath, JSON.stringify(snap, null, 2) + "\n");
    console.log(
      `wrote ${baselinePath}  (${snap.sections.length} sections, body ${snap.bodyLineCount} lines)`,
    );
    wrote++;
  }
}
console.log(`\n${wrote} baseline(s) written.`);
