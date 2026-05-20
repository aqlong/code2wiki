import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInit } from "./init.js";
import { defaultConfig } from "../../core/config.js";

/**
 * Pins the `code2wiki init` CLI contract. Four load-bearing surfaces only
 * surface live on a regression:
 *
 *   1. Refuses to overwrite an existing config, `fs.access(target)` success
 *      branch calls console.error + process.exit(1). A regression to
 *      overwrite would silently clobber a customer's hand-edited
 *      include/exclude/publish.<target> config on a second `init` run.
 *   2. On-disk payload matches `defaultConfig()` byte-for-byte AFTER
 *      `JSON.stringify(cfg, null, 2) + "\n"` framing, 2-space indent
 *      (humans edit this file) + trailing newline (matches the POSIX text-file
 *      convention git's diff/blame tools assume). A regression to
 *      `JSON.stringify(cfg)` would emit a one-line blob that's
 *      machine-friendly but undiff-able.
 *   3. Writes to `code2wiki.config.json` at cwd, NOT to
 *      `.code2wiki/config.json`, loadConfig accepts both, but init seeds the
 *      visible-at-root form so a new operator can find + edit it.
 *   4. Success path emits BOTH `Wrote <target>` AND the next-step hint
 *      `Next: run \`code2wiki list\` to see candidates.`, the hint is the
 *      onboarding handoff to the operator's first real action; a regression
 *      dropping it strands first-time users.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-init-"));
});

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureConsole(): { log: string[]; error: string[] } {
  const log: string[] = [];
  const error: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => {
    log.push(s);
  });
  vi.spyOn(console, "error").mockImplementation((s: string) => {
    error.push(s);
  });
  return { log, error };
}

function spyExit(): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(process, "exit")
    .mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${String(code ?? 0)}`);
    });
}

describe("runInit fresh-project happy path", () => {
  it("writes code2wiki.config.json at the cwd root (not under .code2wiki/)", async () => {
    captureConsole();
    await runInit({ cwd: dir });
    // Root-level file MUST exist; the hidden-dir form is loadConfig's
    // secondary slot, not init's seed location.
    await expect(
      fs.access(path.join(dir, "code2wiki.config.json")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(dir, ".code2wiki", "config.json")),
    ).rejects.toThrow();
  });

  it("emits the success line with the absolute target path", async () => {
    const { log } = captureConsole();
    await runInit({ cwd: dir });
    // The path printed is the SAME path the file lives at, operators
    // grep this output to confirm where init landed (e.g. when cwd
    // surprises them in a monorepo).
    const target = path.join(dir, "code2wiki.config.json");
    expect(log).toContain(`Wrote ${target}`);
  });

  it("emits the next-step hint verbatim", async () => {
    const { log } = captureConsole();
    await runInit({ cwd: dir });
    // Onboarding handoff: the only forward-pointer a first-time user
    // gets after init. Pinning the full sentence catches a "polish"
    // rewrite that drops the `code2wiki list` reference.
    expect(log).toContain("Next: run `code2wiki list` to see candidates.");
  });

  it("emits success + hint in order (Wrote line first)", async () => {
    const { log } = captureConsole();
    await runInit({ cwd: dir });
    const wroteIdx = log.findIndex((s) => s.startsWith("Wrote "));
    const hintIdx = log.findIndex((s) => s.startsWith("Next: "));
    expect(wroteIdx).toBeGreaterThanOrEqual(0);
    expect(hintIdx).toBeGreaterThan(wroteIdx);
  });

  it("does NOT print to console.error on success", async () => {
    const { error } = captureConsole();
    await runInit({ cwd: dir });
    // Channel discipline: stdout for normal, stderr for failure. A
    // regression routing the success line through console.error would
    // break operator scripts that pipe stderr to a log file expecting
    // only failures.
    expect(error).toEqual([]);
  });

  it("does NOT call process.exit on success", async () => {
    captureConsole();
    const exitSpy = spyExit();
    await runInit({ cwd: dir });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("runInit payload shape", () => {
  it("writes parseable JSON matching defaultConfig() field-for-field", async () => {
    captureConsole();
    await runInit({ cwd: dir });
    const raw = await fs.readFile(
      path.join(dir, "code2wiki.config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    // Pinning the seed-shape contract: a future regression that changes
    // defaultConfig() without bumping init's expected output would fail
    // here, forcing the contributor to update the test AND the field.
    expect(parsed).toEqual(defaultConfig());
  });

  it("uses 2-space indent for human-editability (NOT a single-line blob)", async () => {
    captureConsole();
    await runInit({ cwd: dir });
    const raw = await fs.readFile(
      path.join(dir, "code2wiki.config.json"),
      "utf-8",
    );
    // 2-space indent contract: `{\n  "include": [\n    "**/*.java",\n ...`.
    // Loose match, `"include"` on its own line indented with exactly 2
    // spaces, catches regressions to 4-space, tab, or no-indent.
    expect(raw).toContain('\n  "include": [');
    expect(raw).toContain('\n    "**/*.java"');
  });

  it("ends with a trailing newline (POSIX text-file convention)", async () => {
    captureConsole();
    await runInit({ cwd: dir });
    const raw = await fs.readFile(
      path.join(dir, "code2wiki.config.json"),
      "utf-8",
    );
    // Trailing-newline contract per `+ "\n"`. Many tools (git diff,
    // POSIX `wc -l`, editor "no newline at EOF" warnings) key off this;
    // a regression dropping it produces noisy first edits.
    expect(raw.endsWith("\n")).toBe(true);
    // And not a DOUBLE newline.
    expect(raw.endsWith("\n\n")).toBe(false);
  });

  it("preserves the populated include/exclude/output/model defaults", async () => {
    captureConsole();
    await runInit({ cwd: dir });
    const raw = await fs.readFile(
      path.join(dir, "code2wiki.config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as ReturnType<typeof defaultConfig>;
    // Sanity-check the four most operator-visible defaults survive the
    // round-trip through JSON.stringify + JSON.parse + ConfigSchema.
    // Regression guard against an accidental schema change that drops
    // a default (e.g. a `.optional()` without `.default(...)`).
    expect(parsed.include).toContain("**/*.cfc");
    expect(parsed.include).toContain("**/*.java");
    expect(parsed.exclude).toContain("**/node_modules/**");
    expect(parsed.output).toBe("./docs/use-cases");
    expect(parsed.model).toMatch(/^claude-/);
  });
});

describe("runInit already-exists guard", () => {
  it("aborts with console.error + exit(1) when code2wiki.config.json already exists", async () => {
    const existing = '{"include": ["custom/**"]}';
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      existing,
      "utf-8",
    );
    const { error } = captureConsole();
    const exitSpy = spyExit();
    // process.exit is mocked to throw so we can assert it fired AND the
    // function unwound before the writeFile call.
    await expect(runInit({ cwd: dir })).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const target = path.join(dir, "code2wiki.config.json");
    expect(error).toContain(`code2wiki.config.json already exists at ${target}`);
  });

  it("does NOT overwrite an existing config (preserves user edits byte-for-byte)", async () => {
    const existing = '{"include": ["custom/**"]}';
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      existing,
      "utf-8",
    );
    captureConsole();
    spyExit();
    // Will throw on the mocked exit, swallow so we can inspect the file.
    await runInit({ cwd: dir }).catch(() => {});
    const after = await fs.readFile(
      path.join(dir, "code2wiki.config.json"),
      "utf-8",
    );
    // Idempotency: customer's hand-edited config survives a second
    // `init` invocation. A regression that overwrites would silently
    // wipe their include/exclude/publish.<target> customizations.
    expect(after).toBe(existing);
  });

  it("does NOT emit the success log lines when aborting on existing config", async () => {
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      "{}",
      "utf-8",
    );
    const { log } = captureConsole();
    spyExit();
    await runInit({ cwd: dir }).catch(() => {});
    // No "Wrote …" / "Next: …" leakage on the abort path, a regression
    // that runs the success block AFTER calling process.exit (which is
    // mocked to throw in tests but does NOT abort in real Node until
    // the event loop drains) would surface here.
    expect(log.some((s) => s.startsWith("Wrote "))).toBe(false);
    expect(log.some((s) => s.startsWith("Next: "))).toBe(false);
  });

  it("ignores a .code2wiki/config.json (only the root file blocks init)", async () => {
    // The hidden-dir form is loadConfig's secondary slot. init only
    // checks the visible root file, so a project that adopted the
    // hidden form previously can still run `init` to seed the
    // canonical root location.
    await fs.mkdir(path.join(dir, ".code2wiki"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".code2wiki", "config.json"),
      "{}",
      "utf-8",
    );
    const { log } = captureConsole();
    const exitSpy = spyExit();
    await runInit({ cwd: dir });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(
      log.some((s) => s.startsWith("Wrote ")),
    ).toBe(true);
    // The hidden file is untouched.
    const hidden = await fs.readFile(
      path.join(dir, ".code2wiki", "config.json"),
      "utf-8",
    );
    expect(hidden).toBe("{}");
  });
});
