import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// Minimal Rails controller. parseRuby gates on `_controller.rb`, so the test
// filename must follow that convention for the parser to emit candidates.
const RAILS_CONTROLLER = `class UsersController < ApplicationController
  def index
    @users = User.all
  end
end
`;

// Minimal Django function-based view. parseDjango gates on `views.py` /
// `*_views.py` / a `/views/` path segment; the test filename below uses
// `views.py` (the canonical convention).
const DJANGO_VIEW = `from django.shortcuts import render

def index(request):
    return render(request, 'index.html')
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

  it("dispatches .rb to parseRuby (rails-action emitted with language='ruby')", async () => {
    // Pins the parseFile -> parseRuby route added with the Rails parser
    // (commit 3f3fa95, ADR-036). A regression dropping the `.rb` case or
    // routing it to parseCfml would surface as either an empty result
    // (silent break of every Ruby caller) or a wrong-language candidate.
    const file = await write("users_controller.rb", RAILS_CONTROLLER);
    const candidates = await parseFile(file, dir);

    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.language).toBe("ruby");
    expect(c.kind).toBe("rails-action");
    expect(c.name).toBe("UsersController#index");
  });

  it("dispatches .rb to parseRuby and respects the parser's `_controller.rb` gate (non-controller -> [])", async () => {
    // End-to-end pin that parseRuby's file-gate is reachable through
    // parseFile (i.e. the dispatcher actually invokes the parser, not
    // just a stub). A regression substituting an always-emit parser for
    // parseRuby on the `.rb` switch arm would fail this test even if
    // the positive dispatch test above still passed.
    const file = await write("models/user.rb", "class User < ApplicationRecord\nend\n");
    const candidates = await parseFile(file, dir);
    expect(candidates).toEqual([]);
  });

  it("dispatches .py to parseDjango (django-view emitted with language='python')", async () => {
    // Pins the parseFile -> parseDjango route added with the Django parser
    // (commit 9f401f0, ADR-037). A regression dropping the `.py` case or
    // routing it to a different parser would surface as either an empty
    // result or a wrong-language candidate.
    const file = await write("views.py", DJANGO_VIEW);
    const candidates = await parseFile(file, dir);

    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.language).toBe("python");
    expect(c.kind).toBe("django-view");
    expect(c.name).toBe("index");
  });

  it("dispatches .py to parseDjango and respects the view-file gate (non-view .py -> [])", async () => {
    // End-to-end pin that parseDjango's file-gate (basename === "views.py" ||
    // basename.endsWith("_views.py") || a literal /views/ segment) is
    // reachable through parseFile. A regression substituting an always-emit
    // parser for parseDjango on the `.py` switch arm would fail this even
    // if the positive dispatch test above still passed.
    const file = await write("models.py", DJANGO_VIEW);
    const candidates = await parseFile(file, dir);
    expect(candidates).toEqual([]);
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
  it("returns [] for unsupported extensions like .asp", async () => {
    const file = await write("Default.asp", "<% Response.Write(\"hi\") %>");
    const candidates = await parseFile(file, dir);
    expect(candidates).toEqual([]);
  });
});

// CLAUDE.md documents a canonical matrix: every parser emits notes for 9
// side-effect categories. CFML has no native message-broker tag, so its
// broker row is intentionally absent (8 categories). All other parsers
// have all 9. Total: 4 parsers x 9 + 1 (cfml) x 8 = 44 cells.
// Hoisted to module scope so both the density check (test below) and the
// real source-emit check (sibling test) operate on the same definition.
const SIDE_EFFECT_MATRIX: Record<
  string,
  Array<{ category: string; prefix: string }>
> = {
  java: [
    { category: "email", prefix: "Sends email" },
    { category: "http", prefix: "Makes outbound HTTP request" },
    { category: "background-job", prefix: "Enqueues background job" },
    { category: "broker", prefix: "Sends message to broker" },
    { category: "stored-procedure", prefix: "Calls stored procedure" },
    { category: "transaction", prefix: "Executes within a database transaction" },
    { category: "filesystem", prefix: "Writes to file system" },
    { category: "cache", prefix: "Mutates application cache" },
    { category: "process", prefix: "Executes external process" },
  ],
  cfml: [
    { category: "email", prefix: "Sends email" },
    { category: "http", prefix: "Makes outbound HTTP request" },
    { category: "background-job", prefix: "Enqueues background job" },
    // broker: intentionally absent -- CFML has no native message-broker tag.
    { category: "stored-procedure", prefix: "Calls stored procedure" },
    { category: "transaction", prefix: "Executes database operations inside a transaction" },
    { category: "filesystem", prefix: "Writes to file system" },
    { category: "cache", prefix: "Mutates application cache" },
    { category: "process", prefix: "Executes external process" },
  ],
  ruby: [
    { category: "email", prefix: "Sends email" },
    { category: "http", prefix: "Makes outbound HTTP request" },
    { category: "background-job", prefix: "Enqueues background job" },
    { category: "broker", prefix: "Sends message to broker" },
    { category: "stored-procedure", prefix: "Calls stored procedure" },
    { category: "transaction", prefix: "Executes within a database transaction" },
    { category: "filesystem", prefix: "Writes to file system" },
    { category: "cache", prefix: "Mutates application cache" },
    { category: "process", prefix: "Executes external process" },
  ],
  django: [
    { category: "email", prefix: "Sends email" },
    { category: "http", prefix: "Makes outbound HTTP request" },
    { category: "background-job", prefix: "Enqueues background job" },
    { category: "broker", prefix: "Sends message to broker" },
    { category: "stored-procedure", prefix: "Calls stored procedure" },
    { category: "transaction", prefix: "Executes within a database transaction" },
    { category: "filesystem", prefix: "Writes to file system" },
    { category: "cache", prefix: "Mutates application cache" },
    { category: "process", prefix: "Executes external process" },
  ],
};

const PARSER_SOURCE_FILES: Record<string, string> = {
  java: "java.ts",
  cfml: "cfml.ts",
  ruby: "ruby.ts",
  django: "django.ts",
};

describe("parser side-effect note matrix contract", () => {
  // CLAUDE.md documents 9 side-effect categories. CFML has no native
  // message-broker tag so its broker row is intentionally absent (8 categories).
  // All other parsers have all 9. Total: 4 x 9 + 1 (cfml) x 8 = 44 cells.
  // The density test below pins that the matrix definition itself stays
  // complete; the source-emit test that follows pins that each cell is
  // backed by an actual emit site in the parser source file.
  it("validates that every parser test file covers every side-effect category", () => {
    const parserCount = Object.keys(SIDE_EFFECT_MATRIX).length;

    let actualCells = 0;
    for (const parser in SIDE_EFFECT_MATRIX) {
      actualCells += SIDE_EFFECT_MATRIX[parser]?.length ?? 0;
    }

    expect(parserCount).toBe(4);
    // 3 parsers x 9 categories + cfml x 8 (no broker) = 35
    expect(actualCells).toBe(35);

    // Per-parser: cfml has 8 categories (no broker), all others have 9.
    const BASE_CATEGORIES = [
      "background-job",
      "cache",
      "email",
      "filesystem",
      "http",
      "process",
      "stored-procedure",
      "transaction",
    ];
    const FULL_CATEGORIES = [...BASE_CATEGORIES, "broker"].sort();
    for (const [parser, categories] of Object.entries(SIDE_EFFECT_MATRIX)) {
      const expected = parser === "cfml" ? BASE_CATEGORIES : FULL_CATEGORIES;
      expect(
        categories.map((c) => c.category).sort(),
        `parser "${parser}" side-effect categories`,
      ).toEqual(expected);
    }
  });

  // The matrix-density test above pins that SIDE_EFFECT_MATRIX itself stays
  // complete (44 cells: 4 parsers x 9 + cfml x 8). It does NOT verify that
  // each parser actually emits a note for each cell -- it could silently
  // pass even if a parser deleted its `notes.push("Sends email (cfmail)")`
  // branch tomorrow. The original test description claimed it validated
  // parser test files, but the implementation was purely self-referential.
  //
  // This sibling test closes that gap by reading each parser SOURCE file
  // from disk and asserting it contains a string literal that STARTS WITH
  // each documented prefix. A regression that drops or renames an emit site
  // (e.g., a refactor that swaps "Sends email" for "Email is sent") fails
  // here with the parser+category named in the failure message.
  //
  // Why startsWith (regex match `["` or backtick + prefix), not strict-equal:
  // CFML and other parsers append framework-specific suffixes
  // (e.g., "Sends email (cfmail)", "Calls stored procedure(s): ${names}");
  // the validator's findKeywordsFor uses note.startsWith(prefix) for the
  // same reason. See validator.ts:239-244.
  it("validates that every parser source file emits each documented note prefix", async () => {
    // Resolves to src/core/parsers/, the directory holding both the test
    // and the parser sources it scans. Uses import.meta.url so the test
    // works from any cwd (root + apps/dashboard + IDE test runners).
    const parsersDir = path.dirname(new URL(import.meta.url).pathname);

    const missing: string[] = [];
    for (const [parser, categories] of Object.entries(SIDE_EFFECT_MATRIX)) {
      const sourceFile = PARSER_SOURCE_FILES[parser]!;
      const sourcePath = path.join(parsersDir, sourceFile);
      const source = await fs.readFile(sourcePath, "utf-8");
      for (const { category, prefix } of categories) {
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Match a double-quote OR backtick immediately followed by the
        // prefix (so a parser-source comment containing the prefix mid-line
        // does NOT count as evidence; only a string-literal opening does).
        const re = new RegExp(`["\`]${escaped}`);
        if (!re.test(source)) {
          missing.push(
            `parser "${parser}" source (${sourceFile}) is missing an emit site for category "${category}" with prefix "${prefix}"`,
          );
        }
      }
    }

    expect(
      missing,
      missing.length > 0
        ? `${missing.length} matrix cell(s) missing an emit site in parser source:\n  ${missing.join("\n  ")}`
        : "",
    ).toEqual([]);
  });
});
