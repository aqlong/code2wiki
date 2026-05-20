import { describe, it, expect } from "vitest";
import { parseCfml } from "./cfml.js";

describe("parseCfml, tag-style functions", () => {
  it("finds a single <cffunction> and reports its name and line range", () => {
    const source = `<cfcomponent>
\t<cffunction name="hello" output="false">
\t\t<cfargument name="who" type="string" required="true">
\t\t<cfreturn "hello, " & arguments.who>
\t</cffunction>
</cfcomponent>
`;
    const candidates = parseCfml("/x/Hello.cfc", "Hello.cfc", source);
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.language).toBe("cfml");
    expect(c.kind).toBe("cf-tag-function");
    expect(c.name).toBe("hello");
    expect(c.lineStart).toBe(2);
    expect(c.lineEnd).toBe(5);
    expect(c.hints.parameters).toEqual([{ name: "who", type: "string" }]);
  });

  it("preserves line numbers across CFML comments", () => {
    const source = `<!---
This is a
long license
comment
spanning many
lines
that should not
break line numbering
of subsequent
functions in this
file at all
--->
<cfcomponent>
\t<cffunction name="afterComment">
\t\t<cfreturn 1>
\t</cffunction>
</cfcomponent>
`;
    const candidates = parseCfml("/x/X.cfc", "X.cfc", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.lineStart).toBe(14);
  });

  it("extracts database table names from <cfquery>", () => {
    const source = `<cfcomponent>
\t<cffunction name="fetchUsers">
\t\t<cfquery name="rs">
\t\t\tselect * from tusers where active = 1
\t\t</cfquery>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Y.cfc", "Y.cfc", source);
    expect(candidates[0]!.hints.databaseTables).toContain("tusers");
  });

  it("returns empty array for unsupported extensions", () => {
    const candidates = parseCfml("/x/Y.txt", "Y.txt", "irrelevant");
    expect(candidates).toEqual([]);
  });

  it("extracts multiple <cffunction> blocks in declaration order with correct line ranges", () => {
    // The while loop in parseTagFunctions advances fnOpen.lastIndex past the
    // close tag of each function. A regression that lost the advance (or that
    // mis-set fnClose.lastIndex) would silently emit only the first function
    // for any multi-function .cfc, that's most real CFCs, including every
    // controller / service file in MasaCMS.
    const source = `<cfcomponent>
\t<cffunction name="a"><cfreturn 1></cffunction>
\t<cffunction name="b"><cfreturn 2></cffunction>
\t<cffunction name="c"><cfreturn 3></cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/M.cfc", "M.cfc", source);
    expect(candidates.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(candidates.map((c) => c.lineStart)).toEqual([2, 3, 4]);
  });

  it("falls back to name='anonymous' when <cffunction> has no name attribute", () => {
    // Real-world: legacy CFML occasionally omits name on inline tag blocks.
    // The `attrs["name"] ?? "anonymous"` fallback keeps the candidate in the
    // pipeline (better to produce a generic doc than silently drop it).
    const source = `<cfcomponent>
\t<cffunction output="false">
\t\t<cfreturn 1>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/A.cfc", "A.cfc", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("anonymous");
  });

  it("pins lineEnd to the </cffunction> line, not the open or body", () => {
    // Existing tests assert lineStart but not lineEnd. A regression in
    // `closeMatch.index + closeMatch[0].length` (e.g. swapping in
    // closeMatch.index without the length) would silently shrink lineEnd
    // by one line, citation drift on every published page.
    const source = `<cfcomponent>
\t<cffunction name="multiLine">
\t\t<cfargument name="x" type="numeric">
\t\t<cfset var y = arguments.x * 2>
\t\t<cfreturn y>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/L.cfc", "L.cfc", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.lineStart).toBe(2);
    expect(candidates[0]!.lineEnd).toBe(6);
  });

  it("extracts callees while filtering CFML keywords and short names; dedups", () => {
    // The callee list is consumed by the LLM prompt to surface
    // collaborator functions. CFML's builtin function names (arrayLen,
    // structKeyExists, …) and short tokens (`if(`, `do(`) would pollute
    // the prompt and inflate cost. The filter + dedup is what keeps the
    // hint list signal-rich.
    const source = `<cfcomponent>
\t<cffunction name="doWork">
\t\t<cfset a = arrayLen(myArr)>
\t\t<cfset b = structKeyExists(req, "id")>
\t\t<cfset c = realHelper()>
\t\t<cfset d = realHelper()>
\t\t<cfset e = another()>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/C.cfc", "C.cfc", source);
    const callees = candidates[0]!.hints.callees ?? [];
    expect(callees).toContain("realHelper");
    expect(callees).toContain("another");
    expect(callees).not.toContain("arrayLen");
    expect(callees).not.toContain("structKeyExists");
    expect(callees.filter((c) => c === "realHelper")).toHaveLength(1);
  });

  it("caps callees at 30 to bound LLM prompt size", () => {
    // Mirrors the java parser's same-shape cap (parseJava extractCallees
    // .slice(0,30), pinned in java.test.ts at 18:19). A procedural batch
    // job calling 50 helpers shouldn't blow the prompt budget.
    const calls = Array.from({ length: 35 }, (_, i) => `\t\t<cfset helper${i}()>`).join("\n");
    const source = `<cfcomponent>
\t<cffunction name="fanout">
${calls}
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/F.cfc", "F.cfc", source);
    expect(candidates[0]!.hints.callees).toHaveLength(30);
  });

  it("captures plugin event names via announceEvent() into hints.notes", () => {
    // Plugin event taxonomy is a high-signal hint for the LLM, it
    // separates "fires the audit event" from "is a passive getter."
    // Both double- and single-quoted argument forms must capture.
    const source = `<cfcomponent>
\t<cffunction name="onSave">
\t\t<cfset announceEvent("beforeSave", args)>
\t\t<cfset announceEvent('afterSave')>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/E.cfc", "E.cfc", source);
    expect(candidates[0]!.hints.notes).toEqual([
      "Fires plugin events: beforeSave, afterSave",
    ]);
  });

  it("extracts table names across multiple <cfquery> blocks (FROM, UPDATE, JOIN)", () => {
    // Existing test only covered FROM; the regex also covers UPDATE,
    // INTO, JOIN, and dedupe across multiple <cfquery> blocks. A regression
    // narrowing the verb set would silently drop write-table citations
    // from the rendered "data touched" section of every use-case doc.
    const source = `<cfcomponent>
\t<cffunction name="report">
\t\t<cfquery name="a">
\t\t\tselect * from users u join roles r on r.id = u.role_id
\t\t</cfquery>
\t\t<cfquery name="b">
\t\t\tupdate sessions set last_seen = now() where id = <cfqueryparam value="#sid#">
\t\t</cfquery>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/T.cfc", "T.cfc", source);
    const tables = candidates[0]!.hints.databaseTables ?? [];
    expect(tables).toContain("users");
    expect(tables).toContain("roles");
    expect(tables).toContain("sessions");
  });
});

describe("parseCfml, script-style functions", () => {
  it("finds a script-style function inside a `component` block", () => {
    const source = `component {
\tfunction greet(required string who) {
\t\treturn "hi " & arguments.who;
\t}
}`;
    const candidates = parseCfml("/x/Greet.cfc", "Greet.cfc", source);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const greet = candidates.find((c) => c.name === "greet");
    expect(greet).toBeDefined();
    expect(greet!.kind).toBe("cf-script-function");
  });

  it("pins lineStart / lineEnd to the function keyword line and the closing brace line", () => {
    // The `function` keyword is on line 3; the close brace is on line 5.
    // matchingBrace finds the close at the correct depth, and the
    // `lastIndexOf("function", openParen)` anchor backs lineStart up from
    // the `(` to the keyword for clean citations.
    const source = `component {
\t/* doc */
\tfunction greet(required string who) {
\t\treturn "hi " & arguments.who;
\t}
}`;
    const candidates = parseCfml("/x/G.cfc", "G.cfc", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.lineStart).toBe(3);
    expect(candidates[0]!.lineEnd).toBe(5);
  });

  it("extracts multiple script functions in declaration order", () => {
    // fnRegex.lastIndex = closeBrace + 1 advances past each function's
    // body. A regression dropping the advance would re-match the first
    // function repeatedly (or stall the loop).
    const source = `component {
\tfunction one() { return 1; }
\tfunction two() { return 2; }
\tfunction three() { return 3; }
}`;
    const candidates = parseCfml("/x/N.cfc", "N.cfc", source);
    expect(candidates.map((c) => c.name)).toEqual(["one", "two", "three"]);
    expect(candidates.map((c) => c.kind)).toEqual([
      "cf-script-function",
      "cf-script-function",
      "cf-script-function",
    ]);
  });

  it("returns [] for a script-style function NOT inside `component { ... }`", () => {
    // The early-return gate at the top of parseScriptFunctions keeps
    // loose top-level `function` declarations (utility files, snippets,
    // tag-style files with no component wrapper) out of the candidate
    // list. A regression removing the gate would surface false positives
    // from page-level CFML.
    const source = `function loose() { return 1; }`;
    const candidates = parseCfml("/x/L.cfc", "L.cfc", source);
    expect(candidates).toEqual([]);
  });

  it("handles `{` and `}` characters inside string literals without terminating early", () => {
    // matchingBrace tracks string state with an `inString` flag so braces
    // inside `"..."` and `'...'` don't decrement depth. Real-world: SQL
    // builders + JSON-shaped strings + template literals are common in
    // CFML controller bodies. A regression to a plain brace counter would
    // close the function early at the first `{` inside a string.
    const source = `component {
\tfunction parseTpl() {
\t\tvar s = "{not a brace}";
\t\tvar t = '{nor this}';
\t\treturn s & t;
\t}
}`;
    const candidates = parseCfml("/x/S.cfc", "S.cfc", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("parseTpl");
    expect(candidates[0]!.lineStart).toBe(2);
    expect(candidates[0]!.lineEnd).toBe(6);
  });

  it("returns BOTH tag-style and script-style candidates from a mixed-mode .cfc", () => {
    // A real .cfc may declare a tag-style <cffunction> alongside a
    // script-style `component { function ... }`. parseCfml returns the
    // concatenation, which is what downstream rendering expects.
    const source = `<cfcomponent>
\t<cffunction name="tagFn"><cfreturn 1></cffunction>
</cfcomponent>
component {
\tfunction scriptFn() {
\t\treturn 2;
\t}
}`;
    const candidates = parseCfml("/x/Mix.cfc", "Mix.cfc", source);
    const byKind = (k: string) => candidates.filter((c) => c.kind === k).map((c) => c.name);
    expect(byKind("cf-tag-function")).toEqual(["tagFn"]);
    expect(byKind("cf-script-function")).toEqual(["scriptFn"]);
  });
});

describe("parseCfml, .cfm pages", () => {
  it("treats a non-trivial .cfm page as a single candidate", () => {
    const source = `<cfset x = 1>
<cfset y = 2>
<cfoutput>
\t<h1>Hello</h1>
\t<p>The sum is #x + y#</p>
</cfoutput>
`;
    const candidates = parseCfml("/x/page.cfm", "page.cfm", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.kind).toBe("cf-tag-function");
    expect(candidates[0]!.name).toBe("page");
  });

  it("skips trivial .cfm pages (just an include)", () => {
    const source = `<cfinclude template="other.cfm">`;
    const candidates = parseCfml("/x/include.cfm", "include.cfm", source);
    expect(candidates).toEqual([]);
  });

  it("skips a placeholder .cfm hook that contains only a cfscript // comment (real-world: fresh Wheels app's onApplicationStart.cfm)", () => {
    // Verbatim from references/wheels/app/events/onapplicationstart.cfm
    // 2026-05-09, the bug that motivated the filter. The earlier
    // "meaningful chars > 32" heuristic accepted this file because it
    // didn't strip cfscript-style // comments.
    const source = `<cfscript>
// Place code here that should be executed on the "onApplicationStart" event.
</cfscript>
`;
    const candidates = parseCfml(
      "/x/onapplicationstart.cfm",
      "app/events/onapplicationstart.cfm",
      source,
    );
    expect(candidates).toEqual([]);
  });

  it("skips a placeholder .cfm hook with only CFML tag comments and boilerplate", () => {
    const source = `<!--- onRequestEnd: empty by default --->
<cfscript>
/* placeholder: nothing yet */
</cfscript>
`;
    const candidates = parseCfml("/x/onrequestend.cfm", "onrequestend.cfm", source);
    expect(candidates).toEqual([]);
  });

  it("KEEPS a .cfm with real executable cfscript content even if short", () => {
    // 3 executable lines is the threshold; 4 must pass. Mirrors
    // onerror.cfm (35 lines with real error-handling logic).
    const source = `<cfscript>
var details = StructNew();
details.message = arguments.exception.message;
emailAdmin(details);
return details;
</cfscript>
`;
    const candidates = parseCfml("/x/onerror.cfm", "onerror.cfm", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.kind).toBe("cf-tag-function");
  });

  it("skips a .cfm whose only executable line is `<cfsetting>` boilerplate", () => {
    // The framework-boilerplate stripper matters: a page that only
    // bumps showDebugOutput shouldn't generate a use-case doc.
    const source = `<cfsetting showDebugOutput="false">
<cfscript>
// hook for future
</cfscript>
`;
    const candidates = parseCfml("/x/empty.cfm", "empty.cfm", source);
    expect(candidates).toEqual([]);
  });

  it("preserves the ORIGINAL .cfm source on the candidate's `source` field (NOT the comment-stripped variant)", () => {
    // Load-bearing asymmetry: parseCfmPage passes the original source to
    // the candidate while parseTagFunctions / parseScriptFunctions pass
    // the COMMENT-STRIPPED block. The LLM rendering pipeline relies on
    // .cfm pages preserving inline `<!--- … --->` comments because page-
    // level documentation often lives there (intent, ticket refs, dates).
    // A regression switching parseCfmPage to use the cleaned source would
    // silently drop that context from every page-level use case.
    const source = `<!--- ticket: PROJ-123 / author: ops --->
<cfset x = 1>
<cfset y = 2>
<cfoutput>#x + y#</cfoutput>
<cfset z = 3>`;
    const candidates = parseCfml("/x/page.cfm", "page.cfm", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.source).toBe(source);
    expect(candidates[0]!.source).toContain("<!--- ticket: PROJ-123 / author: ops --->");
  });
});

describe("parseCfml, comment stripping", () => {
  it("does NOT match function definitions inside a JSDoc /** ... */ comment block (real-world: fresh Wheels app's app/controllers/Controller.cfc)", () => {
    // The comment block contains EXAMPLE syntax including
    // `function config() { super.config(); }`. A naive script-function
    // regex matches inside the comment too, producing a duplicate
    // candidate. Verbatim from references/wheels 2026-05-09.
    const source = `/**
 * This is the parent controller file that all your controllers should extend.
 *
 * Example controller extending this one:
 *
 * component extends="Controller" {
 *   function config() {
 *     super.config();
 *   }
 * }
 */
component extends="wheels.Controller" {

\tfunction config() {
\t\tprotectsFromForgery();
\t}

}`;
    const candidates = parseCfml(
      "/x/Controller.cfc",
      "app/controllers/Controller.cfc",
      source,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("config");
    // Line numbers must point at the REAL function, not the example
    // inside the comment. Real config() starts on line 15 in the source.
    expect(candidates[0]!.lineStart).toBeGreaterThanOrEqual(14);
  });

  it("strips /* ... */ block comments and preserves line numbers of code that follows", () => {
    const source = `component {
\t/* comment block
\t   spanning
\t   several lines */
\tfunction afterBlock() {
\t\treturn 1;
\t}
}`;
    const candidates = parseCfml("/x/X.cfc", "X.cfc", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("afterBlock");
    expect(candidates[0]!.lineStart).toBe(5);
  });
});

describe("parseCfml, Application.cfc lifecycle hints", () => {
  it("adds a lifecycle note for known hooks in Application.cfc", () => {
    const source = `<cfcomponent>
  <cffunction name="onRequestStart">
    <cfargument name="targetPage" type="string">
    <cfreturn true>
  </cffunction>
  <cffunction name="onApplicationStart">
    <cfset application.startedAt = now()>
  </cffunction>
</cfcomponent>
`;
    const candidates = parseCfml(
      "/app/Application.cfc",
      "Application.cfc",
      source,
    );
    expect(candidates).toHaveLength(2);
    const req = candidates.find((c) => c.name === "onRequestStart");
    const app = candidates.find((c) => c.name === "onApplicationStart");
    expect(req?.hints.notes?.[0]).toMatch(/fires before EVERY request/);
    expect(app?.hints.notes?.[0]).toMatch(/fires once when the application/);
  });

  it("does NOT add lifecycle notes for non-Application.cfc files", () => {
    const source = `<cfcomponent>
  <cffunction name="onRequestStart">
    <cfreturn true>
  </cffunction>
</cfcomponent>
`;
    const candidates = parseCfml("/app/Router.cfc", "Router.cfc", source);
    expect(candidates[0]?.hints.notes).toBeUndefined();
  });

  it("is case-insensitive on the filename (application.cfc, APPLICATION.CFC)", () => {
    const source = `<cfcomponent>
  <cffunction name="onSessionStart">
  </cffunction>
</cfcomponent>
`;
    const lower = parseCfml("/a/application.cfc", "application.cfc", source);
    const upper = parseCfml("/a/APPLICATION.CFC", "APPLICATION.CFC", source);
    expect(lower[0]?.hints.notes?.[0]).toMatch(/lifecycle hook/);
    expect(upper[0]?.hints.notes?.[0]).toMatch(/lifecycle hook/);
  });

  it("does not overwrite existing notes, prepends lifecycle note", () => {
    const source = `<cfcomponent>
  <cffunction name="onApplicationStart">
    <cfset announceEvent("app.start")>
  </cffunction>
</cfcomponent>
`;
    const candidates = parseCfml(
      "/app/Application.cfc",
      "Application.cfc",
      source,
    );
    const notes = candidates[0]?.hints.notes ?? [];
    expect(notes[0]).toMatch(/lifecycle hook/);
    expect(notes.some((n) => n.includes("app.start"))).toBe(true);
  });
});

describe("parseCfml, single-quoted tag attributes", () => {
  it("parses cffunction name with single quotes", () => {
    const source = `<cfcomponent>
  <cffunction name='greet' output='false'>
    <cfreturn 'hi'>
  </cffunction>
</cfcomponent>
`;
    const candidates = parseCfml("/x/X.cfc", "X.cfc", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("greet");
  });

  it("parses cfargument with single-quoted type", () => {
    const source = `<cfcomponent>
  <cffunction name="doIt">
    <cfargument name='userId' type='numeric' required='true'>
  </cffunction>
</cfcomponent>
`;
    const candidates = parseCfml("/x/X.cfc", "X.cfc", source);
    expect(candidates[0]?.hints.parameters).toEqual([
      { name: "userId", type: "numeric" },
    ]);
  });
});

describe("parseCfml, ORM entity detection", () => {
  it("annotates all candidates with ORM entity note when <cfcomponent persistent='true'>", () => {
    const source = `<cfcomponent persistent="true" table="users">
  <cffunction name="getEmail"><cfreturn variables.email></cffunction>
  <cffunction name="setEmail"><cfargument name="v"><cfset variables.email = v></cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/User.cfc", "User.cfc", source);
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.hints.notes?.[0]).toMatch(/ORM persistent entity/);
    }
  });

  it("annotates script-style component with persistent='true'", () => {
    const source = `component persistent="true" table="products" extends="BaseEntity" {
  property name="id" fieldtype="id";
  function getLabel() { return variables.label; }
}`;
    const candidates = parseCfml("/x/Product.cfc", "Product.cfc", source);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]!.hints.notes?.[0]).toMatch(/ORM persistent entity/);
  });

  it("does NOT add ORM entity note for a plain non-persistent component", () => {
    const source = `<cfcomponent>
  <cffunction name="doWork"><cfreturn 1></cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Svc.cfc", "Svc.cfc", source);
    expect(candidates[0]!.hints.notes ?? []).not.toContain(
      expect.stringMatching(/ORM persistent entity/),
    );
  });

  it("prepends ORM entity note before other notes (e.g. announceEvent)", () => {
    const source = `<cfcomponent persistent="true">
  <cffunction name="save">
    <cfset announceEvent("beforeSave")>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/E.cfc", "E.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes[0]).toMatch(/ORM persistent entity/);
    expect(notes.some((n) => n.includes("beforeSave"))).toBe(true);
  });
});

describe("parseCfml, ORM call hints", () => {
  it("detects entityLoad and entitySave in a tag-style function body", () => {
    const source = `<cfcomponent>
  <cffunction name="saveUser">
    <cfset var user = entityLoad("User", arguments.id, true)>
    <cfset entitySave(user)>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/UserSvc.cfc", "UserSvc.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    const ormNote = notes.find((n) => n.startsWith("Calls ORM functions:"));
    expect(ormNote).toBeDefined();
    expect(ormNote).toMatch(/entityload/i);
    expect(ormNote).toMatch(/entitysave/i);
  });

  it("deduplicates repeated ORM calls", () => {
    const source = `<cfcomponent>
  <cffunction name="bulkSave">
    <cfloop array="#arguments.items#" item="item">
      <cfset entitySave(item)>
    </cfloop>
    <cfset ormFlush()>
    <cfset entitySave(extra)>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Bulk.cfc", "Bulk.cfc", source);
    const ormNote = (candidates[0]!.hints.notes ?? []).find((n) =>
      n.startsWith("Calls ORM functions:"),
    );
    expect(ormNote).toBeDefined();
    const parts = ormNote!.replace("Calls ORM functions: ", "").split(", ");
    expect(parts.filter((p) => p === "entitysave")).toHaveLength(1);
  });

  it("does not add ORM note when no ORM calls are present", () => {
    const source = `<cfcomponent>
  <cffunction name="plain"><cfreturn 1></cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/P.cfc", "P.cfc", source);
    expect(
      (candidates[0]!.hints.notes ?? []).some((n) =>
        n.startsWith("Calls ORM functions:"),
      ),
    ).toBe(false);
  });
});

describe("parseCfml, custom tag invocation hints", () => {
  it("detects <cf_tagname> custom tag invocations", () => {
    const source = `<cfcomponent>
  <cffunction name="sendConfirmation">
    <cf_sendEmail to="#arguments.email#" subject="Confirm">
    <cf_logAudit action="email_sent">
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Notify.cfc", "Notify.cfc", source);
    const note = (candidates[0]!.hints.notes ?? []).find((n) =>
      n.startsWith("Invokes custom tags:"),
    );
    expect(note).toBeDefined();
    expect(note).toMatch(/cf_sendemail/i);
    expect(note).toMatch(/cf_logaudit/i);
  });

  it("detects <cfmodule template='...'>", () => {
    const source = `<cfcomponent>
  <cffunction name="render">
    <cfmodule template="tags/header.cfm" title="Dashboard">
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Layout.cfc", "Layout.cfc", source);
    const note = (candidates[0]!.hints.notes ?? []).find((n) =>
      n.startsWith("Invokes custom tags:"),
    );
    expect(note).toBeDefined();
    expect(note).toMatch(/cfmodule:tags\/header\.cfm/);
  });

  it("deduplicates repeated custom tag invocations", () => {
    const source = `<cfcomponent>
  <cffunction name="loop">
    <cfloop list="#items#" index="i">
      <cf_widget id="#i#">
    </cfloop>
    <cf_widget id="extra">
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Loop.cfc", "Loop.cfc", source);
    const note = (candidates[0]!.hints.notes ?? []).find((n) =>
      n.startsWith("Invokes custom tags:"),
    );
    expect(note).toBeDefined();
    const parts = note!.replace("Invokes custom tags: ", "").split(", ");
    expect(parts.filter((p) => p === "cf_widget")).toHaveLength(1);
  });

  it("does not flag built-in <cf*> tags as custom tags", () => {
    const source = `<cfcomponent>
  <cffunction name="query">
    <cfquery name="rs">select 1</cfquery>
    <cfset x = 1>
    <cfreturn x>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Q.cfc", "Q.cfc", source);
    expect(
      (candidates[0]!.hints.notes ?? []).some((n) =>
        n.startsWith("Invokes custom tags:"),
      ),
    ).toBe(false);
  });
});

describe("parseCfml, dynamic dispatch hints", () => {
  it("detects createObject('component', path) and extracts the component path", () => {
    const source = `<cfcomponent>
  <cffunction name="build">
    <cfset var svc = createObject("component", "com.example.EmailService")>
    <cfreturn svc.send(arguments.msg)>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Factory.cfc", "Factory.cfc", source);
    const note = (candidates[0]!.hints.notes ?? []).find((n) =>
      n.startsWith("Dynamically instantiates components:"),
    );
    expect(note).toBeDefined();
    expect(note).toMatch(/com\.example\.EmailService/);
  });

  it("lists multiple distinct createObject targets", () => {
    const source = `<cfcomponent>
  <cffunction name="init">
    <cfset variables.db = createObject("component", "lib.DBService")>
    <cfset variables.mailer = createObject("component", "lib.MailService")>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Init.cfc", "Init.cfc", source);
    const note = (candidates[0]!.hints.notes ?? []).find((n) =>
      n.startsWith("Dynamically instantiates components:"),
    );
    expect(note).toBeDefined();
    expect(note).toMatch(/lib\.DBService/);
    expect(note).toMatch(/lib\.MailService/);
  });

  it("does not add dynamic dispatch note for createObject('java', ...)", () => {
    const source = `<cfcomponent>
  <cffunction name="getDate">
    <cfset var cal = createObject("java", "java.util.Calendar")>
    <cfreturn cal.getInstance()>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/J.cfc", "J.cfc", source);
    expect(
      (candidates[0]!.hints.notes ?? []).some((n) =>
        n.startsWith("Dynamically instantiates components:"),
      ),
    ).toBe(false);
  });
});

describe("parseCfml, countExecutableLines (substance heuristic)", () => {
  // Pulled out so the heuristic is independently testable without
  // having to construct synthetic file paths.
  it("counts each non-blank, non-comment, non-boilerplate line as executable", async () => {
    const { countExecutableLines } = await import("./cfml.js");
    expect(countExecutableLines(`<cfscript>\n// nope\n</cfscript>`)).toBe(0);
    expect(countExecutableLines(`a = 1\nb = 2\nc = 3`)).toBe(3);
    expect(
      countExecutableLines(
        `<!--- header --->\n<cfscript>\n/* block */\nvar x = 1;\n</cfscript>`,
      ),
    ).toBe(1);
  });
});
