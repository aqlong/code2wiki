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

  it("extracts callee names from legacy <cfinvoke method=\"X\"> tags", () => {
    // Legacy CFML invokes methods via cfinvoke; the method name lives in an
    // attribute, not followed by `(`, so the bare callee regex misses it.
    // Common in older ContentBox / MasaCMS / framework code, which is the
    // target market.
    const source = `<cfcomponent>
\t<cffunction name="orchestrate">
\t\t<cfinvoke component="\#variables.orderSvc\#" method="validateOrder" arg1="\#arguments.order\#" returnvariable="ok">
\t\t<cfinvoke component="\#variables.paymentSvc\#" method="chargeCard" returnvariable="charge">
\t\t<cfinvoke component="EmailService" method="sendReceipt">
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Orchestrator.cfc", "Orchestrator.cfc", source);
    const callees = candidates[0]!.hints.callees ?? [];
    expect(callees).toContain("validateOrder");
    expect(callees).toContain("chargeCard");
    expect(callees).toContain("sendReceipt");
  });

  it("deduplicates cfinvoke method names against same-named bare callees", () => {
    // If the same method is called both via <cfinvoke method="X"> and as a
    // direct X() call (mixed-style code), it should appear once in callees.
    const source = `<cfcomponent>
\t<cffunction name="mixed">
\t\t<cfinvoke component="svc" method="processItem">
\t\t<cfset r = processItem()>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/M.cfc", "M.cfc", source);
    const callees = candidates[0]!.hints.callees ?? [];
    expect(callees.filter((c) => c === "processItem")).toHaveLength(1);
  });

  it("does not surface cfinvoke method when the name is a CFML stdlib keyword", () => {
    // Defensive: a hypothetical <cfinvoke method="trim"> would otherwise leak
    // "trim" as a callee, which the filter explicitly excludes.
    const source = `<cfcomponent>
\t<cffunction name="weird">
\t\t<cfinvoke component="svc" method="trim">
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/W.cfc", "W.cfc", source);
    const callees = candidates[0]!.hints.callees ?? [];
    expect(callees).not.toContain("trim");
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

  it("extracts table names from queryExecute(...) script-form SQL (Lucee + ACF 2018+)", () => {
    // Modern CFML idiom across ColdBox / ContentBox / MasaCMS. Missing this
    // form silently dropped databaseTables for any service using the script
    // query API instead of the tag form.
    const source = `<cfcomponent>
\t<cffunction name="search">
\t\t<cfscript>
\t\t\tvar result = queryExecute(
\t\t\t\t"SELECT id, name FROM products WHERE active = 1",
\t\t\t\t{},
\t\t\t\t{datasource: "myDB"}
\t\t\t);
\t\t\tvar audit = queryExecute("INSERT INTO audit_log (action, user_id) VALUES (?, ?)", [arguments.action, arguments.userId]);
\t\t</cfscript>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Search.cfc", "Search.cfc", source);
    const tables = candidates[0]!.hints.databaseTables ?? [];
    expect(tables).toContain("products");
    expect(tables).toContain("audit_log");
  });

  it("handles single-quoted SQL inside queryExecute(...)", () => {
    // CFML accepts both double and single quotes for string literals; both
    // forms appear in customer code.
    const source = `<cfcomponent>
\t<cffunction name="get">
\t\t<cfset var u = queryExecute('SELECT id FROM users WHERE email = :email', {email: arguments.email})>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/U.cfc", "U.cfc", source);
    const tables = candidates[0]!.hints.databaseTables ?? [];
    expect(tables).toContain("users");
  });

  it("merges tables across tag-form <cfquery> and script-form queryExecute in one function", () => {
    const source = `<cfcomponent>
\t<cffunction name="hybrid">
\t\t<cfquery name="legacy">SELECT * FROM legacy_orders</cfquery>
\t\t<cfscript>
\t\t\tqueryExecute("SELECT id FROM new_orders WHERE status = 'open'");
\t\t</cfscript>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/H.cfc", "H.cfc", source);
    const tables = candidates[0]!.hints.databaseTables ?? [];
    expect(tables).toContain("legacy_orders");
    expect(tables).toContain("new_orders");
  });

  it("extracts tables when the queryExecute(...) SQL literal spans multiple lines", () => {
    // The original 0f99367 commit comment claimed multi-line SQL was "out of
    // scope" for the queryExecute regex, but `[^"]` matches newlines in JS so
    // a single string literal split across lines does in fact extract tables.
    // This is the dominant readable shape in customer code (formatted SQL
    // with one clause per line); pinning it prevents a "tightening" of the
    // regex (e.g. switching to `[^"\\n]*` for non-greedy intent) from
    // silently regressing the captured-table set on every multi-line query.
    const source = `<cfcomponent>
\t<cffunction name="report">
\t\t<cfscript>
\t\t\tvar rows = queryExecute(
\t\t\t\t"SELECT u.id, u.name
\t\t\t\t FROM customers u
\t\t\t\t JOIN account_balances ab ON ab.user_id = u.id
\t\t\t\t WHERE u.active = 1",
\t\t\t\t{},
\t\t\t\t{datasource: "myDB"}
\t\t\t);
\t\t</cfscript>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/R.cfc", "R.cfc", source);
    const tables = candidates[0]!.hints.databaseTables ?? [];
    expect(tables).toContain("customers");
    expect(tables).toContain("account_balances");
  });

  it("extracts tables from UPDATE and JOIN keywords inside queryExecute(...)", () => {
    // 0f99367 added tests for SELECT/FROM and INSERT/INTO through the script
    // form but not UPDATE or JOIN. UPDATE and JOIN flow through the SAME
    // FROM/UPDATE/INTO/JOIN scan loop in extractCfmlHints, but they do so
    // only after queryExecute's regex has captured the SQL; pinning them
    // through the script-form path catches a regression where someone
    // narrows the SQL-extraction regex without updating the verb scan
    // (or vice versa).
    const source = `<cfcomponent>
\t<cffunction name="mutate">
\t\t<cfscript>
\t\t\tqueryExecute("UPDATE inventory SET qty = qty - 1 WHERE sku = ?", [arguments.sku]);
\t\t\tqueryExecute("SELECT o.id FROM orders o JOIN line_items li ON li.order_id = o.id WHERE o.user_id = ?", [arguments.uid]);
\t\t</cfscript>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/M.cfc", "M.cfc", source);
    const tables = candidates[0]!.hints.databaseTables ?? [];
    expect(tables).toContain("inventory");
    expect(tables).toContain("orders");
    expect(tables).toContain("line_items");
  });

  it("extracts the table from schema-qualified SQL (dbo.Users, schema.table)", () => {
    // Real-world enterprise CFML codebases (SQL Server, Oracle, multi-tenant
    // setups) routinely qualify tables with schema prefixes. The pre-fix
    // regex captured "dbo" as the table name. Now the LAST segment of any
    // dotted identifier wins.
    const source = `<cfcomponent>
\t<cffunction name="enterprise">
\t\t<cfquery name="a">SELECT * FROM dbo.Users WHERE active = 1</cfquery>
\t\t<cfquery name="b">UPDATE myDb.dbo.Orders SET status = 'shipped' WHERE id = 1</cfquery>
\t\t<cfquery name="c">SELECT u.id FROM dbo.Users u JOIN dbo.Roles r ON r.id = u.role_id</cfquery>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/E.cfc", "E.cfc", source);
    const tables = candidates[0]!.hints.databaseTables ?? [];
    // Schema-qualified names extract the actual table name, not the schema.
    expect(tables).toContain("Users");
    expect(tables).toContain("Orders");
    expect(tables).toContain("Roles");
    // Schema prefixes do NOT pollute the table list.
    expect(tables).not.toContain("dbo");
    expect(tables).not.toContain("myDb");
  });

  it("extracts the table from SQL Server bracketed identifiers ([dbo].[Users])", () => {
    // ColdFusion + SQL Server is a classic enterprise stack; the bracketed
    // identifier form appears constantly in production code. The pre-fix
    // regex required [a-zA-Z_] right after FROM/JOIN, so [ never matched
    // and these tables were silently dropped.
    const source = `<cfcomponent>
\t<cffunction name="mssqlReport">
\t\t<cfquery name="a">SELECT * FROM [dbo].[Users] WHERE [Active] = 1</cfquery>
\t\t<cfquery name="b">UPDATE [dbo].[Orders] SET [Status] = 'shipped'</cfquery>
\t\t<cfquery name="c">SELECT * FROM [Users] u JOIN [Roles] r ON r.[Id] = u.[RoleId]</cfquery>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/M.cfc", "M.cfc", source);
    const tables = candidates[0]!.hints.databaseTables ?? [];
    expect(tables).toContain("Users");
    expect(tables).toContain("Orders");
    expect(tables).toContain("Roles");
    expect(tables).not.toContain("dbo");
  });

  it("extracts the table from MySQL backtick-quoted identifiers", () => {
    const source = `<cfcomponent>
\t<cffunction name="mysqlList">
\t\t<cfquery name="a">SELECT \`id\`, \`name\` FROM \`users\` WHERE \`active\` = 1</cfquery>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/My.cfc", "My.cfc", source);
    const tables = candidates[0]!.hints.databaseTables ?? [];
    expect(tables).toContain("users");
  });

  it("extracts the table from Postgres double-quoted identifiers", () => {
    const source = `<cfcomponent>
\t<cffunction name="pgList">
\t\t<cfquery name="a">SELECT "id" FROM "public"."users" WHERE "active" = true</cfquery>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Pg.cfc", "Pg.cfc", source);
    const tables = candidates[0]!.hints.databaseTables ?? [];
    expect(tables).toContain("users");
    expect(tables).not.toContain("public");
  });

  it("extracts schema-qualified tables from queryExecute(...) script form too", () => {
    const source = `<cfcomponent>
\t<cffunction name="report">
\t\t<cfscript>
\t\t\tqueryExecute("SELECT count(*) FROM analytics.events WHERE day = current_date");
\t\t</cfscript>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/R.cfc", "R.cfc", source);
    const tables = candidates[0]!.hints.databaseTables ?? [];
    expect(tables).toContain("events");
    expect(tables).not.toContain("analytics");
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

  it("skips tag-style functions with access=\"private\"", () => {
    const source = `<cfcomponent>
\t<cffunction name="create" access="public" output="false">
\t\t<cfreturn "ok">
\t</cffunction>
\t<cffunction name="buildQueryString" access="private" output="false">
\t\t<cfreturn "?foo=1">
\t</cffunction>
\t<cffunction name="search" access="remote" output="false">
\t\t<cfreturn "[]">
\t</cffunction>
</cfcomponent>
`;
    const candidates = parseCfml("/x/Widget.cfc", "Widget.cfc", source);
    const names = candidates.map((c) => c.name);
    expect(names).toContain("create");
    expect(names).toContain("search");
    expect(names).not.toContain("buildQueryString");
  });

  it("adds a remote-access note for tag-style access=\"remote\" functions", () => {
    const source = `<cfcomponent>
\t<cffunction name="publicFn" access="public" output="false">
\t\t<cfreturn "ok">
\t</cffunction>
\t<cffunction name="remoteFn" access="remote" output="false">
\t\t<cfreturn "data">
\t</cffunction>
</cfcomponent>
`;
    const cs = parseCfml("/x/Api.cfc", "Api.cfc", source);
    const pub = cs.find((c) => c.name === "publicFn")!;
    const remote = cs.find((c) => c.name === "remoteFn")!;
    expect(pub.hints.notes?.some((n) => n.includes("remote"))).toBeFalsy();
    expect(remote.hints.notes?.[0]).toMatch(/access: remote/);
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

  it("skips script-style functions declared private", () => {
    const source = `component {
\tpublic string function create(required string name) {
\t\treturn "ok";
\t}
\tprivate string function buildSql(required string filter) {
\t\treturn "SELECT 1";
\t}
\tremote array function search(required string q) {
\t\treturn [];
\t}
}`;
    const candidates = parseCfml("/x/Item.cfc", "Item.cfc", source);
    const names = candidates.map((c) => c.name);
    expect(names).toContain("create");
    expect(names).toContain("search");
    expect(names).not.toContain("buildSql");
  });

  it("adds a remote-access note for script-style remote functions", () => {
    const source = `component {
\tpublic string function create(required string name) {
\t\treturn "ok";
\t}
\tremote array function search(required string q) {
\t\treturn [];
\t}
}`;
    const cs = parseCfml("/x/Item.cfc", "Item.cfc", source);
    const create = cs.find((c) => c.name === "create")!;
    const search = cs.find((c) => c.name === "search")!;
    expect(create.hints.notes?.some((n) => n.includes("remote"))).toBeFalsy();
    expect(search.hints.notes?.[0]).toMatch(/access: remote/);
  });

  it("script-style block starts at 'function' keyword, not at the access modifier", () => {
    // The `block` / `source` field for script-style functions is sliced from the
    // `function` keyword onwards, so the `remote` access modifier does NOT appear
    // in source. hints.notes is therefore the sole LLM-visible signal that this
    // function is HTTP-callable. Pinning this so a future refactor of the start
    // anchor doesn't silently break the load-bearing note assumption.
    const source = `component {
\tremote string function getData() {
\t\treturn "payload";
\t}
}`;
    const cs = parseCfml("/x/Svc.cfc", "Svc.cfc", source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.source).not.toMatch(/\bremote\b/);
    expect(cs[0]!.hints.notes?.[0]).toMatch(/access: remote/);
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

  it("ORM entity note appears before access:remote note on a remote function in a persistent CFC", () => {
    // annotateOrmEntity runs after parseTagFunctions, which already prepended the
    // access:remote note. The ORM annotator prepends its own note, so the final
    // order must be [ORM entity, access:remote, ...]. Pinning this so a refactor
    // of the annotation order doesn't silently break the priority contract.
    const source = `<cfcomponent persistent="true" table="orders">
  <cffunction name="getStatus" access="remote" output="false">
    <cfreturn variables.status>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Order.cfc", "Order.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes[0]).toMatch(/ORM persistent entity/);
    expect(notes[1]).toMatch(/access: remote/);
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

  it("accumulates the plugin-events note alongside the ORM note", () => {
    // The plugin-events branch is the only note block that historically
    // assigned hints.notes directly instead of spreading the prior value;
    // every other branch appends. This pins the accumulation contract so a
    // future reorder that puts another note block before the events branch
    // can never silently clobber it.
    const source = `<cfcomponent>
  <cffunction name="publishPost">
    <cfset entitySave(post)>
    <cfset announceEvent("postPublished", { id = post.getId() })>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/PostSvc.cfc", "PostSvc.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.startsWith("Calls ORM functions:"))).toBe(true);
    expect(notes.some((n) => n.startsWith("Fires plugin events:"))).toBe(true);
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

// ---- roles attribute (CFML access control) --------------------------------

describe("parseCfml, roles attribute", () => {
  it("surfaces roles from a tag-style cffunction as a notes hint", () => {
    const source = `<cfcomponent>
  <cffunction name="deleteUser" access="remote" roles="admin,manager">
    <cfargument name="id" type="numeric" required="true">
    <cfset application.userService.delete(arguments.id)>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/UserService.cfc", "UserService.cfc", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.notes).toContain("roles: admin,manager");
  });

  it("notes order: access:remote appears before roles", () => {
    const source = `<cfcomponent>
  <cffunction name="adminOnly" access="remote" roles="admin">
    <cfreturn true>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/AdminService.cfc", "AdminService.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    const remoteIdx = notes.findIndex((n) => n.startsWith("access: remote"));
    const rolesIdx = notes.findIndex((n) => n.startsWith("roles:"));
    expect(remoteIdx).toBeGreaterThanOrEqual(0);
    expect(rolesIdx).toBeGreaterThanOrEqual(0);
    expect(remoteIdx).toBeLessThan(rolesIdx);
  });

  it("does not add a roles note when roles attribute is absent", () => {
    const source = `<cfcomponent>
  <cffunction name="getUser" access="public">
    <cfreturn {}>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/UserService.cfc", "UserService.cfc", source);
    expect((candidates[0]!.hints.notes ?? []).some((n) => n.startsWith("roles:"))).toBe(false);
  });

  it("surfaces roles from a script-style cffunction", () => {
    const source = `component {
  remote function deleteUser() roles="admin,manager" {
    application.userService.delete(arguments.id);
  }
}`;
    const candidates = parseCfml("/x/UserService.cfc", "UserService.cfc", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.notes).toContain("roles: admin,manager");
  });
});

// ---- script-style inline parameter extraction ---------------------------

describe("parseCfml, script-style parameter extraction", () => {
  it("extracts a typed required parameter", () => {
    const source = `component {
  public string function getUser(required numeric id) {
    return application.userService.get(arguments.id);
  }
}`;
    const candidates = parseCfml("/x/UserService.cfc", "UserService.cfc", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.parameters).toEqual([{ name: "id", type: "numeric" }]);
  });

  it("extracts multiple parameters with mixed types and defaults", () => {
    const source = `component {
  public query function search(required string query, numeric maxResults = 20, boolean includeArchived = false) {
    return application.searchService.run(arguments.query);
  }
}`;
    const candidates = parseCfml("/x/SearchService.cfc", "SearchService.cfc", source);
    expect(candidates[0]!.hints.parameters).toEqual([
      { name: "query", type: "string" },
      { name: "maxResults", type: "numeric" },
      { name: "includeArchived", type: "boolean" },
    ]);
  });

  it("handles untyped parameter (name only)", () => {
    const source = `component {
  public void function process(config) {
    application.processor.run(arguments.config);
  }
}`;
    const candidates = parseCfml("/x/Processor.cfc", "Processor.cfc", source);
    expect(candidates[0]!.hints.parameters).toEqual([{ name: "config" }]);
  });

  it("handles a PascalCase component type", () => {
    const source = `component {
  public boolean function validate(required UserDTO user) {
    return application.validator.check(arguments.user);
  }
}`;
    const candidates = parseCfml("/x/ValidatorService.cfc", "ValidatorService.cfc", source);
    expect(candidates[0]!.hints.parameters).toEqual([{ name: "user", type: "UserDTO" }]);
  });

  it("returns no parameters for a zero-argument function", () => {
    const source = `component {
  public void function init() {
    application.ready = true;
  }
}`;
    const candidates = parseCfml("/x/AppService.cfc", "AppService.cfc", source);
    expect(candidates[0]!.hints.parameters).toBeUndefined();
  });

  it("does not overwrite parameters already found via cfargument tags", () => {
    // Legacy mixed-mode: <cfargument> inside a script-style function block.
    const source = `component {
  public string function legacyGet(required numeric id) {
    <cfargument name="id" type="numeric" required="true">
    return application.service.get(arguments.id);
  }
}`;
    const candidates = parseCfml("/x/LegacyService.cfc", "LegacyService.cfc", source);
    // cfargument takes priority; we still get exactly one parameter entry.
    expect(candidates[0]!.hints.parameters).toHaveLength(1);
    expect(candidates[0]!.hints.parameters?.[0]?.name).toBe("id");
  });

  // Pins the depth-aware comma-splitter and equals-stripper inside
  // extractScriptStyleParams. A regression to a naive `.split(",")` (or to
  // an equals-strip that ignores bracket depth) would silently spawn phantom
  // params from struct / array / function-call default values, then misclassify
  // them as untyped name-only parameters. Real-world example: a controller
  // method `process(struct config = {a: 1, b: 2}, string name)` would emit a
  // bogus `{ name: "2}" }` parameter under a naive split, polluting the LLM
  // prompt's parameter list with garbage tokens.
  it("handles bracketed and function-call defaults without phantom params", () => {
    const source = `component {
  public void function process(struct config = {a: 1, b: 2}, numeric val = max(1, 2), array items = [1, 2, 3], string name) {
    application.processor.run(arguments.config);
  }
}`;
    const candidates = parseCfml("/x/Processor.cfc", "Processor.cfc", source);
    expect(candidates[0]!.hints.parameters).toEqual([
      { name: "config", type: "struct" },
      { name: "val", type: "numeric" },
      { name: "items", type: "array" },
      { name: "name", type: "string" },
    ]);
  });
});

describe("parseCfml, cfmail and cfhttp side-effect hints", () => {
  it("surfaces 'Sends email (cfmail)' note when tag-style cfmail is present", () => {
    const source = `<cfcomponent>
  <cffunction name="sendWelcome">
    <cfmail to="#arguments.email#" from="noreply@example.com" subject="Welcome">Hello</cfmail>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Mailer.cfc", "Mailer.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n === "Sends email (cfmail)")).toBe(true);
  });

  it("surfaces 'Sends email (cfmail)' note for script-style cfmail call", () => {
    const source = `<cfcomponent>
  <cffunction name="sendWelcome">
    <cfscript>
      cfmail(to=arguments.email, from="noreply@example.com", subject="Hi") {
        writeOutput("Hello");
      }
    </cfscript>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Mailer.cfc", "Mailer.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n === "Sends email (cfmail)")).toBe(true);
  });

  it("surfaces 'Makes outbound HTTP request (cfhttp)' when tag-style cfhttp is present", () => {
    const source = `<cfcomponent>
  <cffunction name="fetchData">
    <cfhttp url="https://api.example.com/data" method="GET" result="result">
    </cfhttp>
    <cfreturn result.fileContent>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/ApiClient.cfc", "ApiClient.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n === "Makes outbound HTTP request (cfhttp)")).toBe(true);
  });

  it("surfaces 'Makes outbound HTTP request (cfhttp)' for script-style cfhttp call", () => {
    const source = `<cfcomponent>
  <cffunction name="callApi">
    <cfscript>
      cfhttp(url="https://api.example.com/v1/users", method="POST", result="res");
    </cfscript>
    <cfreturn res.fileContent>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Client.cfc", "Client.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n === "Makes outbound HTTP request (cfhttp)")).toBe(true);
  });

  it("surfaces 'Makes outbound HTTP request (cfinvoke webservice)' for tag-style SOAP invocation", () => {
    // <cfinvoke webservice="..."> is the CFML tag form for calling a SOAP
    // web service -- makes an outbound HTTP call to a WSDL endpoint.
    const source = `<cfcomponent>
  <cffunction name="getWeatherForecast">
    <cfinvoke webservice="http://weather.example.com/service?wsdl"
              method="getForecast"
              returnvariable="forecast">
      <cfinvokeargument name="city" value="#arguments.city#">
    </cfinvoke>
    <cfreturn forecast>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Weather.cfc", "Weather.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n === "Makes outbound HTTP request (cfinvoke webservice)")).toBe(true);
  });

  it("surfaces 'Makes outbound HTTP request (cfinvoke webservice)' for CreateObject webservice form", () => {
    // CreateObject("webservice", url) is the CFScript equivalent of
    // <cfinvoke webservice="...">, also makes an outbound SOAP/HTTP call.
    const source = `<cfcomponent>
  <cffunction name="lookupProduct">
    <cfscript>
      var ws = CreateObject("webservice", "http://catalog.example.com/api?wsdl");
      var result = ws.getProduct(arguments.sku);
    </cfscript>
    <cfreturn result>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Catalog.cfc", "Catalog.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n === "Makes outbound HTTP request (cfinvoke webservice)")).toBe(true);
  });

  it("surfaces 'Makes outbound HTTP request (cfinvoke webservice)' for cfobject type=webservice (ColdFusion MX two-step form)", () => {
    // <cfobject type="webservice"> is the oldest CFML SOAP proxy form, from
    // ColdFusion MX 6.x/7.x (2002-2008). Creates a proxy variable; the WSDL
    // is resolved (outbound HTTP) at cfobject evaluation time.
    const source = `<cfcomponent>
  <cffunction name="getStockQuote">
    <cfobject type="webservice"
              name="stockWS"
              webservice="http://finance.example.com/quotes?wsdl">
    <cfset result = stockWS.getQuote(arguments.symbol)>
    <cfreturn result>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Finance.cfc", "Finance.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n === "Makes outbound HTTP request (cfinvoke webservice)")).toBe(true);
  });

  it("does NOT fire cfinvoke webservice note for cfobject type=java (non-webservice cfobject)", () => {
    // <cfobject type="java"> creates a Java object locally -- no outbound HTTP.
    const source = `<cfcomponent>
  <cffunction name="formatDate">
    <cfobject type="java" class="java.text.SimpleDateFormat" name="sdf">
    <cfset sdf.init("yyyy-MM-dd")>
    <cfreturn sdf.format(arguments.date)>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/DateUtil.cfc", "DateUtil.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("cfinvoke webservice"))).toBe(false);
  });

  it("does NOT fire cfinvoke webservice note for plain component invocations", () => {
    // <cfinvoke component="LocalCFC"> calls a local component, no outbound HTTP.
    const source = `<cfcomponent>
  <cffunction name="placeOrder">
    <cfinvoke component="#variables.inventorySvc#" method="checkStock" returnvariable="ok">
    </cfinvoke>
    <cfreturn ok>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Order.cfc", "Order.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("cfinvoke webservice"))).toBe(false);
  });

  it("does not add cfmail note when cfmail is absent", () => {
    const source = `<cfcomponent>
  <cffunction name="getData">
    <cfquery name="rs">select 1</cfquery>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Q.cfc", "Q.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("email"))).toBe(false);
  });
});

describe("parseCfml, cftransaction and cfstoredproc side-effect hints", () => {
  it("surfaces transaction note when cftransaction tag is present", () => {
    const source = `<cfcomponent>
  <cffunction name="transferFunds">
    <cftransaction>
      <cfquery>UPDATE accounts SET balance = balance - 100 WHERE id = 1</cfquery>
      <cfquery>UPDATE accounts SET balance = balance + 100 WHERE id = 2</cfquery>
    </cftransaction>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Banking.cfc", "Banking.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("transaction"))).toBe(true);
  });

  it("surfaces stored procedure note with procedure name from cfstoredproc", () => {
    const source = `<cfcomponent>
  <cffunction name="getCustomerSummary">
    <cfstoredproc procedure="sp_GetCustomerSummary" datasource="myDB">
      <cfprocparam type="In" cfsqltype="CF_SQL_INTEGER" value="#arguments.customerId#">
    </cfstoredproc>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Customer.cfc", "Customer.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    const spNote = notes.find((n) => n.startsWith("Calls stored procedure(s):"));
    expect(spNote).toBeDefined();
    expect(spNote).toMatch(/sp_GetCustomerSummary/);
  });

  it("lists multiple distinct stored procedures", () => {
    const source = `<cfcomponent>
  <cffunction name="runReport">
    <cfstoredproc procedure="sp_GetOrders" datasource="myDB"></cfstoredproc>
    <cfstoredproc procedure="sp_GetLineItems" datasource="myDB"></cfstoredproc>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Report.cfc", "Report.cfc", source);
    const spNote = (candidates[0]!.hints.notes ?? []).find((n) =>
      n.startsWith("Calls stored procedure(s):"),
    );
    expect(spNote).toBeDefined();
    expect(spNote).toMatch(/sp_GetOrders/);
    expect(spNote).toMatch(/sp_GetLineItems/);
  });

  it("surfaces stored procedure note for script-style `storedproc { ... }` block (Lucee, ACF 2018+)", () => {
    const source = `<cfcomponent>
  <cffunction name="getCustomer">
    <cfscript>
      storedproc procedure="sp_GetCustomer" datasource="myDB" {
        procparam type="In" cfsqltype="CF_SQL_INTEGER" value=arguments.id;
        procresult name="result";
      }
    </cfscript>
    <cfreturn result>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Customer.cfc", "Customer.cfc", source);
    const spNote = (candidates[0]!.hints.notes ?? []).find((n) =>
      n.startsWith("Calls stored procedure(s):"),
    );
    expect(spNote).toBeDefined();
    expect(spNote).toMatch(/sp_GetCustomer/);
  });

  it("surfaces stored procedure note for script-style `cfstoredproc(...)` function call", () => {
    const source = `<cfcomponent>
  <cffunction name="archiveOrders">
    <cfscript>
      cfstoredproc(procedure="sp_ArchiveOrders", datasource="myDB");
    </cfscript>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Orders.cfc", "Orders.cfc", source);
    const spNote = (candidates[0]!.hints.notes ?? []).find((n) =>
      n.startsWith("Calls stored procedure(s):"),
    );
    expect(spNote).toBeDefined();
    expect(spNote).toMatch(/sp_ArchiveOrders/);
  });

  it("deduplicates the same procedure across tag and script forms in one function", () => {
    const source = `<cfcomponent>
  <cffunction name="hybrid">
    <cfstoredproc procedure="sp_Common" datasource="myDB"></cfstoredproc>
    <cfscript>
      cfstoredproc(procedure="sp_Common", datasource="myDB");
    </cfscript>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/H.cfc", "H.cfc", source);
    const spNote = (candidates[0]!.hints.notes ?? []).find((n) =>
      n.startsWith("Calls stored procedure(s):"),
    );
    expect(spNote).toBeDefined();
    // sp_Common appears exactly once, not duplicated across patterns.
    const matches = spNote!.match(/sp_Common/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("does not add transaction or stored proc notes when neither tag is present", () => {
    const source = `<cfcomponent>
  <cffunction name="getItems">
    <cfquery name="rs">SELECT id FROM items</cfquery>
    <cfreturn rs>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Q.cfc", "Q.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("transaction") || n.includes("stored"))).toBe(false);
  });

  it("surfaces transaction note for script-style `transaction { ... }` block", () => {
    // Idiomatic CFML script form used heavily in ColdBox/ContentBox/MasaCMS.
    // No `cf` prefix; detection runs through the lookbehind regex.
    const source = `component {
\tfunction transferFunds() {
\t\ttransaction {
\t\t\tqueryExecute("UPDATE accounts SET balance = balance - 100 WHERE id = 1");
\t\t\tqueryExecute("UPDATE accounts SET balance = balance + 100 WHERE id = 2");
\t\t}
\t}
}`;
    const candidates = parseCfml("/x/Banking.cfc", "Banking.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("transaction"))).toBe(true);
  });

  it("surfaces transaction note for script-style `transaction action=\"X\";` statement", () => {
    // Wheels migrations use this no-braces form: action="begin"/"commit"/"rollback".
    const source = `component {
\tfunction up() {
\t\ttransaction action="begin";
\t\tqueryExecute("CREATE TABLE users (id INT)");
\t\ttransaction action="commit";
\t}
}`;
    const candidates = parseCfml("/x/Migration.cfc", "Migration.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("transaction"))).toBe(true);
  });

  it("surfaces transaction note for script-style `cftransaction(...)` function-call form", () => {
    // CFML's tags-as-functions form (Adobe CF11+, Lucee). The
    // `\bcftransaction\s*\(/i` alternative at cfml.ts:568 is the only
    // cftransaction alt unpinned in isolation: the tag form is line 1056,
    // the `transaction { }` block is line 1113, the `transaction action=`
    // statement is line 1129. A refactor that drops this branch would
    // silently degrade BLAST RADIUS / Notes signal for any CFML codebase
    // that uses the function-call syntax for transactions.
    const source = `component {
\tfunction transferFunds() {
\t\tcftransaction(action="begin");
\t\tqueryExecute("UPDATE accounts SET balance = balance - 100 WHERE id = 1");
\t\tcftransaction(action="commit");
\t}
}`;
    const candidates = parseCfml("/x/Banking.cfc", "Banking.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("transaction"))).toBe(true);
  });

  it("does NOT surface transaction note for assignment, struct literal, or method call look-alikes", () => {
    // The `(?:\{|action\s*=)` suffix filters out non-transaction uses of the
    // word "transaction": property assignment, identifier prefix, BIF/method
    // call. None of these are real CFML transactions.
    const source = `component {
\tfunction nonTx() {
\t\tlocal.transaction = createUUID();
\t\tvar myTransaction = { id: 1 };
\t\tlog.transaction("commit");
\t\treturn local.transaction;
\t}
}`;
    const candidates = parseCfml("/x/Nope.cfc", "Nope.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("transaction"))).toBe(false);
  });
});

describe("parseCfml, cache mutation side-effect hints", () => {
  it("surfaces note for cachePut / cacheRemove function calls", () => {
    const source = `<cfcomponent>
\t<cffunction name="refresh">
\t\t<cfset cachePut("feed:#arguments.userId#", buildFeed())>
\t\t<cfset cacheRemove("stale:#arguments.userId#")>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/F.cfc", "F.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes).toContain("Mutates application cache (cfcache)");
  });

  it("surfaces note for cacheRemoveAll / cacheClear (high blast radius)", () => {
    const source = `<cfcomponent>
\t<cffunction name="flushAll">
\t\t<cfset cacheRemoveAll()>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/F.cfc", "F.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes).toContain("Mutates application cache (cfcache)");
  });

  it("surfaces note for <cfcache action=\"flush\"> tag form", () => {
    const source = `<cfcomponent>
\t<cffunction name="invalidate">
\t\t<cfcache action="flush" key="user.#arguments.id#">
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/I.cfc", "I.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes).toContain("Mutates application cache (cfcache)");
  });

  it("does NOT surface cache note for cacheGet / cacheGetMetadata / cacheKeyExists (read-only)", () => {
    // Read-only access is intentionally NOT flagged. No blast radius beyond
    // a possible cache miss. Mirrors the @Cacheable exclusion in Java.
    const source = `<cfcomponent>
\t<cffunction name="show">
\t\t<cfset var feed = cacheGet("feed:#arguments.userId#")>
\t\t<cfset var meta = cacheGetMetadata("feed:#arguments.userId#")>
\t\t<cfset var hasIt = cacheKeyExists("feed:#arguments.userId#")>
\t\t<cfreturn feed>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/S.cfc", "S.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("cache"))).toBe(false);
  });

  it("does NOT surface cache note for <cfcache> default read-through caching action", () => {
    // Default <cfcache> (no action attr, or action="cache" / action="optimal")
    // is a read-through pattern, not a mutation. Like @Cacheable.
    const source = `<cfcomponent>
\t<cffunction name="render">
\t\t<cfcache timespan="#CreateTimeSpan(0,1,0,0)#">
\t\t<cfreturn "fragment">
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/R.cfc", "R.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("cache"))).toBe(false);
  });
});

describe("parseCfml, cffile filesystem side-effect hints", () => {
  it("surfaces 'Writes to file system (cffile)' for tag-style cffile action=write", () => {
    const source = `<cfcomponent>
\t<cffunction name="saveReport">
\t\t<cffile action="write" file="/tmp/report.csv" output="\#arguments.csv\#">
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/R.cfc", "R.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes).toContain("Writes to file system (cffile)");
  });

  it("surfaces filesystem note for every mutating cffile action variant", () => {
    // The mutating action set: write, upload, uploadall, append, delete,
    // move, rename, copy. Reads do NOT surface the note. Each variant is
    // tested in isolation so a regression narrowing the alternation list
    // names the broken action.
    const variants = ["write", "upload", "uploadAll", "append", "delete", "move", "rename", "copy"];
    for (const v of variants) {
      const source = `<cfcomponent>
\t<cffunction name="op_${v}">
\t\t<cffile action="${v}" file="/tmp/x.dat">
\t</cffunction>
</cfcomponent>`;
      const candidates = parseCfml("/x/F.cfc", "F.cfc", source);
      const notes = candidates[0]!.hints.notes ?? [];
      expect(notes, `cffile action="${v}" should emit filesystem note`).toContain("Writes to file system (cffile)");
    }
  });

  it("surfaces filesystem note for script-style file functions (fileWrite, fileDelete, etc.)", () => {
    const probes = [
      { body: "fileWrite('/tmp/x.txt', arguments.content)", label: "fileWrite" },
      { body: "fileAppend('/tmp/x.log', arguments.line)", label: "fileAppend" },
      { body: "fileDelete('/tmp/x.txt')", label: "fileDelete" },
      { body: "fileMove('/tmp/a.txt', '/tmp/b.txt')", label: "fileMove" },
      { body: "fileCopy('/tmp/a.txt', '/tmp/b.txt')", label: "fileCopy" },
      { body: "fileUpload('/uploads', form.file)", label: "fileUpload" },
      { body: "fileUploadAll('/uploads')", label: "fileUploadAll" },
    ];
    for (const { body, label } of probes) {
      const source = `<cfcomponent>
\t<cffunction name="op">
\t\t<cfscript>
\t\t\t${body};
\t\t</cfscript>
\t</cffunction>
</cfcomponent>`;
      const candidates = parseCfml("/x/F.cfc", "F.cfc", source);
      const notes = candidates[0]!.hints.notes ?? [];
      expect(notes, `${label} should emit filesystem note`).toContain("Writes to file system (cffile)");
    }
  });

  it("does NOT surface filesystem note for read-only cffile / fileRead", () => {
    // Reads have no blast radius; the note is reserved for mutations.
    const source = `<cfcomponent>
\t<cffunction name="loadReport">
\t\t<cffile action="read" file="/tmp/report.csv" variable="contents">
\t\t<cfset var raw = fileRead('/tmp/other.csv')>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/L.cfc", "L.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("file system"))).toBe(false);
  });
});

describe("parseCfml, cfexecute process-execution side-effect hints", () => {
  // Closes the process-execution matrix opened by Java Runtime.exec /
  // Ruby system / Open3 (1a944a1), Django subprocess / os.system (1c60c72).
  // Audit signal: spawned processes inherit server privileges -- the most
  // common ColdFusion idiom is shelling out to wkhtmltopdf / ImageMagick /
  // legacy CLI binaries.
  it("surfaces process-execution note for <cfexecute> tag form", () => {
    const source = `<cfcomponent>
\t<cffunction name="renderPdf">
\t\t<cfexecute name="/usr/local/bin/wkhtmltopdf" arguments="--quiet \#arguments.url\# \#arguments.outFile\#" timeout="60">
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/P.cfc", "P.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes).toContain("Executes external process (cfexecute)");
  });

  it("surfaces process-execution note for cfexecute(...) function form", () => {
    const source = `<cfcomponent>
\t<cffunction name="convertImage">
\t\t<cfscript>
\t\t\tcfexecute(name="/usr/bin/convert", arguments=["#arguments.src#", "#arguments.dest#"], timeout=30);
\t\t</cfscript>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/I.cfc", "I.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes).toContain("Executes external process (cfexecute)");
  });

  it("surfaces process-execution note for each cfexecute form in isolation", () => {
    // The 2 alternatives in the OR-chain (tag form `<cfexecute\b/` and function
    // form `\bcfexecute\s*\(/`) each have a dedicated single-form fixture so
    // that a refactor narrowing the alternation (e.g. dropping the function
    // form during a tag-only audit) trips exactly one assertion with a label
    // naming the broken alternative. Mirrors the per-alt loop idiom used for
    // every other side-effect matrix (java/unknown/ruby/django process-execution
    // and the cfml cftransaction / cffile / cfcache pin sweeps).
    const probes = [
      {
        label: "<cfexecute name=...> tag form",
        body: `<cfexecute name="/usr/bin/ffmpeg" arguments="-i in.mov out.mp4">`,
      },
      {
        label: 'cfexecute(name="...") function form',
        body: `<cfscript>cfexecute(name="/usr/bin/git", arguments=["status"]);</cfscript>`,
      },
    ];
    for (const { label, body } of probes) {
      const source = `<cfcomponent>
\t<cffunction name="op">
\t\t${body}
\t</cffunction>
</cfcomponent>`;
      const candidates = parseCfml("/x/F.cfc", "F.cfc", source);
      const notes = candidates[0]!.hints.notes ?? [];
      expect(notes, `${label} should emit process-execution note`).toContain(
        "Executes external process (cfexecute)",
      );
    }
  });

  it("does NOT surface process-execution note for incidental tokens that share the prefix", () => {
    // Word-boundary guards in both regexes (`<cfexecute\b` and `\bcfexecute\s*\(`)
    // filter out attribute / variable / custom-tag look-alikes. Locks in the
    // discrimination boundaries so a refactor dropping `\b` from either form
    // (or relaxing the `\s*\(` requirement on the function form) is caught
    // before it can false-positive on plausible CFML identifiers.
    const source = `<cfcomponent>
\t<cffunction name="show">
\t\t<cfset var cfexecuteLog = "no spawn here">
\t\t<cfset var msg = "see cfexecute docs for details">
\t\t<cfreturn cfexecuteLog>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/S.cfc", "S.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("Executes external process"))).toBe(false);
  });

  it("emits the process-execution note exactly once even when both cfexecute forms are present", () => {
    // Regression pin: two successive commits both added cfexecute detection
    // to extractFunctionHints (eb7c0ac + 54ba02a). The duplicate was discovered
    // via creative-improvement audit 2026-05-24 and removed by deleting the
    // shorter block. Without this test a future revert or re-merge of either
    // commit would silently re-introduce the duplicate note, causing the LLM
    // to see the same compliance signal twice and potentially double-count it.
    const source = `<cfcomponent>
\t<cffunction name="convertAndSave">
\t\t<cfexecute name="/usr/bin/convert" arguments="-resize 800x #src# #dst#" timeout="30">
\t\t<cfscript>
\t\t\tcfexecute(name="/usr/bin/optipng", arguments=["-o2", "#dst#"], timeout=10);
\t\t</cfscript>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/C.cfc", "C.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    const processNotes = notes.filter((n) => n.includes("Executes external process"));
    expect(processNotes).toHaveLength(1);
  });
});

describe("parseCfml, stdlib callee noise filter", () => {
  it("filters date / JSON / URL / regex / metadata noise from callees", () => {
    const source = `<cfcomponent>
  <cffunction name="renderReport">
    <cfset var asOf = dateformat(now(), "yyyy-mm-dd")>
    <cfset var raw = deserializeJSON(arguments.payload)>
    <cfset var encoded = urlencodedformat(arguments.email)>
    <cfset var clean = rereplace(arguments.name, "[^a-zA-Z0-9]", "", "all")>
    <cfset var stamp = gettickcount()>
    <cfset var result = buildReportData(raw, asOf)>
    <cfreturn formatForExport(result)>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Reports.cfc", "Reports.cfc", source);
    const callees = candidates[0]!.hints.callees ?? [];
    // Business signal stays.
    expect(callees).toContain("buildReportData");
    expect(callees).toContain("formatForExport");
    // Stdlib noise gets dropped (note: CFML keyword set is case-insensitive).
    expect(callees.map((c) => c.toLowerCase())).not.toContain("dateformat");
    expect(callees.map((c) => c.toLowerCase())).not.toContain("deserializejson");
    expect(callees.map((c) => c.toLowerCase())).not.toContain("urlencodedformat");
    expect(callees.map((c) => c.toLowerCase())).not.toContain("rereplace");
    expect(callees.map((c) => c.toLowerCase())).not.toContain("gettickcount");
  });

  it("CFML_KEYWORDS covers every documented stdlib alternative (defends set-deletion drift)", () => {
    // High-frequency stdlib built-ins that should always be filtered out of
    // callees. Reverse-validation: removing any one of these from CFML_KEYWORDS
    // trips the named-failure assertion `<name> should be filtered from callees`.
    const stdlibFunctions = [
      // Date: extremely common in CFML business code.
      "dateformat", "dateadd", "datediff", "datepart", "datecompare",
      "parsedatetime", "lsparsedate", "lsdateformat", "lstimeformat",
      "timeformat", "numberformat",
      // Regex.
      "rereplace", "rereplacenocase",
      // JSON.
      "serializejson", "deserializejson",
      // URL / HTML / XML escaping.
      "urlencodedformat", "urldecode", "htmleditformat", "xmlformat",
      // Param / metadata.
      "paramexists", "getmetadata", "gettickcount", "valueof",
      // CFScript expression helpers.
      "iif", "evaluate",
      // Logging.
      "writelog",
    ];
    for (const fn of stdlibFunctions) {
      const source = `<cfcomponent>
  <cffunction name="t_${fn}">
    <cfset var x = ${fn}(arguments.input)>
    <cfset var y = doBusinessThing(arguments.input)>
  </cffunction>
</cfcomponent>`;
      const candidates = parseCfml(`/x/T_${fn}.cfc`, `T_${fn}.cfc`, source);
      const callees = (candidates[0]!.hints.callees ?? []).map((c) => c.toLowerCase());
      expect(callees, `${fn} should be filtered from callees`).not.toContain(fn);
      // Sanity: business call still surfaces.
      expect(callees, `${fn} fixture should still surface doBusinessThing`).toContain("dobusinessthing");
    }
  });
});

describe("parseCfml, cfthread background-job side-effect hints", () => {
  // cfthread action="run" is the canonical CFML fire-and-forget pattern:
  // the parent request returns immediately while the spawned thread executes
  // concurrently. Closes the background-job matrix: Java (@Async /

  it("surfaces background-job note for tag-form cfthread action=\"run\"", () => {
    const source = `<cfcomponent>
\t<cffunction name="submitOrder" output="false">
\t\t<cfargument name="orderId" type="numeric">
\t\t<cfthread action="run" name="fulfillment_#arguments.orderId#">
\t\t\t<cfset processPaymentAndShip(attributes.orderId)>
\t\t</cfthread>
\t\t<cfreturn true>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Order.cfc", "Order.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes).toContain("Enqueues background job (cfthread)");
  });

  it("surfaces background-job note for function-form cfthread(action=\"run\")", () => {
    const source = `<cfcomponent>
\t<cffunction name="generateReport" output="false">
\t\t<cfargument name="reportId" type="string">
\t\t<cfscript>
\t\t\tcfthread(action="run", name="report_#arguments.reportId#") {
\t\t\t\tbuildAndEmailReport(attributes.reportId);
\t\t\t}
\t\t</cfscript>
\t\t<cfreturn "accepted">
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Report.cfc", "Report.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes).toContain("Enqueues background job (cfthread)");
  });

  it("does NOT surface background-job note for cfthread action=\"join\" (waits, does not spawn)", () => {
    const source = `<cfcomponent>
\t<cffunction name="waitForAll" output="false">
\t\t<cfthread action="join" name="t1,t2" timeout="5000">
\t\t<cfreturn cfthread.t1.status>
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/W.cfc", "W.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("background job"))).toBe(false);
  });

  it("does NOT surface background-job note when no cfthread is present", () => {
    const source = `<cfcomponent>
\t<cffunction name="ping" output="false">
\t\t<cfreturn "pong">
\t</cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/P.cfc", "P.cfc", source);
    const notes = candidates[0]!.hints.notes ?? [];
    expect(notes.some((n) => n.includes("background job"))).toBe(false);
  });

  // Pins the `["']` quote-class character on both regex alternatives
  // (cfml.ts:620-621). All 4 existing tests above use double-quoted
  // action="run"; a regex refactor that dropped `'` from the character
  // class would silently fail for Lucee/Adobe codebases using single-quoted
  // attribute values. Mirrors the per-alt-isolation idiom from the
  // 5-parser side-effect-Notes sweep (java/unknown/ruby/django/cfml v7+).
  it("surfaces background-job note when action uses single quotes", () => {
    const forms = [
      {
        label: "tag form",
        source: `<cfcomponent>
\t<cffunction name="x" output="false">
\t\t<cfthread action='run' name="t1">
\t\t\t<cfset noop()>
\t\t</cfthread>
\t\t<cfreturn true>
\t</cffunction>
</cfcomponent>`,
      },
      {
        label: "function form",
        source: `<cfcomponent>
\t<cffunction name="x" output="false">
\t\t<cfscript>
\t\t\tcfthread(action='run', name="t1") {
\t\t\t\tnoop();
\t\t\t}
\t\t</cfscript>
\t\t<cfreturn true>
\t</cffunction>
</cfcomponent>`,
      },
    ];
    for (const { label, source } of forms) {
      const candidates = parseCfml("/x/T.cfc", "T.cfc", source);
      const notes = candidates[0]!.hints.notes ?? [];
      expect(
        notes,
        `${label} with single-quoted action='run' should emit background-job note`,
      ).toContain("Enqueues background job (cfthread)");
    }
  });
});

describe("parseCfml, ADR-008 edge cases", () => {
  // ADR-008 documents the CFML parser as regex/scan (not a real AST) with two
  // accepted risk areas: "deeply nested string interpolation" and "conditional
  // <cffunction> inside <cfif>". Both currently work; the tests below pin the
  // behaviour so a future regex tweak cannot silently regress them without
  // someone noticing in CI.

  it("detects every cffunction wrapped by <cfif>/<cfelse>, with its own side-effect note", () => {
    // Two cffunctions, one in each branch of a <cfif>...<cfelse>. The parser
    // is a simple "find <cffunction>, find matching </cffunction>" scan that
    // never inspects the enclosing tag stack -- so cfif wrapping must not
    // hide either function. Each function carries a distinct side-effect
    // (cfmail vs cfquery) so we can prove the per-function hint extractor
    // does NOT bleed notes across the cfif/cfelse boundary.
    const source = `<cfcomponent>
  <cfif application.mailEnabled>
    <cffunction name="sendDigest">
      <cfmail to="user@example.com" from="noreply@example.com" subject="Digest">Hi</cfmail>
    </cffunction>
  <cfelse>
    <cffunction name="logSkip">
      <cfquery name="rs">
        insert into digest_skipped (id) values (1)
      </cfquery>
    </cffunction>
  </cfif>
</cfcomponent>`;
    const candidates = parseCfml("/x/Conditional.cfc", "Conditional.cfc", source);
    expect(candidates).toHaveLength(2);

    const send = candidates.find((c) => c.name === "sendDigest");
    const skip = candidates.find((c) => c.name === "logSkip");
    expect(send, "sendDigest must be detected inside <cfif>").toBeDefined();
    expect(skip, "logSkip must be detected inside <cfelse>").toBeDefined();

    // Side effects partition cleanly: cfmail-only on the cfif branch,
    // cfquery-only on the cfelse branch. A regression where notes bleed
    // across functions would put "Sends email (cfmail)" on both.
    const sendNotes = send!.hints.notes ?? [];
    const skipNotes = skip!.hints.notes ?? [];
    expect(sendNotes).toContain("Sends email (cfmail)");
    expect(skipNotes.some((n) => n.startsWith("Sends email"))).toBe(false);

    // The cfquery on the cfelse branch surfaces its table in databaseTables,
    // not in notes (per the existing CFML hint extractor).
    expect(skip!.hints.databaseTables ?? []).toContain("digest_skipped");
    expect(send!.hints.databaseTables ?? []).not.toContain("digest_skipped");
  });

  it("handles deeply nested #...# interpolation inside cfmail and cfquery without false positives or dropped notes", () => {
    // Pathological interpolation: a `#...#` ColdFusion-expression containing
    // a quoted bracket subscript whose key is itself a `#...#` expansion
    // (e.g. `#application.cfg["#variables.tenant#"].email#`). This is the
    // exact shape ADR-008 calls out as edge-case risky for a regex scanner;
    // the tag-attribute parser must not get confused into ending the cfmail
    // tag early, and the cfquery body table extractor must not split on
    // one of the embedded `#` markers.
    const source = `<cfcomponent>
  <cffunction name="sendLocalized">
    <cfmail to="#application.cfg["#variables.tenant#"].email#" from="#variables.from#" subject="Welcome">
      Hello #arguments.user#, your code is #application.cfg["#variables.tenant#"].code#.
    </cfmail>
    <cfquery name="audit">
      insert into audit_log (msg) values ('#application.cfg["#variables.tenant#"].slug#')
    </cfquery>
  </cffunction>
</cfcomponent>`;
    const candidates = parseCfml("/x/Nested.cfc", "Nested.cfc", source);
    expect(candidates).toHaveLength(1);

    const c = candidates[0]!;
    expect(c.name).toBe("sendLocalized");

    // Both side effects must be detected exactly once; the nested `#` must
    // not produce phantom duplicates and must not mask either real signal.
    const notes = c.hints.notes ?? [];
    const emailNotes = notes.filter((n) => n === "Sends email (cfmail)");
    expect(emailNotes).toHaveLength(1);

    // The cfquery's INSERT INTO target must survive the embedded `#`
    // interpolation in the VALUES clause; `audit_log` is the only table.
    const tables = c.hints.databaseTables ?? [];
    expect(tables).toContain("audit_log");
    // Defends against a future regex that latched onto `variables` or
    // `application` (CFML scope tokens nested inside the interpolation).
    expect(tables).not.toContain("variables");
    expect(tables).not.toContain("application");
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
