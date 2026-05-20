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

    const lineStart = lineFromOffset(cleaned, openStart);
    const lineEnd = lineFromOffset(cleaned, closeEnd);

    out.push({
      language: "cfml",
      filePath,
      relativePath,
      name: fnName,
      kind: "cf-tag-function",
      lineStart,
      lineEnd,
      source: block,
      hints: extractCfmlHints(block, "tag"),
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

    const lineStart = lineFromOffset(cleaned, start);
    const lineEnd = lineFromOffset(cleaned, closeBrace + 1);
    const block = cleaned.slice(start, closeBrace + 1);

    out.push({
      language: "cfml",
      filePath,
      relativePath,
      name: fnName,
      kind: "cf-script-function",
      lineStart,
      lineEnd,
      source: block,
      hints: extractCfmlHints(block, "script"),
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

  // SQL table refs in <cfquery> blocks
  const queryBlocks = block.match(/<cfquery[\s\S]*?<\/cfquery>/gi) ?? [];
  const tables = new Set<string>();
  for (const q of queryBlocks) {
    const matches = q.matchAll(/\b(?:from|update|into|join)\s+([a-zA-Z_][\w]*)/gi);
    for (const t of matches) {
      if (t[1]) tables.add(t[1]);
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
  if (callees.size) hints.callees = [...callees].slice(0, 30);

  // Notes: detect plugin event hooks
  const events = block.match(/announceEvent\s*\(\s*["']([^"']+)["']/gi) ?? [];
  if (events.length) {
    hints.notes = [
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
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "do",
  "function",
  "return",
  "var",
  "local",
  "and",
  "or",
  "not",
  "true",
  "false",
  "len",
  "isdate",
  "isnull",
  "isvalid",
  "structkeyexists",
  "arraylen",
  "arraynew",
  "structnew",
  "querynew",
  "createobject",
  "createodbcdatetime",
  "createdate",
  "now",
  "trim",
  "lcase",
  "ucase",
  "left",
  "right",
  "mid",
  "find",
  "listfindnocase",
  "listfind",
  "listappend",
  "listgetat",
  "listlen",
  "fileexists",
  "directoryexists",
]);
