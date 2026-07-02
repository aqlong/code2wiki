import path from "node:path";
import type { Candidate, CandidateHints } from "../types.js";

/**
 * CFML parser; pragmatic regex/scan approach. Not a full AST parser:
 * a real implementation would shell out to Lucee's parser via JSON-RPC.
 * For the MVP we extract enough structure to feed an LLM:
 *
 *   - <cffunction name="..."> ... </cffunction>          (tag style)
 *   - function foo(...) { ... }                          (script style inside .cfc)
 *   - <cfquery>, <cfargument>, function calls, table refs
 *
 * .cfm files are treated as a single page-level candidate.
 */
export function parseCfml(
  filePath: string,
  relativePath: string,
  source: string,
): Candidate[] {
  const ext = path.extname(filePath).toLowerCase();
  const cleaned = stripCfmlComments(source);

  if (ext === ".cfc") {
    const candidates = [
      ...parseTagFunctions(filePath, relativePath, cleaned),
      ...parseScriptFunctions(filePath, relativePath, cleaned),
    ];
    if (path.basename(filePath).toLowerCase() === "application.cfc") {
      annotateLifecycleHooks(candidates);
    }
    if (isOrmEntity(source)) {
      annotateOrmEntity(candidates);
    }
    return candidates;
  }
  if (ext === ".cfm") {
    return parseCfmPage(filePath, relativePath, source);
  }
  return [];
}

const APPLICATION_CFC_LIFECYCLE: Record<string, string> = {
  onapplicationstart:
    "ColdFusion lifecycle hook: fires once when the application starts or is reloaded; initializes application-scope shared resources",
  onapplicationend:
    "ColdFusion lifecycle hook: fires when the application times out or is stopped; cleans up shared resources",
  onsessionstart:
    "ColdFusion lifecycle hook: fires when a new user session is created",
  onsessionend:
    "ColdFusion lifecycle hook: fires when a user session times out or is explicitly ended",
  onrequeststart:
    "ColdFusion lifecycle hook: fires before EVERY request to the application; used for authentication checks, logging, or shared request setup",
  onrequestend:
    "ColdFusion lifecycle hook: fires after EVERY request completes",
  onrequest:
    "ColdFusion lifecycle hook: intercepts every request; must explicitly invoke the requested template or the request will not be handled",
  onerror:
    "ColdFusion lifecycle hook: fires when an uncaught exception occurs anywhere in the application",
  onmissingtemplate:
    "ColdFusion lifecycle hook: fires when a requested .cfm template cannot be found (404 equivalent)",
  oncfcrequest:
    "ColdFusion lifecycle hook: fires when this CFC is invoked directly via URL or web service",
  onabort:
    "ColdFusion lifecycle hook: fires when cfabort or cfsilent is called within a request",
};

function annotateLifecycleHooks(candidates: Candidate[]): void {
  for (const c of candidates) {
    const note = APPLICATION_CFC_LIFECYCLE[c.name.toLowerCase()];
    if (note) {
      c.hints.notes = [note, ...(c.hints.notes ?? [])];
    }
  }
}

function isOrmEntity(source: string): boolean {
  // Tag-style: <cfcomponent ... persistent="true" ...>
  // Script-style: component persistent="true" { ... }
  // Both forms use persistent="true" or persistent='true'.
  return (
    /<cfcomponent\b[^>]*\bpersistent\s*=\s*["']true["']/i.test(source) ||
    /\bcomponent\b[^{]*\bpersistent\s*=\s*["']true["']/i.test(source)
  );
}

function annotateOrmEntity(candidates: Candidate[]): void {
  const note =
    "ColdFusion ORM persistent entity (Hibernate-mapped): table mapping is automatic unless overridden with the table attribute; read/write via entityLoad / entitySave";
  for (const c of candidates) {
    c.hints.notes = [note, ...(c.hints.notes ?? [])];
  }
}

// --- comment stripping ----------------------------------------------------

function stripCfmlComments(source: string): string {
  // CFML: <!--- ... ---> (3 dashes). HTML-style <!-- --> are NOT CFML
  // comments; preserve them.
  //
  // Also strip cfscript block comments /* ... */ INCLUDING JSDoc-style
  // /** ... */. Why this matters (real-world wheels signal, 2026-05-09):
  // a fresh Wheels app's `app/controllers/Controller.cfc` carries a
  // JSDoc-style block at the top that contains an EXAMPLE controller:
  //
  //   /**
  //    * Example controller extending this one:
  //    * component extends="Controller" {
  //    *   function config() {
  //    *     super.config();
  //    *   }
  //    * }
  //    */
  //
  // Without stripping that block, parseScriptFunctions matched the
  // EXAMPLE `function config()` AND the real one; producing two
  // candidates from a one-function file. The duplicate then drove
  // duplicated LLM calls + duplicated audit entries.
  //
  // Both replacements preserve line counts so candidate `lineStart`
  // / `lineEnd` numbers stay accurate against the original source.
  function blankPreservingNewlines(match: string): string {
    return match
      .split("\n")
      .map(() => "")
      .join("\n");
  }
  let s = source.replace(/<!---[\s\S]*?--->/g, blankPreservingNewlines);
  s = s.replace(/\/\*[\s\S]*?\*\//g, blankPreservingNewlines);
  return s;
}

// --- tag-style functions --------------------------------------------------

function parseTagFunctions(
  filePath: string,
  relativePath: string,
  cleaned: string,
): Candidate[] {
  const out: Candidate[] = [];
  const fnOpen = /<cffunction\b([^>]*)>/gi;
  const fnClose = /<\/cffunction\s*>/gi;

  let match: RegExpExecArray | null;
  while ((match = fnOpen.exec(cleaned)) !== null) {
    const openStart = match.index;
    fnClose.lastIndex = fnOpen.lastIndex;
    const closeMatch = fnClose.exec(cleaned);
    if (!closeMatch) break;
    const closeEnd = closeMatch.index + closeMatch[0].length;

    const block = cleaned.slice(openStart, closeEnd);
    const attrs = parseTagAttributes(match[1] ?? "");
    const fnName = attrs["name"] ?? "anonymous";

    // access="private" methods are internal-only; callers outside the
    // component cannot invoke them, so they are not user-facing actions.
    const access = (attrs["access"] ?? "").toLowerCase();
    if (access === "private") {
      fnOpen.lastIndex = closeEnd;
      continue;
    }

    const lineStart = lineFromOffset(cleaned, openStart);
    const lineEnd = lineFromOffset(cleaned, closeEnd);
    const tagHints = extractCfmlHints(block, "tag");
    // access="remote" exposes the function over HTTP (CFML web-service
    // remoting). Surface it so the LLM treats this as a user-facing endpoint.
    if (access === "remote") {
      tagHints.notes = ["access: remote (HTTP-callable via CFC remoting)", ...(tagHints.notes ?? [])];
    }
    // roles="admin,manager" restricts who can call the function (ColdFusion
    // built-in access control). Surface it so the LLM can describe auth requirements.
    const tagRoles = (attrs["roles"] ?? "").trim();
    if (tagRoles) {
      tagHints.notes = [...(tagHints.notes ?? []), `roles: ${tagRoles}`];
    }

    out.push({
      language: "cfml",
      filePath,
      relativePath,
      name: fnName,
      kind: "cf-tag-function",
      lineStart,
      lineEnd,
      source: block,
      hints: tagHints,
    });

    fnOpen.lastIndex = closeEnd;
  }

  return out;
}

// --- script-style functions inside .cfc ----------------------------------

function parseScriptFunctions(
  filePath: string,
  relativePath: string,
  cleaned: string,
): Candidate[] {
  // We only run script extraction if the file has a `component { ... }` block
  // (modern CFML). Files dominated by tag syntax are handled above.
  if (!/\bcomponent\b\s*[a-zA-Z\s\{]/i.test(cleaned)) return [];

  const out: Candidate[] = [];
  // Scan for `function name(args) { ... }` not inside <cffunction>.
  const fnRegex =
    /(?:^|\s|;|\{|\}|\*\/)(?:public|private|package|remote|any|void|string|numeric|boolean|array|struct|query)?\s*(?:public|private|package|remote)?\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = fnRegex.exec(cleaned)) !== null) {
    const fnName = match[1];
    if (!fnName) continue;

    const openParen = cleaned.indexOf("(", match.index);
    const closeParen = matchingParen(cleaned, openParen);
    if (closeParen < 0) continue;
    const openBrace = cleaned.indexOf("{", closeParen);
    if (openBrace < 0) continue;
    const closeBrace = matchingBrace(cleaned, openBrace);
    if (closeBrace < 0) continue;

    // Find function-keyword start for accurate line numbers.
    const fnKeywordIdx = cleaned.lastIndexOf("function", openParen);
    const start = fnKeywordIdx >= 0 ? fnKeywordIdx : match.index;

    // Skip private functions: look back from the `function` keyword to the
    // start of the statement (newline / semicolon / brace) and check for
    // `private`. The regex match starts AFTER the access modifier token when
    // a return type follows (e.g. `private string function`), so inspecting
    // match[0] is not reliable; a lookback from fnKeywordIdx is.
    const stmtScanFrom = fnKeywordIdx >= 0 ? fnKeywordIdx : match.index;
    const lineBegin = cleaned.lastIndexOf("\n", stmtScanFrom) + 1;
    const beforeKeyword = cleaned.slice(lineBegin, stmtScanFrom);
    if (/\bprivate\b/i.test(beforeKeyword)) {
      fnRegex.lastIndex = closeBrace + 1;
      continue;
    }

    const lineStart = lineFromOffset(cleaned, start);
    const lineEnd = lineFromOffset(cleaned, closeBrace + 1);
    const block = cleaned.slice(start, closeBrace + 1);
    const scriptHints = extractCfmlHints(block, "script");

    // Extract inline parameters from the function signature. Tag-style CFML
    // uses <cfargument> tags (handled by extractCfmlHints); script-style uses
    // `required string name` inline declarations that the <cfargument> regex
    // cannot see. Only apply when extractCfmlHints found no <cfargument> tags
    // (guards against legacy mixed-mode files that embed tags inside script).
    if (!scriptHints.parameters?.length) {
      const paramText = cleaned.slice(openParen + 1, closeParen);
      const inlineParams = extractScriptStyleParams(paramText);
      if (inlineParams.length > 0) scriptHints.parameters = inlineParams;
    }

    if (/\bremote\b/i.test(beforeKeyword)) {
      scriptHints.notes = ["access: remote (HTTP-callable via CFC remoting)", ...(scriptHints.notes ?? [])];
    }
    // roles="admin,manager" may appear between the closing param-paren and the
    // opening brace: `remote function foo() roles="admin" {`
    const afterParen = cleaned.slice(closeParen + 1, openBrace);
    const scriptRolesMatch = afterParen.match(/\broles\s*=\s*["']([^"']*)["']/i);
    if (scriptRolesMatch?.[1]) {
      scriptHints.notes = [...(scriptHints.notes ?? []), `roles: ${scriptRolesMatch[1].trim()}`];
    }

    out.push({
      language: "cfml",
      filePath,
      relativePath,
      name: fnName,
      kind: "cf-script-function",
      lineStart,
      lineEnd,
      source: block,
      hints: scriptHints,
    });

    fnRegex.lastIndex = closeBrace + 1;
  }

  return out;
}

// --- .cfm page-level candidate -------------------------------------------

function parseCfmPage(
  filePath: string,
  relativePath: string,
  originalSource: string,
): Candidate[] {
  // A .cfm file IS a request handler. Treat the whole page as one candidate
  // unless the page is genuinely empty / boilerplate.
  //
  // Real-world signal that motivates this filter (2026-05-09 wheels run):
  // a fresh Wheels app ships with placeholder lifecycle hooks like
  //   <cfscript>
  //   // Place code here...
  //   </cfscript>
  // The earlier `meaningful < 32 chars` heuristic missed these because
  // it didn't strip cfscript // line comments; a comment-only file
  // looks "long enough" by char count and a use-case page gets generated
  // for what is essentially nothing. Wasted LLM tokens and misleading
  // docs (LLM dutifully invents a "use case" for an empty hook).
  //
  // Now we strip cfscript-style comments (// ... and /* ... */) AND the
  // <cfscript>/<cftry> boilerplate, AND <cfsilent>/<cfsetting>, then
  // count remaining executable lines. A page with < 3 executable lines
  // is treated as a stub.
  const lines = originalSource.split("\n");
  const executableLineCount = countExecutableLines(originalSource);
  if (executableLineCount < 3) return [];

  return [
    {
      language: "cfml",
      filePath,
      relativePath,
      name: path.basename(filePath, ".cfm"),
      kind: "cf-tag-function",
      lineStart: 1,
      lineEnd: lines.length,
      source: originalSource,
      hints: extractCfmlHints(originalSource, "page"),
    },
  ];
}

/**
 * Count the number of "executable" lines in a CFML source.
 *
 * Strips, in order:
 *   1. CFML tag comments `<!--- ... --->` (already done by stripCfmlComments,
 *      but parseCfmPage receives the ORIGINAL source so it has to repeat).
 *   2. cfscript line comments `// ...`
 *   3. cfscript block comments `/* ... *\/`
 *   4. Boilerplate-only tags: `<cfscript>`, `</cfscript>`, `<cfsilent>`,
 *      `</cfsilent>`, `<cfsetting ...>`, `<cfinclude ...>`
 * Then counts lines that contain at least one non-whitespace character.
 *
 * Exported for unit-testing the heuristic independently of the parser.
 */
export function countExecutableLines(source: string): number {
  let s = source;
  // CFML tag comments
  s = s.replace(/<!---[\s\S]*?--->/g, "");
  // cfscript block comments; non-greedy, multi-line
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  // cfscript single-line comments; to end of line
  s = s.replace(/\/\/[^\n]*/g, "");
  // Stand-alone tag wrappers / framework boilerplate (case-insensitive).
  // Note: only the OPENING/CLOSING tag chars get blanked; nested content
  // remains so a meaningful body inside <cfscript>...</cfscript> still
  // counts.
  s = s.replace(/<\/?cfscript\b[^>]*>/gi, "");
  s = s.replace(/<\/?cfsilent\b[^>]*>/gi, "");
  s = s.replace(/<cfsetting\b[^>]*>/gi, "");
  s = s.replace(/<cfinclude\b[^>]*>/gi, "");
  return s
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

// --- script-style parameter extraction -----------------------------------

// Built-in CFML simple types. First word of a param declaration matching
// one of these (case-insensitive) is treated as the type; the next word
// is the name. PascalCase first words are treated as component-type names.
const CFML_BUILTIN_TYPES = new Set([
  "any", "array", "binary", "boolean", "date", "guid", "numeric",
  "query", "string", "struct", "uuid", "void", "xml", "integer", "float",
]);

/**
 * Parse the raw text between the parentheses of a CFML script-style
 * function declaration into structured parameter hints.
 *
 * Handles: `required string name`, `numeric age = 0`, `name`, `Config cfg`.
 * Strips default values (depth-aware so `= {a: 1}` is handled correctly).
 */
function extractScriptStyleParams(
  paramText: string,
): Array<{ name: string; type?: string }> {
  if (!paramText.trim()) return [];

  // Split on commas at bracket depth 0 (defaults may contain {}, []).
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of paramText) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; }
    else current += ch;
  }
  parts.push(current);

  const result: Array<{ name: string; type?: string }> = [];
  for (const part of parts) {
    // Strip default value from `=` onwards at depth 0.
    let decl = "";
    let d2 = 0;
    for (const ch of part.trim()) {
      if (ch === "(" || ch === "[" || ch === "{") d2++;
      else if (ch === ")" || ch === "]" || ch === "}") d2--;
      if (ch === "=" && d2 === 0) break;
      decl += ch;
    }
    // Strip leading `required` keyword (case-insensitive).
    decl = decl.trim().replace(/^required\s+/i, "").trim();
    const words = decl.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    if (words.length === 1) {
      result.push({ name: words[0]! });
    } else {
      const maybeType = words[0]!;
      const maybeName = words[1]!;
      // Treat as a type when it's a known CFML builtin or PascalCase (component).
      const isType =
        CFML_BUILTIN_TYPES.has(maybeType.toLowerCase()) ||
        /^[A-Z]/.test(maybeType);
      result.push(isType ? { name: maybeName, type: maybeType } : { name: words[words.length - 1]! });
    }
  }
  return result;
}

// --- hint extraction -----------------------------------------------------

function extractCfmlHints(
  block: string,
  _mode: "tag" | "script" | "page",
): CandidateHints {
  const hints: CandidateHints = {};

  // <cfargument name="..." required="..." default="...">
  const argRegex = /<cfargument\b([^>]*)>/gi;
  const params: Array<{ name: string; type?: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = argRegex.exec(block)) !== null) {
    const attrs = parseTagAttributes(m[1] ?? "");
    if (attrs["name"]) {
      params.push({ name: attrs["name"], type: attrs["type"] });
    }
  }
  if (params.length) hints.parameters = params;

  // SQL table refs. Two sources, both common in production CFML:
  //   1. <cfquery name="x">SELECT ... FROM ...</cfquery> tag form
  //   2. queryExecute("SELECT ... FROM ...", ...) script form (Lucee + ACF 2018+)
  // The script form is the modern idiom in ColdBox/ContentBox/MasaCMS code; the
  // tag form remains common in legacy controllers. Missing the script form
  // silently dropped database tables for an entire class of CFML codebases.
  const sqlSources: string[] = [
    ...(block.match(/<cfquery[\s\S]*?<\/cfquery>/gi) ?? []),
  ];
  // queryExecute(...) extracts the SQL string from the first argument. The
  // string body may be double-quoted or single-quoted; multi-line literals
  // work as-is because JS `[^"]` and `[^']` match newlines. Out of scope for
  // this regex: string concatenation ("SELECT" & " ..."), variable references
  // (`var sql = "..."; queryExecute(sql)`), and queries assembled from
  // QueryBuilder fluent builders. Revisit when customer code surfaces them.
  const queryExecuteMatches = block.matchAll(
    /\bqueryExecute\s*\(\s*(?:"([^"]*)"|'([^']*)')/gi,
  );
  for (const m of queryExecuteMatches) {
    const sql = m[1] ?? m[2] ?? "";
    if (sql) sqlSources.push(sql);
  }
  const tables = new Set<string>();
  for (const q of sqlSources) {
    // Capture the full qualified identifier after FROM/UPDATE/INTO/JOIN, then
    // strip any wrapping brackets / backticks / double-quotes before keeping
    // the last dotted segment. Handles four real-world forms:
    //   - users                       (unqualified)
    //   - dbo.Users                   (schema-qualified, Oracle / generic)
    //   - [dbo].[Users]               (SQL Server bracketed)
    //   - `users` / "users"           (MySQL backticks / Postgres doublequotes)
    // The capture allows `[`, `]`, backtick, `"`, dot, and word chars. The
    // post-processing strips quote chars and validates the remaining token is
    // a clean identifier before adding to the table set.
    const matches = q.matchAll(/\b(?:from|update|into|join)\s+([\w.[\]"`]+)/gi);
    for (const t of matches) {
      if (!t[1]) continue;
      const parts = t[1].split(".");
      const last = parts[parts.length - 1] ?? "";
      const tableName = last.replace(/[[\]"`]/g, "");
      if (tableName && /^[a-zA-Z_]\w*$/.test(tableName)) {
        tables.add(tableName);
      }
    }
  }
  if (tables.size) hints.databaseTables = [...tables].slice(0, 20);

  // Function callees (rough: word followed by `(`)
  const callees = new Set<string>();
  const callRegex = /\b([a-zA-Z_][\w]*)\s*\(/g;
  while ((m = callRegex.exec(block)) !== null) {
    const name = m[1] ?? "";
    if (name.length < 3) continue;
    if (CFML_KEYWORDS.has(name.toLowerCase())) continue;
    callees.add(name);
  }
  // Legacy CFML invokes methods via <cfinvoke method="X" ...>. The method name
  // is in an attribute, not followed by `(`, so the bare callee regex above
  // misses it entirely. Common in older ContentBox / MasaCMS / framework code,
  // exactly the target market for code2wiki.
  const cfinvokeMatches = block.matchAll(
    /<cfinvoke\b[^>]*\bmethod\s*=\s*["']([^"']+)["']/gi,
  );
  for (const inv of cfinvokeMatches) {
    if (inv[1] && !CFML_KEYWORDS.has(inv[1].toLowerCase())) {
      callees.add(inv[1]);
    }
  }
  if (callees.size) hints.callees = [...callees].slice(0, 30);

  // Notes: detect plugin event hooks
  const events = block.match(/announceEvent\s*\(\s*["']([^"']+)["']/gi) ?? [];
  if (events.length) {
    hints.notes = [
      ...(hints.notes ?? []),
      `Fires plugin events: ${events
        .map((e) => e.match(/["']([^"']+)["']/)?.[1])
        .filter(Boolean)
        .join(", ")}`,
    ];
  }

  // Notes: ORM function calls (entityLoad, entitySave, ormFlush, etc.)
  const ormSeen = new Set<string>();
  const ormCallRegex =
    /\b(entity(?:Load|New|Save|Delete|LoadByPK|ToQuery|Count|NameArray)|orm(?:Flush|Reload|Evict|GetSession|ExecuteQuery))\s*\(/gi;
  let ormMatch: RegExpExecArray | null;
  while ((ormMatch = ormCallRegex.exec(block)) !== null) {
    if (ormMatch[1]) ormSeen.add(ormMatch[1].toLowerCase());
  }
  if (ormSeen.size) {
    hints.notes = [
      ...(hints.notes ?? []),
      `Calls ORM functions: ${[...ormSeen].join(", ")}`,
    ];
  }

  // Notes: custom tag invocations (<cf_tagname> and <cfmodule template="...">)
  const customTagsSeen: string[] = [];
  const cfCustomTagRegex = /<cf_([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let ctMatch: RegExpExecArray | null;
  while ((ctMatch = cfCustomTagRegex.exec(block)) !== null) {
    const tagName = `cf_${ctMatch[1]!.toLowerCase()}`;
    if (!customTagsSeen.includes(tagName)) customTagsSeen.push(tagName);
  }
  const cfModuleRegex = /<cfmodule\b([^>]*)>/gi;
  while ((ctMatch = cfModuleRegex.exec(block)) !== null) {
    const attrs = parseTagAttributes(ctMatch[1] ?? "");
    const ref = attrs["template"] ?? attrs["name"] ?? "";
    if (ref) {
      const label = `cfmodule:${ref}`;
      if (!customTagsSeen.includes(label)) customTagsSeen.push(label);
    }
  }
  if (customTagsSeen.length) {
    hints.notes = [
      ...(hints.notes ?? []),
      `Invokes custom tags: ${customTagsSeen.join(", ")}`,
    ];
  }

  // Notes: dynamic component instantiation via createObject("component", ...)
  const dynComponents: string[] = [];
  const createObjRegex =
    /createObject\s*\(\s*["']component["']\s*,\s*["']([^"']+)["']/gi;
  let coMatch: RegExpExecArray | null;
  while ((coMatch = createObjRegex.exec(block)) !== null) {
    const compPath = coMatch[1]!;
    if (!dynComponents.includes(compPath)) dynComponents.push(compPath);
  }
  if (dynComponents.length) {
    hints.notes = [
      ...(hints.notes ?? []),
      `Dynamically instantiates components: ${dynComponents.join(", ")}`,
    ];
  }

  // Notes: email sending (cfmail tag or function). Surfaced as an explicit side
  // effect because sending email is high-blast-radius: it may reach customers or
  // external stakeholders and cannot be undone after the fact.
  if (/<cfmail\b/i.test(block) || /\bcfmail\s*\(/i.test(block)) {
    hints.notes = [
      ...(hints.notes ?? []),
      "Sends email (cfmail)",
    ];
  }

  // Notes: outbound HTTP calls (cfhttp tag or function). Surfaced as a side effect
  // because external calls introduce latency, auth dependencies, and blast radius
  // beyond the current server.
  if (/<cfhttp\b/i.test(block) || /\bcfhttp\s*\(/i.test(block)) {
    hints.notes = [
      ...(hints.notes ?? []),
      "Makes outbound HTTP request (cfhttp)",
    ];
  }
  // Notes: SOAP web service invocations. Three CFML forms all make outbound
  // HTTP calls to a WSDL/SOAP endpoint and are audit-equivalent to cfhttp:
  //   1. <cfinvoke webservice="http://api/service?wsdl" method="...">
  //      Tag form, extremely common in pre-2010 ColdFusion enterprise code.
  //   2. CreateObject("webservice", "http://api/service?wsdl")
  //      Script / function form; used in CFScript blocks and modern .cfc files.
  //   3. <cfobject type="webservice" name="svc" webservice="http://...">
  //      Two-step proxy form from ColdFusion MX (6.x/7.x, 2002-2008). Creates
  //      a local proxy variable; the outbound SOAP call happens when cfobject
  //      resolves the WSDL. Less common after cfinvoke was preferred but still
  //      widespread in MasaCMS / ContentBox era legacy code.
  // The `webservice` attribute/argument is the discriminating signal -- a plain
  // <cfinvoke component="LocalCFC"> or <cfobject type="java"> does NOT trigger.
  if (
    /<cfinvoke\b[^>]*\bwebservice\s*=/i.test(block)
    || /\bCreateObject\s*\(\s*["']webservice["']/i.test(block)
    || /<cfobject\b[^>]*\btype\s*=\s*["']webservice["']/i.test(block)
  ) {
    hints.notes = [
      ...(hints.notes ?? []),
      "Makes outbound HTTP request (cfinvoke webservice)",
    ];
  }

  // Notes: background thread dispatch via cfthread. CFML's cfthread tag and
  // function both accept an `action` attribute/argument; only action="run"
  // actually spawns a new thread. The parent request returns immediately while
  // the thread body executes concurrently -- the canonical CFML fire-and-forget
  // pattern used for async email, report generation, and third-party API calls.
  // action="join" (wait), "sleep" (pause), and "terminate" (kill) do NOT start
  // background work and are intentionally NOT flagged.
  // Two forms:
  //   1. Tag form:       <cfthread action="run" name="t1"> ... </cfthread>
  //   2. Function form:  cfthread(action="run", name="t1") { ... }
  // Closes the background-job matrix: Java (@Async / CompletableFuture),
  // C# (Hangfire BackgroundJob.Enqueue), Ruby (perform_later / perform_async),
  // Django (Celery .delay / .apply_async) all emit the same note.
  if (
    /<cfthread\b[^>]*\baction\s*=\s*["']run["']/i.test(block)
    || /\bcfthread\s*\([^)]*\baction\s*=\s*["']run["']/i.test(block)
  ) {
    hints.notes = [
      ...(hints.notes ?? []),
      "Enqueues background job (cfthread)",
    ];
  }

  // Notes: cache mutation. cachePut / cacheRemove / cacheRemoveAll / cacheClear
  // are the CFML function-form cache API; <cfcache action="flush|put"> is the
  // tag form. Cache reads (cacheGet, cacheGetMetadata, cacheKeyExists,
  // cacheCount) are intentionally NOT flagged: no blast radius beyond a cache
  // miss. Closes the cache-mutation matrix opened by Java @CacheEvict, C#
  // IMemoryCache, Ruby Rails.cache, and Django cache.X.
  if (
    /\bcache(?:Put|Remove|RemoveAll|Clear)\s*\(/i.test(block)
    || /<cfcache\b[^>]*\baction\s*=\s*["'](?:flush|put)["']/i.test(block)
  ) {
    hints.notes = [
      ...(hints.notes ?? []),
      "Mutates application cache (cfcache)",
    ];
  }

  // Notes: filesystem mutations (cffile / fileWrite / fileDelete / fileUpload).
  // Writing, deleting, moving, or uploading files affects shared disk state and
  // is audit-relevant for compliance. Reads (cffile action="read", fileRead)
  // are intentionally NOT flagged since they have no blast radius.
  const cffileTagRe = /<cffile\b[^>]*\baction\s*=\s*["'](?:write|upload|uploadall|append|delete|move|rename|copy)["']/gi;
  const cffileFnRe = /\b(?:fileWrite|fileAppend|fileDelete|fileMove|fileCopy|fileUpload|fileUploadAll)\s*\(/gi;
  if (cffileTagRe.test(block) || cffileFnRe.test(block)) {
    hints.notes = [
      ...(hints.notes ?? []),
      "Writes to file system (cffile)",
    ];
  }

  // Notes: external process execution. Adobe CF and Lucee expose one primitive
  // for spawning OS processes: cfexecute. Audit-critical because the spawned
  // process inherits server privileges; common in ColdFusion shops for PDF
  // generation (wkhtmltopdf), image conversion (ImageMagick / GraphicsMagick),
  // and legacy CLI integration. Closes the process-execution matrix opened by
  // Java Runtime.exec / ProcessBuilder, C# Process.Start / Cli.Wrap, Ruby
  // system / Open3, and Django subprocess / os.system. Two forms:
  //   1. Tag form:        <cfexecute name="..." ...>
  //   2. Function form:   cfexecute(name="...", ...)
  if (/<cfexecute\b/i.test(block) || /\bcfexecute\s*\(/i.test(block)) {
    hints.notes = [
      ...(hints.notes ?? []),
      "Executes external process (cfexecute)",
    ];
  }

  // Notes: database transactions. Critical for auditors: all database operations
  // inside the block succeed or fail together (all-or-nothing). Recognises both
  // tag form (`<cftransaction>`) and the two script-style forms used in
  // ColdBox, ContentBox, and Wheels migrations: `transaction { ... }` block
  // syntax and `transaction action="commit";` statement syntax. The
  // `(?:\{|action\s*=)` suffix is what filters out look-alikes like
  // `local.transaction = ...` (assignment) and `log.transaction(...)` (call).
  const hasTransaction =
    /<cftransaction\b/i.test(block) ||
    /\btransaction\s*(?:\{|action\s*=)/i.test(block) ||
    /\bcftransaction\s*\(/i.test(block);
  if (hasTransaction) {
    hints.notes = [
      ...(hints.notes ?? []),
      "Executes database operations inside a transaction (cftransaction)",
    ];
  }

  // Notes: stored procedure calls (cfstoredproc). Stored procs may have
  // side effects invisible in the ColdFusion code (e.g. triggers, cross-table
  // writes, audit logging in the DB layer). Three forms in the wild:
  //   1. Tag form:        <cfstoredproc procedure="sp_X" ...>
  //   2. Script block:    storedproc procedure="sp_X" ... { ... }    (Lucee, ACF 2018+)
  //   3. Function call:   cfstoredproc(procedure="sp_X", ...)
  const storedProcs: string[] = [];
  const storedProcPatterns = [
    /<cfstoredproc\b[^>]*\bprocedure\s*=\s*["']([^"']+)["']/gi,
    /\bstoredproc\b[^{]*?\bprocedure\s*=\s*["']([^"']+)["']/gi,
    /\bcfstoredproc\s*\(\s*[^)]*?\bprocedure\s*=\s*["']([^"']+)["']/gi,
  ];
  for (const re of storedProcPatterns) {
    let spMatch: RegExpExecArray | null;
    while ((spMatch = re.exec(block)) !== null) {
      if (spMatch[1] && !storedProcs.includes(spMatch[1])) {
        storedProcs.push(spMatch[1]);
      }
    }
  }
  if (storedProcs.length > 0) {
    hints.notes = [
      ...(hints.notes ?? []),
      `Calls stored procedure(s): ${storedProcs.join(", ")}`,
    ];
  }

  return hints;
}

// --- shared utilities ----------------------------------------------------

function parseTagAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3];
    if (key && val !== undefined) out[key.toLowerCase()] = val;
  }
  return out;
}

function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function matchingParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchingBrace(s: string, openIdx: number): number {
  let depth = 0;
  let inString: false | '"' | "'" = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    const prev = s[i - 1];
    if (inString) {
      if (c === inString && prev !== "\\") inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c as '"' | "'";
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const CFML_KEYWORDS = new Set([
  // Control flow.
  "if", "else", "for", "while", "switch", "case", "do",
  "function", "return", "var", "local",
  "and", "or", "not", "true", "false",
  // Length / existence / validation (low business-collision).
  "len", "isdate", "isnull", "isvalid",
  // Struct / array / query constructors and accessors.
  "structkeyexists", "arraylen", "arraynew", "structnew", "querynew",
  // Component / object instantiation.
  "createobject", "createodbcdatetime", "createdate",
  // String case + slicing (CFML stdlib forms).
  "trim", "lcase", "ucase", "left", "right", "mid", "find",
  // List operations.
  "listfindnocase", "listfind", "listappend", "listgetat", "listlen",
  // File system.
  "fileexists", "directoryexists",
  // Date functions: extremely common in CFML business code, never business names.
  "now", "dateformat", "dateadd", "datediff", "datepart", "datecompare",
  "parsedatetime", "lsparsedate", "lsdateformat", "lstimeformat",
  "timeformat", "numberformat",
  // Regex + advanced string (rereplace/rereplacenocase are CFML-specific).
  "rereplace", "rereplacenocase",
  // JSON serialization (always stdlib).
  "serializejson", "deserializejson",
  // URL / HTML / XML escaping (always stdlib).
  "urlencodedformat", "urldecode", "htmleditformat", "xmlformat",
  // Param / metadata helpers (never business names).
  "paramexists", "getmetadata", "gettickcount", "valueof",
  // CFScript-equivalent expression helpers (rarely business names).
  "iif", "evaluate",
  // CFML's logging function form.
  "writelog",
]);
