import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, defaultConfig } from "./config.js";
import {
  DEFAULT_MAX_MAIN_FLOW_STEPS,
  DEFAULT_TAG_JARGON_BLOCKLIST,
} from "./types.js";

/**
 * Pins the config-loader contract used by every CLI command (init / list /
 * generate / validate / publish / claim / replay). Three load-bearing
 * surfaces only surface live on a regression:
 *
 *   1. Filename fallback order: `code2wiki.config.json` is tried before
 *      `.code2wiki/config.json`. A regression flipping the order would
 *      silently let a stale `.code2wiki/config.json` shadow the canonical
 *      file for any customer who ever wrote one.
 *   2. ENOENT-vs-other-error split: ENOENT continues to the next filename;
 *      anything else (JSON.parse SyntaxError, EISDIR, zod ZodError) is
 *      wrapped with the failing filename and re-thrown. A regression
 *      conflating the two would either swallow invalid configs (data
 *      corruption risk) or refuse to fall back through the filenames.
 *   3. Schema-parse on every input, including the no-files-found path,
 *      which delegates to `ConfigSchema.parse({})` so callers always get a
 *      fully-defaulted object. A regression returning `{}` directly would
 *      silently surface `undefined` for every default-bearing field.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-config-"));
});

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function writeTopLevel(contents: string): Promise<void> {
  await fs.writeFile(path.join(dir, "code2wiki.config.json"), contents);
}

async function writeNested(contents: string): Promise<void> {
  await fs.mkdir(path.join(dir, ".code2wiki"), { recursive: true });
  await fs.writeFile(path.join(dir, ".code2wiki", "config.json"), contents);
}

describe("defaultConfig", () => {
  it("returns a fully-populated config (every default-bearing field set)", () => {
    const cfg = defaultConfig();
    expect(cfg.include).toEqual([
      "**/*.java",
      "**/*.cfc",
      "**/*.cfm",
      "**/*_controller.rb",
      "**/views.py",
      "**/*_views.py",
      "**/views/**/*.py",
      "**/*.cs",

      "**/*.ascx.cs",

      "**/*.ascx",
      "**/*.asax",
    ]);
    expect(cfg.exclude).toContain("**/node_modules/**");
    expect(cfg.exclude).toContain("**/references/**");
    expect(cfg.output).toBe("./docs/use-cases");
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(cfg.mock).toBe(false);
    expect(cfg.maxCandidates).toBe(50);
    expect(cfg.includeConstantReturns).toBe(false);
    // Default 'annotated' preserves pre-2026-05-16 behavior; the two
    // other modes ship inert unless a customer explicitly opts in.
    expect(cfg.javaSurfaceMode).toBe("annotated");
    expect(cfg.includeJmhBenchmarks).toBe(false);
    expect(cfg.validator).toEqual({
      maxMainFlowSteps: DEFAULT_MAX_MAIN_FLOW_STEPS,
      tagJargonBlocklist: DEFAULT_TAG_JARGON_BLOCKLIST,
    });
    expect(cfg.publish).toEqual({});
  });

  // 2026-05-16 real-repo signal: the previous exclude list filtered
  // `test/` + `tests/` but missed framework-conventional variants. The
  // ColdBox multi-repo run surfaced `test-harness/handlers/main.cfc#
  // routeRunner` as a candidate (3-line `runRoute(...)` test fixture),
  // wasting LLM tokens documenting test infrastructure as if it were
  // business logic. Pin the extended list so a regression that
  // shortens it can't silently leak fixtures back in.
  it("excludes conventional test-fixture paths across CFML / Java / JS-TS by default", () => {
    const cfg = defaultConfig();
    expect(cfg.exclude).toContain("**/test/**");
    expect(cfg.exclude).toContain("**/tests/**");
    expect(cfg.exclude).toContain("**/test-harness/**");
    expect(cfg.exclude).toContain("**/spec/**");
    expect(cfg.exclude).toContain("**/specs/**");
    expect(cfg.exclude).toContain("**/__tests__/**");
    expect(cfg.exclude).toContain("**/__mocks__/**");
  });

  // 2026-05-16 second multi-repo run: Dropwizard's
  // `dropwizard-benchmarks/src/main/java/io/dropwizard/benchmarks/jersey/
  // DropwizardResourceConfigBenchmark.java` produced 3 low-confidence
  // pages because the file is a JMH benchmark with nested @Path stub
  // resources whose method bodies are `return "id"` constants. A plain
  // `**/benchmarks/**` glob wouldn't catch `dropwizard-benchmarks/`
  // because that directory's NAME isn't "benchmarks". Pin the wildcard
  // variant so a regression that swaps it for the narrower form can't
  // silently re-leak benchmark stubs.
  it("excludes benchmark-flavored module paths with wildcard glob (catches dropwizard-benchmarks/, micrometer-benchmarks/, etc.)", () => {
    const cfg = defaultConfig();
    expect(cfg.exclude).toContain("**/*benchmark*/**");
    expect(cfg.exclude).toContain("**/*benchmarks*/**");
  });

  it("matches loadConfig(empty-dir) byte-for-byte (no-files path delegates to ConfigSchema.parse({}))", async () => {
    const fromLoad = await loadConfig(dir);
    expect(fromLoad).toEqual(defaultConfig());
  });
});

describe("loadConfig, filename fallback (ENOENT continue)", () => {
  it("returns defaults when neither config file is present", async () => {
    const cfg = await loadConfig(dir);
    expect(cfg.output).toBe("./docs/use-cases");
    expect(cfg.maxCandidates).toBe(50);
  });

  it("reads code2wiki.config.json when present at project root", async () => {
    await writeTopLevel(JSON.stringify({ output: "./out/top-level" }));
    const cfg = await loadConfig(dir);
    expect(cfg.output).toBe("./out/top-level");
    // Other fields keep their defaults, partial config supported.
    expect(cfg.maxCandidates).toBe(50);
    expect(cfg.model).toBe("claude-sonnet-4-6");
  });

  it("falls back to .code2wiki/config.json when top-level file is missing", async () => {
    await writeNested(JSON.stringify({ output: "./out/nested" }));
    const cfg = await loadConfig(dir);
    expect(cfg.output).toBe("./out/nested");
  });

  it("prefers code2wiki.config.json over .code2wiki/config.json when both exist (filename order is load-bearing)", async () => {
    await writeTopLevel(JSON.stringify({ output: "./out/top-level" }));
    await writeNested(JSON.stringify({ output: "./out/nested" }));
    const cfg = await loadConfig(dir);
    expect(cfg.output).toBe("./out/top-level");
  });

  it("returns defaults when projectRoot does not exist (ENOENT on every filename)", async () => {
    const ghost = path.join(dir, "does", "not", "exist");
    const cfg = await loadConfig(ghost);
    expect(cfg).toEqual(defaultConfig());
  });
});

describe("loadConfig, error wrapping (non-ENOENT IO / parse / schema failures)", () => {
  it("wraps invalid JSON in the top-level file with its filename", async () => {
    await writeTopLevel("{ not valid json");
    await expect(loadConfig(dir)).rejects.toThrow(/code2wiki\.config\.json/);
  });

  it("wraps invalid JSON in the nested file with its filename (and only when top-level was ENOENT)", async () => {
    await writeNested("{ also not json");
    await expect(loadConfig(dir)).rejects.toThrow(/\.code2wiki\/config\.json/);
  });

  it("wraps zod validation failures (caught negative-int constraint on maxCandidates)", async () => {
    await writeTopLevel(JSON.stringify({ maxCandidates: -5 }));
    await expect(loadConfig(dir)).rejects.toThrow(/code2wiki\.config\.json/);
  });

  it("wraps zod validation failures on a malformed publish.banner.repoUrl (URL constraint)", async () => {
    await writeTopLevel(
      JSON.stringify({
        publish: {
          confluence: {
            mode: "claim",
            banner: { repoUrl: "not a url" },
          },
        },
      }),
    );
    await expect(loadConfig(dir)).rejects.toThrow(/code2wiki\.config\.json/);
  });

  it("wraps non-ENOENT IO errors (top-level file is a directory → EISDIR)", async () => {
    await fs.mkdir(path.join(dir, "code2wiki.config.json"));
    await expect(loadConfig(dir)).rejects.toThrow(/code2wiki\.config\.json/);
  });
});

describe("loadConfig, schema passthrough on valid input", () => {
  it("preserves per-target publish.mode through schema parse", async () => {
    await writeTopLevel(
      JSON.stringify({
        publish: {
          confluence: { mode: "claim" },
          notion: { mode: "parallel" },
        },
      }),
    );
    const cfg = await loadConfig(dir);
    expect(cfg.publish.confluence?.mode).toBe("claim");
    expect(cfg.publish.notion?.mode).toBe("parallel");
  });

  it("strips unknown top-level fields (zod default is strip, not strict)", async () => {
    await writeTopLevel(
      JSON.stringify({ output: "./custom", futureField: "ignored" }),
    );
    const cfg = await loadConfig(dir);
    expect(cfg.output).toBe("./custom");
    expect((cfg as unknown as { futureField?: unknown }).futureField).toBeUndefined();
  });

  it("merges include/exclude as full-override (no array-concat surprise)", async () => {
    await writeTopLevel(
      JSON.stringify({ include: ["**/*.java"], exclude: ["**/skip/**"] }),
    );
    const cfg = await loadConfig(dir);
    expect(cfg.include).toEqual(["**/*.java"]);
    expect(cfg.exclude).toEqual(["**/skip/**"]);
  });

  it("threads a customer validator.maxMainFlowSteps override through schema parse", async () => {
    // Pins that ConfigSchema.validator is an actual nested-object schema
    // (not a passthrough) and that the customer's value reaches callers
    // like extractor.ts that read config.validator.maxMainFlowSteps.
    // A regression flattening the validator block or dropping the nested
    // schema would surface as NaN / undefined here rather than 20.
    await writeTopLevel(
      JSON.stringify({ validator: { maxMainFlowSteps: 20 } }),
    );
    const cfg = await loadConfig(dir);
    expect(cfg.validator.maxMainFlowSteps).toBe(20);
  });

  it("threads includeConstantReturns: true through schema parse (escape-hatch)", async () => {
    // Pins that the boolean toggle added in 588c255 survives
    // ConfigSchema.parse without being dropped as an unknown key.
    await writeTopLevel(JSON.stringify({ includeConstantReturns: true }));
    const cfg = await loadConfig(dir);
    expect(cfg.includeConstantReturns).toBe(true);
  });

  it("threads includeJmhBenchmarks: true through schema parse", async () => {
    await writeTopLevel(JSON.stringify({ includeJmhBenchmarks: true }));
    const cfg = await loadConfig(dir);
    expect(cfg.includeJmhBenchmarks).toBe(true);
  });

});
