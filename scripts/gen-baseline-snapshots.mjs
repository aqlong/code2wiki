#!/usr/bin/env -S npx tsx
// Regenerate baseline.snapshot.json for every examples/<name>/expected.md.
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
for (const name of dirs) {
  const expected = join(examplesDir, name, "expected.md");
  if (!existsSync(expected)) continue;
  const text = readFileSync(expected, "utf8");
  const snap = computeMarkdownSnapshot(text);
  const out = join(examplesDir, name, "baseline.snapshot.json");
  writeFileSync(out, JSON.stringify(snap, null, 2) + "\n");
  console.log(
    `wrote ${out}  (${snap.sections.length} sections, body ${snap.bodyLineCount} lines)`,
  );
  wrote++;
}
console.log(`\n${wrote} baseline(s) written.`);
