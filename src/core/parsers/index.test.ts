import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile } from "./index.js";

const SPRING_CONTROLLER = `import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class HelloController {
  @GetMapping("/hi") public String hi() { return "hi"; }
}
`;

// Plain Java class with Javadoc + 3 public non-trivial methods, no framework
// annotations, package outside the allowlist segments. Used to pin that
// javaSurfaceMode is forwarded: annotated mode -> 0 candidates,
// all-public-classes mode -> 3 candidates.
const PLAIN_SERVICE_JAVA = `package com.example.util;

/** String normalization utilities. */
public class StringUtils {
  public String normalize(String s) { trim(s); sanitize(s); return format(s); }
  public String truncate(String s, int max) { check(s); limit(s, max); return slice(s, max); }
  public String encode(String s) { validate(s); transform(s); return wrap(s); }
}
`;

// JMH benchmark class: has @BenchmarkMode + @State + public non-trivial
// methods. Used to pin that ParseFileOptions is forwarded to parseJava
// (not silently dropped in the dispatch layer).
const JMH_BENCHMARK = `import org.openjdk.jmh.annotations.BenchmarkMode;
import org.openjdk.jmh.annotations.State;
import org.openjdk.jmh.annotations.Scope;

@BenchmarkMode
@State(Scope.Thread)
public class PerfBenchmark {
  public void measureRead() { fetch(); validate(); }
  public void measureWrite() { submit(); confirm(); }
}
`;

const TAG_STYLE_CFC = `<cfcomponent>
\t<cffunction name="hello" output="false">
\t\t<cfreturn "hi">
\t</cffunction>
</cfcomponent>
`;

// Three executable lines so parseCfmPage's stub guard (< 3 → skip) doesn't fire.
const CFM_PAGE = `<cfquery name="orders" datasource="db">
\tSELECT id FROM orders WHERE customer_id = 42
</cfquery>
<cfoutput>#orders.recordCount#</cfoutput>
`;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-parseFile-"));
});

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function write(rel: string, body: string): Promise<string> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf-8");
  return full;
}

describe("parseFile dispatch", () => {
  it("dispatches .java to parseJava (controller-method emitted)", async () => {
    const file = await write("HelloController.java", SPRING_CONTROLLER);
    const candidates = await parseFile(file, dir);

    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.language).toBe("java");
    expect(c.kind).toBe("controller-method");
    expect(c.name).toBe("HelloController.hi");
  });

  it("dispatches .cfc to parseCfml (cf-tag-function emitted)", async () => {
    const file = await write("Hello.cfc", TAG_STYLE_CFC);
    const candidates = await parseFile(file, dir);

    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.language).toBe("cfml");
    expect(c.kind).toBe("cf-tag-function");
    expect(c.name).toBe("hello");
  });

  it("dispatches .cfm to parseCfml as a page candidate (name = basename without ext)", async () => {
    const file = await write("orders.cfm", CFM_PAGE);
    const candidates = await parseFile(file, dir);

    // .cfm pages emit a single candidate when the executable-line guard passes.
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.language).toBe("cfml");
    expect(c.kind).toBe("cf-tag-function");
    expect(c.name).toBe("orders");
  });

  it("matches the extension case-insensitively (.JAVA → parseJava)", async () => {
    // Pins the `toLowerCase()` call on path.extname's output. A refactor
    // dropping that would silently break repos whose tools emit upper-case
    // names (Windows-origin uploads, some VCS imports).
    const file = await write("UpperCase.JAVA", SPRING_CONTROLLER);
    const candidates = await parseFile(file, dir);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.language).toBe("java");
  });

  it("matches the extension case-insensitively (.CFC → parseCfml)", async () => {
    const file = await write("UpperCase.CFC", TAG_STYLE_CFC);
    const candidates = await parseFile(file, dir);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.language).toBe("cfml");
  });

  it("matches the extension case-insensitively (mixed-case .Cfm → parseCfml)", async () => {
    const file = await write("MixedCase.Cfm", CFM_PAGE);
    const candidates = await parseFile(file, dir);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.language).toBe("cfml");
  });

  it("returns [] for unsupported extensions like .js", async () => {
    const file = await write("ignored.js", "console.log('hi');\n");
    const candidates = await parseFile(file, dir);
    expect(candidates).toEqual([]);
  });

  it("returns [] for unsupported extensions like .md", async () => {
    const file = await write("README.md", "# title\n\nbody\n");
    const candidates = await parseFile(file, dir);
    expect(candidates).toEqual([]);
  });

  it("returns [] for a file with no extension", async () => {
    const file = await write("Makefile", "all:\n\techo hi\n");
    const candidates = await parseFile(file, dir);
    expect(candidates).toEqual([]);
  });

  it("passes a projectRoot-relative path to the parser (load-bearing for audit-log readability)", async () => {
    // The dispatcher computes `path.relative(projectRoot, filePath)` and hands
    // that string to the parser, which writes it into Candidate.relativePath.
    // Audit-log entries + frontmatter source-line links depend on this being
    // relative (not absolute). A refactor to pass `filePath` straight through
    // would silently bloat every audit row + every published page's source link.
    const file = await write("nested/dir/Sample.java", SPRING_CONTROLLER);
    const candidates = await parseFile(file, dir);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.relativePath).toBe(
      path.join("nested", "dir", "Sample.java"),
    );
    expect(candidates[0]!.filePath).toBe(file);
  });

  it("passes a `../`-prefixed relative path when the file is outside projectRoot (documents current behavior)", async () => {
    // Pins the unaltered `path.relative` semantic. If a future refactor wants
    // to guard against out-of-tree paths (e.g. throw, or normalize to absolute),
    // this case forces the change to be intentional rather than silent.
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "code2wiki-parseFile-outside-"),
    );
    try {
      const file = path.join(outsideDir, "Outside.cfc");
      await fs.writeFile(file, TAG_STYLE_CFC, "utf-8");

      const candidates = await parseFile(file, dir);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.relativePath.startsWith("..")).toBe(true);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("forwards javaSurfaceMode='annotated' (default) to parseJava: plain class with no framework annotations yields 0 candidates", async () => {
    // Pins the parseFile->parseJava bridge for javaSurfaceMode. If the option
    // were dropped, annotated mode would silently apply for every call regardless
    // of what the caller passed; all-public-classes behaviour below would be
    // indistinguishable from annotated and the test would fail.
    const file = await write("StringUtils.java", PLAIN_SERVICE_JAVA);
    const candidates = await parseFile(file, dir);
    // Default annotated: no framework annotations -> 0 candidates.
    expect(candidates).toHaveLength(0);
  });

  it("forwards javaSurfaceMode='all-public-classes' to parseJava: Javadoc + 3-method plain class surfaces", async () => {
    const file = await write("StringUtils.java", PLAIN_SERVICE_JAVA);
    const candidates = await parseFile(file, dir, { javaSurfaceMode: "all-public-classes" });
    // Javadoc present, 3 public non-trivial methods, none are getters/setters.
    expect(candidates).toHaveLength(3);
    const names = candidates.map((c) => c.name).sort();
    expect(names).toEqual([
      "StringUtils.encode",
      "StringUtils.normalize",
      "StringUtils.truncate",
    ]);
  });

  it("forwards includeJmhBenchmarks=false (default) to parseJava, skipping JMH classes", async () => {
    // Pins the option-forwarding layer: if parseFile dropped includeJmhBenchmarks
    // from the ParseJavaOptions it passes to parseJava, the skip would stop
    // working and JMH stubs would surface as candidates. java.test.ts tests
    // parseJava directly; this test pins the parseFile -> parseJava bridge.
    const file = await write("PerfBenchmark.java", JMH_BENCHMARK);
    const candidates = await parseFile(file, dir);
    // Default: JMH skip active, 0 candidates regardless of public methods.
    expect(candidates).toEqual([]);
  });

  it("forwards includeJmhBenchmarks=true to parseJava, surfacing JMH classes", async () => {
    const file = await write("PerfBenchmark.java", JMH_BENCHMARK);
    const candidates = await parseFile(file, dir, { includeJmhBenchmarks: true });
    // Option forwarded: JMH skip lifted, both public non-trivial methods surface.
    const names = candidates.map((c) => c.name).sort();
    expect(names).toEqual(["PerfBenchmark.measureRead", "PerfBenchmark.measureWrite"]);
  });

  it("rejects when the file does not exist, even for unsupported extensions", async () => {
    // The dispatcher reads source from disk BEFORE checking the extension,
    // so a missing `.js` file still rejects (it doesn't shortcut to []).
    // Pinning this so a sensible future optimization ("check ext first, skip
    // readFile for unsupported types") is recognized as an intentional change
    // to error semantics, not an accidental one.
    const ghost = path.join(dir, "does-not-exist.js");
    await expect(parseFile(ghost, dir)).rejects.toThrow();
  });
});
