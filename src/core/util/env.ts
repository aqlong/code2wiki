import fs from "node:fs";
import path from "node:path";

/**
 * Tolerant .env loader. Node's built-in --env-file is strict; this handles:
 *   - `export FOO=bar` (shell-style)
 *   - `FOO="bar"` and `FOO='bar'` (quoted)
 *   - `FOO=bar # comment` (trailing comments)
 *   - blank lines and `# comment` lines
 *
 * Does NOT overwrite already-set environment variables.
 */
export function loadEnvFile(filepath: string): { loaded: number; skipped: number; lineDiagnostics: string[] } {
  if (!fs.existsSync(filepath)) return { loaded: 0, skipped: 0, lineDiagnostics: [] };
  let raw = fs.readFileSync(filepath, "utf-8");
  // Strip UTF-8 BOM if present (﻿)
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let loaded = 0;
  let skipped = 0;
  const lineDiagnostics: string[] = [];
  let lineNo = 0;
  for (const rawLine of raw.split(/\r?\n/)) {
    lineNo++;
    // Strip a leading BOM that snuck onto a non-first line, just in case.
    const line = rawLine.replace(/^﻿/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) {
      // Diagnostic that does not leak the value: just length + whether '='
      // is present and where.
      const eqIdx = trimmed.indexOf("=");
      lineDiagnostics.push(
        `line ${lineNo}: length=${trimmed.length}, has '='=${
          eqIdx >= 0 ? `yes@${eqIdx}` : "no"
        }, first-char-code=${trimmed.charCodeAt(0)}`,
      );
      continue;
    }
    const key = match[1]!;
    let value = match[2] ?? "";
    const quote = value[0];
    // lastIndexOf finds the closing quote: it matches the previous
    // end-anchored strip when the quote is the final character, and it
    // also handles a trailing inline comment after the value
    // (`KEY="val" # note`), which the old quoted branch left intact.
    const closeIdx =
      quote === '"' || quote === "'" ? value.lastIndexOf(quote) : -1;
    if (closeIdx > 0) {
      // Properly quoted value. Strip the outer quotes; anything after the
      // closing quote (whitespace, an inline comment) is not part of it.
      value = value.slice(1, closeIdx);
    } else {
      // Unquoted (or a lone dangling quote): strip a trailing inline
      // comment outside any quote, then surrounding whitespace.
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx);
      value = value.trim();
    }
    // Overwrite empty/unset values; keep non-empty pre-existing values intact.
    if (!process.env[key]) {
      process.env[key] = value;
      loaded++;
    } else {
      skipped++;
    }
  }
  return { loaded, skipped, lineDiagnostics };
}

/** Try to load .env from a sequence of likely locations. */
export function loadProjectEnv(cwd: string): void {
  for (const name of [".env.local", ".env"]) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) {
      loadEnvFile(p);
      return;
    }
  }
}
