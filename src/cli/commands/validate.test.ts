import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runValidate } from "./validate.js";

/**
 * Pins the `code2wiki validate` CLI contract. Three load-bearing surfaces only
 * surface live on a regression:
 *
 *   1. process.exit(1) on ANY failure (invalid config OR malformed
 *      frontmatter OR non-ENOENT readdir error). CI pre-commit hooks + the
 *      hosted-dashboard onboarding gate use validate's exit code; a
 *      regression collapsing exit 1 → 0 would silently let a customer ship a
 *      doc set whose pages won't upsert (publishers key off code2wiki_id /
 *      slug / title).
 *   2. ENOENT-on-output-dir is SILENT (first-run UX, no docs yet means no
 *      complaint), but ANY other error (ENOTDIR, EACCES) MUST be reported +
 *      flip failed=true. Conflating the two would either nag first-time
 *      users or silently swallow a corrupt output tree.
 *   3. Three required frontmatter fields, code2wiki_id, title, slug,
 *      checked via truthy gate (empty string fails). code2wiki_id is the
 *      stable upsert key per CLAUDE.md "Key conventions"; slug is the URL
 *      form; title is human-visible. A regression dropping any of the three
 *      checks would let a publisher attempt an upsert against `undefined`,
 *      which both Confluence + Notion reject with non-obvious errors.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-validate-"));
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

async function writeMd(
  name: string,
  fm: Record<string, unknown>,
  body = "body\n",
): Promise<void> {
  const outDir = path.join(dir, "docs", "use-cases");
  await fs.mkdir(outDir, { recursive: true });
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "", body);
  await fs.writeFile(path.join(outDir, name), lines.join("\n"), "utf-8");
}

describe("runValidate config validation", () => {
  it("prints config-success + final All-checks-passed when no config file exists (defaults apply)", async () => {
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runValidate({ cwd: dir });
    expect(log).toContain("✓ Config loaded and validated");
    expect(log).toContain("All checks passed.");
    expect(error).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("reports a malformed-JSON config + exits 1 + suppresses the final success line", async () => {
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      "{not json at all",
      "utf-8",
    );
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await expect(runValidate({ cwd: dir })).rejects.toThrow(/exit:1/);
    expect(error.some((s) => /✗ Config invalid:.*code2wiki\.config\.json/.test(s))).toBe(
      true,
    );
    expect(log).not.toContain("✓ Config loaded and validated");
    expect(log).not.toContain("All checks passed.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("reports a schema-failing config (negative maxCandidates) + exits 1", async () => {
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ maxCandidates: -1 }),
      "utf-8",
    );
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await expect(runValidate({ cwd: dir })).rejects.toThrow(/exit:1/);
    expect(error.some((s) => /✗ Config invalid:/.test(s))).toBe(true);
    expect(log).not.toContain("All checks passed.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runValidate output-dir handling", () => {
  it("treats a missing output dir as ENOENT-silent (no error, success path runs)", async () => {
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runValidate({ cwd: dir });
    // No "Could not read output dir" error; no "no generated docs" log either
    // (the ENOENT branch is fully silent, different from the empty-dir case).
    expect(error).toEqual([]);
    expect(log.some((s) => /Could not read output dir/.test(s))).toBe(false);
    expect(log.some((s) => /no generated docs yet/.test(s))).toBe(false);
    expect(log).toContain("All checks passed.");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("reports a non-ENOENT readdir error (file-where-dir-expected) + exits 1", async () => {
    // Plant a regular FILE at docs/use-cases so fs.readdir errors with ENOTDIR
    // rather than ENOENT. Pins the err.code !== "ENOENT" branch.
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(dir, "docs", "use-cases"), "i am a file", "utf-8");
    const { error } = captureConsole();
    const exitSpy = spyExit();
    await expect(runValidate({ cwd: dir })).rejects.toThrow(/exit:1/);
    expect(error.some((s) => /✗ Could not read output dir:/.test(s))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints the no-generated-docs hint on an empty output dir + still ends in success", async () => {
    await fs.mkdir(path.join(dir, "docs", "use-cases"), { recursive: true });
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runValidate({ cwd: dir });
    expect(log.some((s) => /no generated docs yet under/.test(s))).toBe(true);
    expect(log).toContain("All checks passed.");
    expect(error).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("filters non-.md files out before the frontmatter loop (treats dir-of-only-txt as empty)", async () => {
    const outDir = path.join(dir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "notes.txt"), "ignored", "utf-8");
    await fs.writeFile(path.join(outDir, "data.json"), "{}", "utf-8");
    await fs.writeFile(path.join(outDir, "readme"), "no extension", "utf-8");
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runValidate({ cwd: dir });
    expect(log.some((s) => /no generated docs yet under/.test(s))).toBe(true);
    // Crucially, the frontmatter-error branch never fires.
    expect(error.some((s) => /missing required frontmatter/.test(s))).toBe(false);
    expect(log).toContain("All checks passed.");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("runValidate frontmatter checks", () => {
  it("counts a single doc with all three required fields as ✓ 1/1", async () => {
    await writeMd("use-case-a.md", {
      code2wiki_id: "uc-001",
      title: "Publish a site",
      slug: "publish-a-site",
    });
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runValidate({ cwd: dir });
    expect(log).toContain("✓ 1/1 generated docs have valid frontmatter");
    expect(log).toContain("All checks passed.");
    expect(error).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("counts multiple valid docs (✓ 3/3) and ends in success", async () => {
    for (let i = 0; i < 3; i++) {
      await writeMd(`use-case-${i}.md`, {
        code2wiki_id: `uc-00${i}`,
        title: `Title ${i}`,
        slug: `slug-${i}`,
      });
    }
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runValidate({ cwd: dir });
    expect(log).toContain("✓ 3/3 generated docs have valid frontmatter");
    expect(error).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("accepts extra unknown frontmatter fields (no strict-schema gate at the validate layer)", async () => {
    await writeMd("with-extras.md", {
      code2wiki_id: "uc-001",
      title: "T",
      slug: "s",
      // Extras that the validator doesn't (and shouldn't) reject, renderer's
      // contract owns the full schema; validate.ts only pins the upsert keys.
      tags: ["a", "b"],
      confidence: "high",
      custom_field: { nested: true },
    });
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runValidate({ cwd: dir });
    expect(log).toContain("✓ 1/1 generated docs have valid frontmatter");
    expect(error).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("runValidate frontmatter failure modes", () => {
  it("flags a doc missing code2wiki_id + exits 1", async () => {
    await writeMd("missing-id.md", {
      title: "T",
      slug: "s",
    });
    const { error } = captureConsole();
    const exitSpy = spyExit();
    await expect(runValidate({ cwd: dir })).rejects.toThrow(/exit:1/);
    expect(error.some((s) => /✗ missing-id\.md: missing required frontmatter/.test(s))).toBe(
      true,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("flags a doc missing title + exits 1", async () => {
    await writeMd("missing-title.md", {
      code2wiki_id: "uc-001",
      slug: "s",
    });
    const { error } = captureConsole();
    const exitSpy = spyExit();
    await expect(runValidate({ cwd: dir })).rejects.toThrow(/exit:1/);
    expect(error.some((s) => /✗ missing-title\.md: missing required frontmatter/.test(s))).toBe(
      true,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("flags a doc missing slug + exits 1", async () => {
    await writeMd("missing-slug.md", {
      code2wiki_id: "uc-001",
      title: "T",
    });
    const { error } = captureConsole();
    const exitSpy = spyExit();
    await expect(runValidate({ cwd: dir })).rejects.toThrow(/exit:1/);
    expect(error.some((s) => /✗ missing-slug\.md: missing required frontmatter/.test(s))).toBe(
      true,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("flags an .md file with NO frontmatter at all (gray-matter → fm.data === {}) + exits 1", async () => {
    const outDir = path.join(dir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    // No --- delimiters → gray-matter returns data:{}
    await fs.writeFile(
      path.join(outDir, "bare.md"),
      "# Just a heading, no frontmatter\n",
      "utf-8",
    );
    const { error } = captureConsole();
    const exitSpy = spyExit();
    await expect(runValidate({ cwd: dir })).rejects.toThrow(/exit:1/);
    expect(error.some((s) => /✗ bare\.md: missing required frontmatter/.test(s))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runValidate honors config.output (bug guard: was hardcoded to docs/use-cases)", () => {
  it("finds docs under config.output when it differs from the default", async () => {
    // Write the config with a non-default output path.
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ output: "./generated/wiki" }),
      "utf-8",
    );
    // Write a valid doc at the custom path (NOT at ./docs/use-cases).
    const customOut = path.join(dir, "generated", "wiki");
    await fs.mkdir(customOut, { recursive: true });
    await fs.writeFile(
      path.join(customOut, "my-use-case.md"),
      "---\ncode2wiki_id: uc-1\ntitle: T\nslug: s\n---\nbody\n",
      "utf-8",
    );
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runValidate({ cwd: dir });
    // The doc at the custom path must be found.
    expect(log).toContain("✓ 1/1 generated docs have valid frontmatter");
    expect(log).toContain("All checks passed.");
    expect(error).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("silently reports no-docs when the custom output dir is empty (ENOENT-silent UX)", async () => {
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ output: "./custom/out" }),
      "utf-8",
    );
    // Do NOT create the custom dir; the validator should treat the missing dir
    // as a first-run case (same as the default-path ENOENT path).
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runValidate({ cwd: dir });
    expect(log).toContain("All checks passed.");
    expect(error).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("runValidate mixed valid/invalid", () => {
  it("reports each invalid doc + counts only valid docs in the ✓ N/M summary + exits 1", async () => {
    await writeMd("ok-1.md", {
      code2wiki_id: "uc-1",
      title: "T1",
      slug: "s1",
    });
    await writeMd("bad.md", {
      // Missing slug.
      code2wiki_id: "uc-2",
      title: "T2",
    });
    await writeMd("ok-2.md", {
      code2wiki_id: "uc-3",
      title: "T3",
      slug: "s3",
    });
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await expect(runValidate({ cwd: dir })).rejects.toThrow(/exit:1/);
    // Count line still emitted (logs the okCount/total split).
    expect(log).toContain("✓ 2/3 generated docs have valid frontmatter");
    // Exactly the invalid doc surfaces in stderr.
    expect(error.some((s) => /✗ bad\.md: missing required frontmatter/.test(s))).toBe(true);
    expect(error.some((s) => /ok-1\.md/.test(s))).toBe(false);
    expect(error.some((s) => /ok-2\.md/.test(s))).toBe(false);
    // Success line MUST be suppressed when any check failed.
    expect(log).not.toContain("All checks passed.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
