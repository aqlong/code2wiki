import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// vi.mock is hoisted; we wrap the real parseFile in vi.fn so individual tests
// can flip ONE call into a throw to exercise the per-file error-isolation path.
// Every test that doesn't override gets real parsing semantics.
vi.mock("./parsers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./parsers/index.js")>();
  return {
    ...actual,
    parseFile: vi.fn(actual.parseFile),
  };
});

import { scanProject } from "./scan.js";
import { parseFile } from "./parsers/index.js";
import { defaultConfig } from "./config.js";
import type { Candidate, Config } from "./types.js";

// Fixtures have a non-trivial body (cfset + cfreturn var, or local +
// return var) so the constant-return-only filter in scanProject keeps
// them. Constant-return semantics are covered by triviality.test.ts;
// these tests are about scan mechanics (ordering, globs, error
// isolation), not the filter.
const TWO_FUNCTION_CFC = `<cfcomponent>
  <cffunction name="alpha" access="public" returntype="any">
    <cfset var n = 1>
    <cfreturn n>
  </cffunction>
  <cffunction name="beta" access="public" returntype="any">
    <cfset var n = 2>
    <cfreturn n>
  </cffunction>
</cfcomponent>
`;

const ONE_FUNCTION_CFC = `<cfcomponent>
  <cffunction name="solo" access="public" returntype="any">
    <cfset var n = 1>
    <cfreturn n>
  </cffunction>
</cfcomponent>
`;

const REST_CONTROLLER_JAVA = `@RestController
public class Hello {
  @GetMapping("/x") public String x() {
    String body = "x";
    return body;
  }
}
`;

// Plain Java class with Javadoc + 3 public non-trivial methods, no framework
// annotations. Used to pin scan.ts config.javaSurfaceMode forwarding:
// annotated -> 0 candidates, all-public-classes -> surfaces.
const PLAIN_SERVICE_JAVA = `package com.example.util;

/** String normalization utilities. */
public class StringUtils {
  public String normalize(String s) { trim(s); sanitize(s); return format(s); }
  public String truncate(String s, int max) { check(s); limit(s, max); return slice(s, max); }
  public String encode(String s) { validate(s); transform(s); return wrap(s); }
}
`;

// JMH benchmark class used to pin scan.ts config.includeJmhBenchmarks
// forwarding. The methods are non-trivial so the constant-return filter
// and the getter/setter filter both pass, leaving only the JMH gate to
// decide whether candidates surface.
const JMH_BENCHMARK_JAVA = `import org.openjdk.jmh.annotations.BenchmarkMode;
import org.openjdk.jmh.annotations.State;
import org.openjdk.jmh.annotations.Scope;

@BenchmarkMode
@State(Scope.Thread)
public class PerfBenchmark {
  public void measureRead() { fetch(); validate(); }
  public void measureWrite() { submit(); confirm(); }
}
`;

const CFM_PAGE = `<cfquery name="orders">
  SELECT * FROM orders WHERE customer_id = 42
</cfquery>
<cfoutput>#orders.recordCount#</cfoutput>
`;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-scan-"));
});

afterEach(async () => {
  vi.mocked(parseFile).mockClear();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function write(rel: string, body: string): Promise<string> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf-8");
  return full;
}

describe("scanProject", () => {
  it("returns [] for an empty project", async () => {
    const candidates = await scanProject(dir, defaultConfig());
    expect(candidates).toEqual([]);
  });

  it("returns [] for a non-existent project root (fast-glob no-throw contract)", async () => {
    const ghost = path.join(dir, "does-not-exist");
    const candidates = await scanProject(ghost, defaultConfig());
    expect(candidates).toEqual([]);
  });

  it("emits one candidate per <cffunction> in a tag-style .cfc", async () => {
    await write("two.cfc", TWO_FUNCTION_CFC);
    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.name)).toEqual(["alpha", "beta"]);
    for (const c of candidates) {
      expect(c.language).toBe("cfml");
      expect(c.kind).toBe("cf-tag-function");
      expect(c.relativePath).toBe("two.cfc");
    }
  });

  it("emits a single page-level candidate for a substantive .cfm", async () => {
    await write("orders.cfm", CFM_PAGE);
    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.language).toBe("cfml");
    expect(candidates[0]?.kind).toBe("cf-tag-function");
    expect(candidates[0]?.name).toBe("orders");
    expect(candidates[0]?.relativePath).toBe("orders.cfm");
  });

  it("returns absolute filePath and project-root-relative relativePath", async () => {
    const absPath = await write("solo.cfc", ONE_FUNCTION_CFC);
    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(path.isAbsolute(c.filePath)).toBe(true);
    // On macOS /tmp is symlinked to /private/tmp; fast-glob returns the
    // resolved real path. Compare via realpath.
    expect(await fs.realpath(c.filePath)).toBe(await fs.realpath(absPath));
    expect(c.relativePath).toBe("solo.cfc");
    expect(path.isAbsolute(c.relativePath)).toBe(false);
  });

  it("sorts candidates across files alphabetically by relativePath", async () => {
    await write("c.cfc", ONE_FUNCTION_CFC);
    await write("a.cfc", ONE_FUNCTION_CFC);
    await write("b.cfc", ONE_FUNCTION_CFC);

    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates.map((c) => c.relativePath)).toEqual([
      "a.cfc",
      "b.cfc",
      "c.cfc",
    ]);
  });

  it("sorts by full relativePath, not just basename (cross-directory)", async () => {
    // basename order would be `a.cfc` < `z.cfc`, putting the b/-dir file first.
    // Full-path order puts a/z.cfc before b/a.cfc.
    await write("b/a.cfc", ONE_FUNCTION_CFC);
    await write("a/z.cfc", ONE_FUNCTION_CFC);

    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates.map((c) => c.relativePath)).toEqual([
      path.join("a", "z.cfc"),
      path.join("b", "a.cfc"),
    ]);
  });

  it("sorts candidates within a file by ascending lineStart", async () => {
    await write("two.cfc", TWO_FUNCTION_CFC);
    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.name).toBe("alpha");
    expect(candidates[1]!.name).toBe("beta");
    expect(candidates[0]!.lineStart).toBeLessThan(candidates[1]!.lineStart);
  });

  it("honors a custom exclude glob (skips matched files)", async () => {
    await write("keep.cfc", ONE_FUNCTION_CFC);
    await write("skip-me/drop.cfc", ONE_FUNCTION_CFC);

    const config: Config = {
      ...defaultConfig(),
      exclude: ["**/skip-me/**"],
    };
    const candidates = await scanProject(dir, config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.relativePath).toBe("keep.cfc");
  });

  it("default exclude drops node_modules/", async () => {
    await write("real.cfc", ONE_FUNCTION_CFC);
    await write("node_modules/some-pkg/installed.cfc", ONE_FUNCTION_CFC);

    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.relativePath).toBe("real.cfc");
  });

  it("default exclude drops references/ (ADR-010 reference codebases)", async () => {
    await write("app.cfc", ONE_FUNCTION_CFC);
    await write("references/masacms/anything.cfc", ONE_FUNCTION_CFC);

    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates.map((c) => c.relativePath)).toEqual(["app.cfc"]);
  });

  // Regression guard for the 2026-05-16 exclude-list extension. config.test.ts
  // pins that these patterns are in defaultConfig().exclude (schema round-trip),
  // but no scan test verifies that scanProject ACTUALLY honors them end-to-end.
  // Parallel to the includeConstantReturns threading pin in a3a9adf: the schema
  // value existing is necessary but not sufficient; the scan path must consume it.
  // Real-world signals:
  //   - ColdBox multi-repo run: `test-harness/handlers/main.cfc#routeRunner`
  //     surfaced as a candidate (3-line runRoute() fixture, not business logic).
  //   - Dropwizard multi-repo run: `dropwizard-benchmarks/…Benchmark.java`
  //     produced 3 low-confidence pages from a JMH benchmark stub.
  it("default exclude drops conventional test/ directory (prevents test fixtures becoming candidates)", async () => {
    await write("src/real.cfc", ONE_FUNCTION_CFC);
    await write("test/unit/helper.cfc", ONE_FUNCTION_CFC);

    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates.every((c) => !c.relativePath.startsWith("test/"))).toBe(true);
    expect(candidates.some((c) => c.relativePath === path.join("src", "real.cfc"))).toBe(true);
  });

  it("default exclude drops test-harness/ directory (ColdBox convention, 2026-05-16 real-repo signal)", async () => {
    await write("handlers/main.cfc", ONE_FUNCTION_CFC);
    await write("test-harness/handlers/main.cfc", ONE_FUNCTION_CFC);

    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates.every((c) => !c.relativePath.startsWith("test-harness/"))).toBe(true);
    expect(candidates.some((c) => c.relativePath.startsWith("handlers/"))).toBe(true);
  });

  it("default exclude drops __tests__/ directory (Jest convention)", async () => {
    await write("src/service.cfc", ONE_FUNCTION_CFC);
    await write("src/__tests__/service.cfc", ONE_FUNCTION_CFC);

    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates.every((c) => !c.relativePath.includes("__tests__"))).toBe(true);
    expect(candidates.some((c) => c.relativePath === path.join("src", "service.cfc"))).toBe(true);
  });

  it("default exclude drops *benchmark*/ module paths (wildcard, catches dropwizard-benchmarks/ not just benchmarks/)", async () => {
    await write("src/main/Hello.java", REST_CONTROLLER_JAVA);
    // Mirrors the dropwizard-benchmarks/ pattern: the parent directory name
    // contains "benchmark" but is not named exactly "benchmarks/".
    await write("dropwizard-benchmarks/src/main/java/Bench.java", REST_CONTROLLER_JAVA);

    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates.every((c) => !c.relativePath.startsWith("dropwizard-benchmarks/"))).toBe(true);
    expect(candidates.some((c) => c.relativePath.startsWith(path.join("src", "main")))).toBe(true);
  });

  it("narrows by custom include (java-only pattern excludes .cfc)", async () => {
    await write("Hello.java", REST_CONTROLLER_JAVA);
    await write("ignored.cfc", ONE_FUNCTION_CFC);

    const config: Config = {
      ...defaultConfig(),
      include: ["**/*.java"],
    };
    const candidates = await scanProject(dir, config);

    // CFC file must not be scanned; Java RestController produces at least one
    // controller-method candidate.
    expect(candidates.every((c) => c.language === "java")).toBe(true);
    expect(candidates.some((c) => c.relativePath === "Hello.java")).toBe(true);
    expect(candidates.some((c) => c.relativePath === "ignored.cfc")).toBe(
      false,
    );
  });

  it("matches the union of multiple include globs (default java + cfc + cfm)", async () => {
    await write("a.java", REST_CONTROLLER_JAVA);
    await write("b.cfc", ONE_FUNCTION_CFC);
    await write("c.cfm", CFM_PAGE);

    const candidates = await scanProject(dir, defaultConfig());

    const langs = new Set(candidates.map((c) => c.language));
    expect(langs.has("java")).toBe(true);
    expect(langs.has("cfml")).toBe(true);
    const paths = candidates.map((c) => c.relativePath);
    expect(paths).toContain("a.java");
    expect(paths).toContain("b.cfc");
    expect(paths).toContain("c.cfm");
  });

  it("excludes dotfiles by default (fast-glob dot: false)", async () => {
    await write(".hidden.cfc", ONE_FUNCTION_CFC);
    await write("visible.cfc", ONE_FUNCTION_CFC);

    const candidates = await scanProject(dir, defaultConfig());

    expect(candidates.map((c) => c.relativePath)).toEqual(["visible.cfc"]);
  });

  // Regression guard for scan.ts:46 `filterConstantReturns(all, config.includeConstantReturns)`.
  // triviality.test.ts pins the filter's own behavior; config.test.ts pins
  // the schema round-trip. Neither pins that scanProject actually PASSES
  // config.includeConstantReturns to filterConstantReturns. A regression
  // hardcoding `false` there (or dropping the argument) would keep constant-
  // return stubs out of every scan even when the customer set the escape-hatch
  // to true, with no test signal. Parallel to b3593e3 which closed the same
  // threading gap for config.validator.maxMainFlowSteps in the extractor.
  it("honors includeConstantReturns=false (default): drops constant-return-only stubs", async () => {
    // CFML stub whose only body is `<cfreturn true>`, isConstantReturnOnly returns true.
    const stub = `<cfcomponent>
  <cffunction name="onRequestStart" access="public" returntype="boolean">
    <cfreturn true>
  </cffunction>
</cfcomponent>`;
    await write("lifecycle.cfc", stub);

    const candidates = await scanProject(dir, defaultConfig());
    expect(candidates).toHaveLength(0);
  });

  it("honors includeConstantReturns=true: keeps constant-return-only stubs when the escape-hatch is on", async () => {
    const stub = `<cfcomponent>
  <cffunction name="onRequestStart" access="public" returntype="boolean">
    <cfreturn true>
  </cffunction>
</cfcomponent>`;
    await write("lifecycle.cfc", stub);

    const config: Config = { ...defaultConfig(), includeConstantReturns: true };
    const candidates = await scanProject(dir, config);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("onRequestStart");
  });

  // javaSurfaceMode forwarding: parallel structure to includeConstantReturns + includeJmhBenchmarks
  // threading pins. config.test.ts pins the schema; parsers/index.test.ts pins the
  // parseFile->parseJava bridge. Neither pins that scanProject passes
  // config.javaSurfaceMode to parseFile. A dropped field in scan.ts would silently
  // apply 'annotated' for every scan regardless of config, with no test signal.
  it("honors javaSurfaceMode='annotated' (default): plain class with no framework annotations yields 0 candidates", async () => {
    await write("StringUtils.java", PLAIN_SERVICE_JAVA);
    const candidates = await scanProject(dir, defaultConfig());
    expect(candidates).toHaveLength(0);
  });

  it("honors javaSurfaceMode='all-public-classes': Javadoc + 3-method plain class surfaces", async () => {
    await write("StringUtils.java", PLAIN_SERVICE_JAVA);
    const config: Config = { ...defaultConfig(), javaSurfaceMode: "all-public-classes" };
    const candidates = await scanProject(dir, config);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.relativePath === "StringUtils.java")).toBe(true);
  });

  // Parallel to the includeConstantReturns threading pin above. config.test.ts
  // pins the schema round-trip; parsers/index.test.ts pins the parseFile->parseJava
  // bridge. Neither pins that scanProject passes config.includeJmhBenchmarks to
  // parseFile. A regression dropping that field from the parseFile call in scan.ts
  // would silently suppress JMH candidates even when the customer set the flag,
  // with no test signal at any layer.
  it("honors includeJmhBenchmarks=false (default): drops JMH benchmark classes", async () => {
    await write("PerfBenchmark.java", JMH_BENCHMARK_JAVA);
    const candidates = await scanProject(dir, defaultConfig());
    expect(candidates).toHaveLength(0);
  });

  it("honors includeJmhBenchmarks=true: surfaces JMH benchmark classes when opted in", async () => {
    await write("PerfBenchmark.java", JMH_BENCHMARK_JAVA);
    const config: Config = { ...defaultConfig(), includeJmhBenchmarks: true };
    const candidates = await scanProject(dir, config);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.relativePath === "PerfBenchmark.java")).toBe(true);
  });

  it("isolates per-file parser errors: one throw, sibling files still emit + console.error logs the relative path", async () => {
    await write("bad.cfc", ONE_FUNCTION_CFC);
    await write("good.cfc", ONE_FUNCTION_CFC);

    // Throw when parseFile sees `bad.cfc`; defer to the real parser otherwise.
    // fast-glob's return order isn't pinned, so use mockImplementation (not
    // mockImplementationOnce) to keep the test order-independent.
    const real = await vi.importActual<typeof import("./parsers/index.js")>(
      "./parsers/index.js",
    );
    vi.mocked(parseFile).mockImplementation(
      async (filePath: string, projectRoot: string): Promise<Candidate[]> => {
        if (path.basename(filePath) === "bad.cfc") {
          throw new Error("synthetic parser failure");
        }
        return real.parseFile(filePath, projectRoot);
      },
    );

    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const candidates = await scanProject(dir, defaultConfig());

      // good.cfc still emitted its candidate; bad.cfc swallowed.
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.relativePath).toBe("good.cfc");

      // Diagnostic mentions the relative path + the thrown message.
      const msg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msg).toContain("bad.cfc");
      expect(msg).toContain("synthetic parser failure");
      // Sibling file isn't mentioned in the error stream.
      expect(msg).not.toContain("good.cfc");
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

