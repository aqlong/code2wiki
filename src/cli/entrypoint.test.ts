import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./index.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression guard for the Windows entrypoint bug (fix/windows-entrypoint-guard).
 *
 * Symptom: `code2wiki <cmd>` installed globally on Windows silently exited 0
 * doing nothing. Root cause: the bottom-of-file guard that decides whether the
 * module was run directly (vs imported by a test) compared
 * `process.argv[1].endsWith("cli/index.js")` with a FORWARD slash. Node sets
 * process.argv[1] to an absolute path using the OS separator, so on Windows it
 * is `C:\...\dist\cli\index.js` (backslashes) and the check was always false ->
 * parseAsync never ran -> 100% of Windows invocations no-oped.
 *
 * `isCliEntrypoint` now normalizes separators before the suffix check. The unit
 * tests below pin the exact bug (a backslash path must be recognized), and the
 * subprocess smoke test proves the guard is actually wired to argv[1] end to
 * end by running the real CLI as a child process (argv[1] is a backslash path
 * on Windows, so this whole test would fail under the old guard).
 */
describe("isCliEntrypoint", () => {
  it("recognizes a Windows backslash path to the built CLI (the regression)", () => {
    expect(isCliEntrypoint("C:\\Users\\me\\code2wiki\\dist\\cli\\index.js")).toBe(
      true,
    );
  });

  it("recognizes a POSIX forward-slash path to the built CLI", () => {
    expect(isCliEntrypoint("/home/me/code2wiki/dist/cli/index.js")).toBe(true);
  });

  it("recognizes the .ts source entrypoint under tsx (both separators)", () => {
    expect(isCliEntrypoint("C:\\repo\\src\\cli\\index.ts")).toBe(true);
    expect(isCliEntrypoint("/repo/src/cli/index.ts")).toBe(true);
  });

  it("returns false for an unrelated script path", () => {
    expect(isCliEntrypoint("C:\\repo\\node_modules\\vitest\\dist\\cli.js")).toBe(
      false,
    );
    expect(isCliEntrypoint("/usr/local/bin/some-other-tool")).toBe(false);
  });

  it("returns false when argv[1] is undefined (imported as a module)", () => {
    expect(isCliEntrypoint(undefined)).toBe(false);
  });

  it("does not match a directory or partial name that merely contains the suffix", () => {
    // A path ending in `.../cli/index.json` or `.../cli/index.jsx` must not
    // pass; the suffix check is anchored to the exact .js / .ts extensions.
    expect(isCliEntrypoint("/repo/src/cli/index.json")).toBe(false);
    expect(isCliEntrypoint("/repo/src/cli/index.jsx")).toBe(false);
  });
});

describe("CLI entrypoint (subprocess smoke)", () => {
  // Repo root is two levels up from src/cli/. Running from here lets Node
  // resolve the `tsx` loader from the repo's node_modules.
  const repoRoot = path.resolve(__dirname, "..", "..");
  const indexTs = path.join(repoRoot, "src", "cli", "index.ts");

  it("prints the version when run directly (guard fires on this OS's argv[1])", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", indexTs, "--version"],
      { cwd: repoRoot },
    );
    expect(stdout.trim()).toBe("0.1.0");
  });

  it("prints usage/help when run directly", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", indexTs, "--help"],
      { cwd: repoRoot },
    );
    expect(stdout).toContain("Usage: code2wiki");
    expect(stdout).toContain("generate");
  });
});
