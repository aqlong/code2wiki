import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runList } from "./list.js";

/**
 * Pins the `code2wiki list` CLI contract. Four load-bearing surfaces only
 * surface live on a regression:
 *
 *   1. Empty-candidates branch returns early with the exact phrasing
 *      `"No candidates found. Adjust include/exclude in your config."`,
 *      this is the only diagnostic a first-time user sees when their globs
 *      miss the source tree; a regression rephrasing it loses the
 *      "Adjust include/exclude" hint that tells them where to fix it.
 *   2. Primary-line format: `"  ${language.padEnd(4)} ${kind.padEnd(20)} ${name}${route}"`.
 *      `padEnd` widths are load-bearing for column alignment in terminals
 *      (a regression to padEnd(2) would un-align cfml/java mixed output);
 *      kind padEnd(20) accommodates the widest enum `controller-method` (17)
 *      with room to grow. Route suffix is ` [METHOD]` IFF
 *      `c.hints.httpRoute && c.hints.httpRoute.method`, both halves
 *      truthy. A regression dropping the inner `.method` check would emit
 *      ` [undefined]` for any candidate where the parser found a route
 *      shape but no verb.
 *   3. Secondary line: 7-space indent + `relativePath:lineStart-lineEnd`.
 *      The 7 spaces line up with the start of `name` on the primary line
 *      (2 + 4 + 1 + 20 + 1 = 28, but the secondary is half-indent for
 *      visual grouping); a regression to tab or 4-space would break grep
 *      patterns operators use to jump to source.
 *   4. `loadConfig` + `scanProject` are honored: a stray
 *      `code2wiki.config.json` in cwd MUST be loaded, and its include /
 *      exclude globs MUST narrow the scan. The list command is the
 *      operator's primary debugging tool for "why aren't my files
 *      showing up?", silently ignoring config would defeat its purpose.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-list-"));
});

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureConsole(): string[] {
  const log: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => {
    log.push(s);
  });
  return log;
}

async function write(rel: string, body: string): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf-8");
}

// Fixtures have non-trivial bodies so scanProject's constant-return
// filter (default-on, gated by includeConstantReturns) keeps them.
const ONE_FUNCTION_CFC = `<cfcomponent>
  <cffunction name="solo" access="public" returntype="any">
    <cfset var n = 1>
    <cfreturn n>
  </cffunction>
</cfcomponent>
`;

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

const REST_CONTROLLER_JAVA = `package demo;
@org.springframework.web.bind.annotation.RestController
public class Hello {
  @org.springframework.web.bind.annotation.GetMapping("/x")
  public String x() {
    String body = "x";
    return body;
  }
}
`;

describe("runList empty-candidates branch", () => {
  it("emits the no-candidates message verbatim on an empty project", async () => {
    const log = captureConsole();
    await runList({ cwd: dir });
    // Exact phrasing, the "Adjust include/exclude" hint is the only
    // forward-pointer a first-time user gets, and the test pins the
    // whole sentence so a "polish" rewrite that drops the hint trips.
    expect(log).toEqual([
      "No candidates found. Adjust include/exclude in your config.",
    ]);
  });

  it("does NOT print the Found-N header or any candidate lines when empty", async () => {
    const log = captureConsole();
    await runList({ cwd: dir });
    // No header, no per-candidate lines, the empty branch returns
    // early. A regression to fall through would emit
    // "Found 0 candidate use cases" + no body, which is uglier UX.
    expect(log.some((s) => /Found \d+ candidate use cases/.test(s))).toBe(
      false,
    );
    expect(log).toHaveLength(1);
  });

  it("treats a dir of only non-source files (.txt/.md) as empty (post-scan, not pre-include)", async () => {
    await write("README.md", "no source here\n");
    await write("notes.txt", "ignored\n");
    await write("config.json", "{}\n");
    const log = captureConsole();
    await runList({ cwd: dir });
    // Default include is **/*.java, **/*.cfc, **/*.cfm, none of these
    // match. Empty-message still fires (the branch checks the parsed
    // candidate count, not file count).
    expect(log).toEqual([
      "No candidates found. Adjust include/exclude in your config.",
    ]);
  });
});

describe("runList header line", () => {
  it("prints the Found-N header with a trailing blank line before candidates", async () => {
    await write("solo.cfc", ONE_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    // The template literal ends with `\n` so the console.log adds a
    // second newline, producing one blank line between header and
    // body. Pinning both the count and the layout.
    expect(log[0]).toBe(
      "Found 1 candidate use cases (showing all):\n",
    );
  });

  it("scales the Found-N count with the candidate set", async () => {
    await write("a.cfc", TWO_FUNCTION_CFC);
    await write("b.cfc", ONE_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    expect(log[0]).toBe(
      "Found 3 candidate use cases (showing all):\n",
    );
  });
});

describe("runList per-candidate primary-line format", () => {
  it("pads kind to width 20 (cf-tag-function → 15 chars + 5 trailing spaces)", async () => {
    await write("solo.cfc", ONE_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    // `cf-tag-function`.length === 15, padEnd(20) adds 5 trailing spaces.
    // The primary line is `  cfml cf-tag-function      solo`.
    // (2 leading + cfml + 1 sep + cf-tag-function + 5 pad + 1 sep + name)
    const primary = log.find((s) => s.includes("solo") && !s.includes(":"));
    expect(primary).toBeDefined();
    expect(primary).toBe("  cfml cf-tag-function      solo");
  });

  it("pads kind to width 20 (controller-method → 17 chars + 3 trailing spaces) and prepends `java`-padded language", async () => {
    await write("Hello.java", REST_CONTROLLER_JAVA);
    const log = captureConsole();
    await runList({ cwd: dir });
    // `java` is exactly 4 chars so padEnd(4) is a no-op.
    // `controller-method` is 17 chars; padEnd(20) adds 3 trailing spaces.
    // Name is `Hello.x` (className.methodName per parsers/java.ts L77).
    // Route suffix ` [GET]` appended (covered separately below).
    const primary = log.find((s) => /Hello\.x/.test(s));
    expect(primary).toBe(
      "  java controller-method    Hello.x [GET]",
    );
  });

  it("emits exactly one primary line per candidate (no duplication)", async () => {
    await write("solo.cfc", ONE_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    const primaryMatches = log.filter(
      (s) => /^\s{2}\S/.test(s) && /\bsolo\b/.test(s),
    );
    expect(primaryMatches).toHaveLength(1);
  });
});

describe("runList HTTP route suffix", () => {
  it("appends ` [GET]` to a controller-method primary line", async () => {
    await write("Hello.java", REST_CONTROLLER_JAVA);
    const log = captureConsole();
    await runList({ cwd: dir });
    const primary = log.find((s) => /Hello\.x/.test(s));
    expect(primary).toMatch(/ \[GET\]$/);
  });

  it("does NOT append a route suffix to a cf-tag-function (no httpRoute hint)", async () => {
    await write("solo.cfc", ONE_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    const primary = log.find((s) => /\bsolo\b/.test(s) && !s.includes(":"));
    // No `[METHOD]` token anywhere on the line. Pins the
    // `c.hints.httpRoute && c.hints.httpRoute.method` guard, a regression
    // to a single-half check (dropping `.method`) would emit `[undefined]`.
    expect(primary).not.toMatch(/\[[^\]]+\]/);
  });
});

describe("runList secondary line", () => {
  it("emits a 7-space-indented secondary line of `relativePath:lineStart-lineEnd` per candidate", async () => {
    await write("solo.cfc", ONE_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    const secondary = log.find((s) => s.includes("solo.cfc:"));
    expect(secondary).toBeDefined();
    // 7 leading spaces, then relativePath:line-line.
    expect(secondary).toMatch(/^ {7}solo\.cfc:\d+-\d+$/);
  });

  it("reports parser line ranges that scale per function (multi-function file)", async () => {
    await write("two.cfc", TWO_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    const secondaries = log.filter((s) => /^ {7}two\.cfc:/.test(s));
    expect(secondaries).toHaveLength(2);
    // The two candidates have distinct line ranges (alpha starts before beta).
    const ranges = secondaries.map((s) => {
      const m = s.match(/^ {7}two\.cfc:(\d+)-(\d+)$/);
      return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
    });
    expect(ranges[0]).not.toBeNull();
    expect(ranges[1]).not.toBeNull();
    expect(ranges[0]!.start).toBeLessThan(ranges[1]!.start);
  });
});

describe("runList ordering", () => {
  it("orders candidates alphabetically by relativePath across files", async () => {
    await write("c.cfc", ONE_FUNCTION_CFC);
    await write("a.cfc", ONE_FUNCTION_CFC);
    await write("b.cfc", ONE_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    const fileOrder: string[] = [];
    for (const line of log) {
      const m = line.match(/^ {7}([a-z])\.cfc:/);
      if (m) fileOrder.push(m[1]!);
    }
    // scanProject sorts; runList preserves. Pinning runList doesn't
    // accidentally re-sort or re-shuffle for "presentation".
    expect(fileOrder).toEqual(["a", "b", "c"]);
  });

  it("orders candidates within a file by ascending lineStart (alpha before beta)", async () => {
    await write("two.cfc", TWO_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    const nameOrder: string[] = [];
    for (const line of log) {
      // Primary line: `  cfml cf-tag-function      <name>`
      const m = line.match(/^ {2}cfml\s+cf-tag-function\s+(\w+)$/);
      if (m) nameOrder.push(m[1]!);
    }
    expect(nameOrder).toEqual(["alpha", "beta"]);
  });
});

describe("runList config respect", () => {
  it("honors a custom `include` glob written to code2wiki.config.json (java-only excludes .cfc)", async () => {
    await write("Hello.java", REST_CONTROLLER_JAVA);
    await write("ignored.cfc", ONE_FUNCTION_CFC);
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ include: ["**/*.java"] }),
      "utf-8",
    );
    const log = captureConsole();
    await runList({ cwd: dir });
    // .cfc file MUST not surface, loadConfig + scanProject honored.
    expect(log.some((s) => s.includes("ignored.cfc"))).toBe(false);
    expect(log.some((s) => s.includes("Hello.java"))).toBe(true);
  });

  it("honors a custom `exclude` glob written to code2wiki.config.json", async () => {
    await write("keep.cfc", ONE_FUNCTION_CFC);
    await write("skip-me/drop.cfc", ONE_FUNCTION_CFC);
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ exclude: ["**/skip-me/**"] }),
      "utf-8",
    );
    const log = captureConsole();
    await runList({ cwd: dir });
    expect(log.some((s) => s.includes("keep.cfc"))).toBe(true);
    expect(log.some((s) => s.includes("skip-me"))).toBe(false);
    expect(log.some((s) => s.includes("drop.cfc"))).toBe(false);
  });

  it("default exclude drops node_modules/ (no explicit config required)", async () => {
    await write("app.cfc", ONE_FUNCTION_CFC);
    await write("node_modules/pkg/installed.cfc", ONE_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    expect(log.some((s) => s.includes("app.cfc"))).toBe(true);
    expect(log.some((s) => s.includes("node_modules"))).toBe(false);
    expect(log.some((s) => s.includes("installed.cfc"))).toBe(false);
  });
});

const ASPX_WITH_HANDLERS = `<form runat="server">
  <asp:Button ID="btnSubmit" runat="server" OnClick="btnSubmit_Click" Text="Submit" />
  <asp:Button ID="btnCancel" runat="server" OnClick="btnCancel_Click" Text="Cancel" />
</form>
`;

const ASPX_NO_HANDLERS = `<form runat="server">
  <asp:Label ID="lblStatus" runat="server" Text="Status" />
</form>
`;

describe("runList aspx-page companion line", () => {
  it("does NOT emit a companion line for non-aspx candidates (cfml, java)", async () => {
    await write("solo.cfc", ONE_FUNCTION_CFC);
    await write("Hello.java", REST_CONTROLLER_JAVA);
    const log = captureConsole();
    await runList({ cwd: dir });
    expect(log.some((s) => s.startsWith("       companion:"))).toBe(false);
  });
});

describe("runList notes line", () => {
  it("does NOT emit a notes line when a candidate has no notes", async () => {
    await write("solo.cfc", ONE_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    expect(log.some((s) => s.startsWith("       notes:"))).toBe(false);
  });
});

const CFML_WITH_QUERY = `<cfcomponent>
  <cffunction name="getOrders" access="public" returntype="query">
    <cfquery name="q" datasource="ds">
      SELECT o.id, o.status FROM orders o
      JOIN customers c ON c.id = o.customer_id
    </cfquery>
    <cfreturn q>
  </cffunction>
</cfcomponent>
`;

describe("runList tables line", () => {
  it("emits a tables line when a candidate has hints.databaseTables", async () => {
    await write("Orders.cfc", CFML_WITH_QUERY);
    const log = captureConsole();
    await runList({ cwd: dir });
    const tablesLine = log.find((s) => s.startsWith("       tables:"));
    expect(tablesLine).toBeDefined();
    expect(tablesLine).toContain("orders");
    expect(tablesLine).toContain("customers");
  });

  it("joins multiple tables with commas on one line", async () => {
    await write("Orders.cfc", CFML_WITH_QUERY);
    const log = captureConsole();
    await runList({ cwd: dir });
    const tablesLine = log.find((s) => s.startsWith("       tables:"));
    expect(tablesLine).toBeDefined();
    expect(tablesLine).toMatch(/tables: \S+, \S+/);
  });

  it("does NOT emit a tables line when a candidate has no databaseTables", async () => {
    await write("solo.cfc", ONE_FUNCTION_CFC);
    const log = captureConsole();
    await runList({ cwd: dir });
    expect(log.some((s) => s.startsWith("       tables:"))).toBe(false);
  });
});
