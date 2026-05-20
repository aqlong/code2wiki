import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

// Regression guard for the CLAUDE.md code-style rule: no em dashes
// (U+2014) in any authored TypeScript file under src/.
//
// The CI pipeline also runs `python3 tools/scripts/strip-em-dashes.py
// --check` (covering .md files too), but that step runs AFTER all unit
// tests, and the Python script has a regex edge case where em dashes
// between two backtick-quoted identifiers in a comment are silently
// skipped (the script's inline-code-span splitter treats the segment
// between adjacent backticks as a code span). Running the check here
// means `npm test` catches violations immediately, before the developer
// pushes. Background: em dashes in test comments have caused 5+
// consecutive red CI runs (see commit ab585e3 and the audit preceding
// it).
//
// Scope: src/**/*.ts only. tools/ contains ocean-bot files that have
// em dashes in intentional log-message template literals; those are
// tracked separately via the Python CI check and direct cleanup. The
// violations that actually blocked CI all lived in src/.
//
// The character is referenced via a codepoint call so this file does
// not contain the literal character and cannot trip its own check.

const EM_DASH = String.fromCodePoint(0x2014);

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

describe("em-dash hygiene", () => {
  it("no src/**/*.ts file contains U+2014 (run strip-em-dashes.py to fix)", async () => {
    const files = await fg(["src/**/*.ts"], {
      cwd: REPO_ROOT,
      ignore: ["**/node_modules/**", "**/dist/**"],
      absolute: true,
    });

    const violations: string[] = [];
    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      if (content.includes(EM_DASH)) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(
      violations,
      violations.length > 0
        ? `Em dash found in ${violations.length} file(s):\n  ${violations.join("\n  ")}\nFix: python3 tools/scripts/strip-em-dashes.py`
        : "",
    ).toEqual([]);
  });
});
