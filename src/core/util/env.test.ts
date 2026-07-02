import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile, loadProjectEnv } from "./env.js";

/**
 * Pins the ADR-012 contract for the tolerant .env loader. The four
 * load-bearing behaviors that diverge from Node's --env-file:
 *   1. Strips a leading UTF-8 BOM (some Windows-edited files start with one).
 *   2. Accepts shell-style `export FOO=bar`.
 *   3. Strips surrounding quotes and trailing inline comments outside quotes.
 *   4. Overwrites empty-string env vars (treated as "not really set"),
 *      while preserving any non-empty pre-existing value.
 *
 * Tests write small files to a per-test tmpdir; each case uses fresh
 * key names so cross-test process.env state can't leak.
 */

const TEST_KEYS = [
  "C2W_ENV_TEST_A",
  "C2W_ENV_TEST_B",
  "C2W_ENV_TEST_C",
  "C2W_ENV_TEST_D",
  "C2W_ENV_TEST_E",
  "C2W_ENV_TEST_F",
  "C2W_ENV_TEST_G",
  "C2W_ENV_TEST_H",
  "C2W_ENV_TEST_I",
  "C2W_ENV_TEST_J",
  "C2W_ENV_TEST_K",
];

let tmpDir: string;

function tmpEnvFile(contents: string, name = ".env"): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, contents);
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2w-env-test-"));
  for (const key of TEST_KEYS) delete process.env[key];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const key of TEST_KEYS) delete process.env[key];
});

describe("loadEnvFile", () => {
  it("returns zero counts when the file does not exist", () => {
    const result = loadEnvFile(path.join(tmpDir, "does-not-exist.env"));
    expect(result).toEqual({ loaded: 0, skipped: 0, lineDiagnostics: [] });
  });

  it("loads a plain KEY=value line", () => {
    const file = tmpEnvFile("C2W_ENV_TEST_A=plain\n");
    const result = loadEnvFile(file);
    expect(result.loaded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("plain");
  });

  it("accepts shell-style `export KEY=value`", () => {
    const file = tmpEnvFile("export C2W_ENV_TEST_A=shellstyle\n");
    loadEnvFile(file);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("shellstyle");
  });

  it("strips surrounding double quotes", () => {
    const file = tmpEnvFile('C2W_ENV_TEST_A="quoted value"\n');
    loadEnvFile(file);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("quoted value");
  });

  it("strips surrounding single quotes", () => {
    const file = tmpEnvFile("C2W_ENV_TEST_A='quoted value'\n");
    loadEnvFile(file);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("quoted value");
  });

  it("strips a trailing inline comment when value is unquoted", () => {
    const file = tmpEnvFile("C2W_ENV_TEST_A=val # trailing comment\n");
    loadEnvFile(file);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("val");
  });

  it("preserves '#' inside a quoted value (does NOT treat as comment)", () => {
    const file = tmpEnvFile('C2W_ENV_TEST_A="val # not a comment"\n');
    loadEnvFile(file);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("val # not a comment");
  });

  it("strips a trailing inline comment after a double-quoted value", () => {
    const file = tmpEnvFile('C2W_ENV_TEST_A="secret" # my token\n');
    loadEnvFile(file);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("secret");
  });

  it("strips a trailing inline comment after a single-quoted value", () => {
    const file = tmpEnvFile("C2W_ENV_TEST_A='secret' # my token\n");
    loadEnvFile(file);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("secret");
  });

  it("leaves a lone unterminated opening quote intact (malformed input)", () => {
    const file = tmpEnvFile('C2W_ENV_TEST_A="unterminated\n');
    loadEnvFile(file);
    expect(process.env["C2W_ENV_TEST_A"]).toBe('"unterminated');
  });

  it("ignores blank lines and full-line comments", () => {
    const file = tmpEnvFile(
      [
        "# top comment",
        "",
        "C2W_ENV_TEST_A=ok",
        "   ",
        "# trailing comment",
      ].join("\n") + "\n",
    );
    const result = loadEnvFile(file);
    expect(result.loaded).toBe(1);
    expect(result.lineDiagnostics).toHaveLength(0);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("ok");
  });

  it("strips a leading UTF-8 BOM (\\uFEFF) so the first line still parses", () => {
    const file = tmpEnvFile("﻿C2W_ENV_TEST_A=after-bom\n");
    const result = loadEnvFile(file);
    expect(result.lineDiagnostics).toEqual([]);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("after-bom");
  });

  it("overwrites an empty-string pre-existing env var (ADR-012 divergence from --env-file)", () => {
    process.env["C2W_ENV_TEST_A"] = "";
    const file = tmpEnvFile("C2W_ENV_TEST_A=from-file\n");
    const result = loadEnvFile(file);
    expect(result.loaded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("from-file");
  });

  it("preserves a non-empty pre-existing env var (skipped++, not overwritten)", () => {
    process.env["C2W_ENV_TEST_A"] = "from-shell";
    const file = tmpEnvFile("C2W_ENV_TEST_A=from-file\n");
    const result = loadEnvFile(file);
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("from-shell");
  });

  it("emits a value-redacted lineDiagnostic for malformed lines", () => {
    const file = tmpEnvFile("not a kv line\n");
    const result = loadEnvFile(file);
    expect(result.loaded).toBe(0);
    expect(result.lineDiagnostics).toHaveLength(1);
    const diag = result.lineDiagnostics[0]!;
    // Diagnostic must NOT leak the line value, only metadata.
    expect(diag).not.toContain("not a kv line");
    expect(diag).toMatch(/^line 1: length=\d+, has '='=no, first-char-code=\d+$/);
  });

  it("rejects digit-leading identifiers via lineDiagnostics (regex requires [A-Za-z_] start)", () => {
    const file = tmpEnvFile("9KEY=nope\n");
    const result = loadEnvFile(file);
    expect(result.loaded).toBe(0);
    expect(result.lineDiagnostics).toHaveLength(1);
    expect(result.lineDiagnostics[0]).toContain("has '='=yes@");
  });

  it("loads multiple keys in a single file and returns the right counts", () => {
    const file = tmpEnvFile(
      [
        "C2W_ENV_TEST_A=one",
        "C2W_ENV_TEST_B=two",
        "export C2W_ENV_TEST_C=three",
        'C2W_ENV_TEST_D="four"',
      ].join("\n") + "\n",
    );
    const result = loadEnvFile(file);
    expect(result.loaded).toBe(4);
    expect(result.skipped).toBe(0);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("one");
    expect(process.env["C2W_ENV_TEST_B"]).toBe("two");
    expect(process.env["C2W_ENV_TEST_C"]).toBe("three");
    expect(process.env["C2W_ENV_TEST_D"]).toBe("four");
  });

  it("trims trailing whitespace from unquoted values", () => {
    const file = tmpEnvFile("C2W_ENV_TEST_A=value-with-trailing-space   \n");
    loadEnvFile(file);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("value-with-trailing-space");
  });

  it("handles CRLF line endings (Windows-edited files)", () => {
    const file = tmpEnvFile("C2W_ENV_TEST_A=one\r\nC2W_ENV_TEST_B=two\r\n");
    const result = loadEnvFile(file);
    expect(result.loaded).toBe(2);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("one");
    expect(process.env["C2W_ENV_TEST_B"]).toBe("two");
  });

  it("treats an empty value (KEY=) as the empty string, not a parse error", () => {
    const file = tmpEnvFile("C2W_ENV_TEST_A=\n");
    const result = loadEnvFile(file);
    expect(result.loaded).toBe(1);
    expect(result.lineDiagnostics).toEqual([]);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("");
  });
});

describe("loadProjectEnv", () => {
  it("prefers .env.local over .env when both exist (only one file is loaded)", () => {
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "C2W_ENV_TEST_A=from-local\n");
    fs.writeFileSync(path.join(tmpDir, ".env"), "C2W_ENV_TEST_A=from-env\n");
    loadProjectEnv(tmpDir);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("from-local");
  });

  it("falls back to .env when .env.local is absent", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "C2W_ENV_TEST_A=from-env\n");
    loadProjectEnv(tmpDir);
    expect(process.env["C2W_ENV_TEST_A"]).toBe("from-env");
  });

  it("is a no-op when neither file exists", () => {
    loadProjectEnv(tmpDir);
    expect(process.env["C2W_ENV_TEST_A"]).toBeUndefined();
  });
});
