import path from "node:path";
import type { Candidate, CandidateHints } from "../types.js";

/**
 * Rails monolith controller parser; pragmatic regex/scan approach.
 *
 * Targets files ending in `_controller.rb` (Rails naming convention) and
 * extracts every public instance method as a candidate. Class methods
 * (`def self.foo`) and everything after a `private` or `protected` keyword
 * are skipped.
 *
 * Block nesting (def/class/module/if/unless/while/until/for/case/begin/do)
 * is tracked with a depth counter so the matching `end` can be found
 * without a full AST. The approach handles 95% of real Rails code; edge
 * cases (heredocs, multi-line strings containing Ruby keywords) are
 * conservatively kept rather than silently dropped.
 *
 * ADR-036.
 */

// Rails REST action names and their conventional HTTP verb/path.
// The resource name is placeholder; the LLM infers it from context.
const REST_ROUTES: Record<string, { method: string; path: string }> = {
  index:   { method: "GET",    path: "/:resources" },
  show:    { method: "GET",    path: "/:resources/:id" },
  new:     { method: "GET",    path: "/:resources/new" },
  create:  { method: "POST",   path: "/:resources" },
  edit:    { method: "GET",    path: "/:resources/:id/edit" },
  update:  { method: "PATCH",  path: "/:resources/:id" },
  destroy: { method: "DELETE", path: "/:resources/:id" },
};

/**
 * Represents a Rails `before_action` (or `before_filter`) callback declared
 * at the top of a controller class. `only` and `except` are action-name lists
 * parsed from `only: [:a, :b]` / `except: %i[a b]` keyword args; when absent
 * the callback applies to every action in the class.
 */
interface BeforeAction {
  callback: string;
  only: Set<string> | null;
  except: Set<string> | null;
}

/** Parse a Ruby symbol-array literal like `[:show, :index]` or `%i[show index]`. */
function parseSymbolList(text: string): string[] {
  // %i[a b c] form
  const pct = text.match(/%[iI]\[([^\]]*)\]/);
  if (pct) return (pct[1] ?? "").trim().split(/\s+/).filter(Boolean);
  // [:a, :b, :c] form
  const bracket = text.match(/\[([^\]]*)\]/);
  if (!bracket) return [];
  return (bracket[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^:/, ""))
    .filter(Boolean);
}

/**
 * Parse a single `before_action` / `before_filter` line and return a
 * BeforeAction entry, or null when the line doesn't match the pattern.
 */
function parseBeforeAction(trimmed: string): BeforeAction | null {
  // Match `before_action :callback_name` with optional trailing options.
  const m = trimmed.match(
    /^(?:before_action|before_filter)\s+:(\w+[?!]?)(.*)/,
  );
  if (!m) return null;
  const callback = m[1]!;
  const rest = m[2] ?? "";

  // Capture the full bracket literal: `[:a, :b]` or `%i[a b]`.
  const onlyMatch = rest.match(/\bonly:\s*(%[iI]\[[^\]]*\]|\[[^\]]*\])/);
  const exceptMatch = rest.match(/\bexcept:\s*(%[iI]\[[^\]]*\]|\[[^\]]*\])/);

  const only = onlyMatch ? new Set(parseSymbolList(onlyMatch[1]!)) : null;
  const except = exceptMatch ? new Set(parseSymbolList(exceptMatch[1]!)) : null;

  return { callback, only, except };
}

/** Return true when the given before_action applies to the named action. */
function beforeActionApplies(ba: BeforeAction, actionName: string): boolean {
  if (ba.only !== null) return ba.only.has(actionName);
  if (ba.except !== null) return !ba.except.has(actionName);
  return true;
}

// ActiveRecord class-level methods used to query or persist model data.
// Presence of any of these on a PascalCase receiver is a reliable signal
// that the receiver is an AR model, not a Ruby stdlib class.
const AR_CLASS_METHODS = new Set([
  "all", "find", "find_by", "find_by!", "find_or_create_by", "find_or_initialize_by",
  "where", "first", "last", "count", "sum", "average", "minimum", "maximum",
  "ids", "pluck", "exists?", "any?", "many?",
  "create", "create!", "update_all", "destroy_all", "delete_all",
  "insert", "upsert", "insert_all", "upsert_all",
  "new", "build",
]);

// Common Ruby stdlib / Rails framework classes that show up in controllers
// but are NOT AR models; excluded to avoid false positives on e.g. `String.new`.
const RUBY_BUILTIN_CLASSES = new Set([
  "Array", "Hash", "String", "Integer", "Float", "Symbol", "Numeric",
  "Range", "Regexp", "Proc", "IO", "File", "Dir", "Time", "Thread",
  "Struct", "Set", "Pathname",
]);

// Ruby control-flow keywords and common built-ins excluded from callee extraction.
const RUBY_KEYWORDS = new Set([
  "if", "unless", "while", "until", "for", "do", "begin", "rescue",
  "ensure", "raise", "require", "require_relative", "include", "extend",
  "prepend", "def", "class", "module", "end", "puts", "print", "pp",
  "return", "yield", "super", "and", "or", "not", "when", "case",
  "then", "break", "next", "redo", "retry", "attr_reader", "attr_writer",
  "attr_accessor",
]);

// Ruby stdlib method names that are noise in the callees hint. Constructor,
// less-overridden conversion methods, specific Enumerable methods, format
// helpers, and Logger methods. Generic Enumerable names (each, map, select,
// find, first, last, any?, all?, count, size) are NOT included because they
// collide with business calls. Common-override conversions (to_s, to_i) are
// excluded for the same reason. Mirrors the Java / C# stdlib-filter philosophy.
const RUBY_STDLIB_METHODS = new Set([
  // Constructor
  "new",
  // Conversion (less commonly overridden than to_s / to_i)
  "to_a", "to_h", "to_sym", "to_str", "to_f", "to_r", "to_c", "to_proc",
  // Specific Enumerable (less common as business names)
  "each_with_index", "each_with_object", "inject", "flat_map",
  "group_by", "partition", "tally", "min_by", "max_by", "sort_by",
  "take_while", "drop_while", "chunk_while", "slice_when",
  // Format helpers (Kernel)
  "printf", "sprintf",
  // Logger (Rails.logger.X / logger.X with parens)
  "debug", "info", "warn", "error", "fatal",
]);

/**
 * Scan method source for `ModelName.ar_method(` patterns and return a
 * deduplicated list of model names. Only PascalCase identifiers paired with
 * a known AR class-method name are recorded; Ruby stdlib classes are excluded.
 */
function extractActiveRecordModels(source: string): string[] {
  const seen = new Set<string>();
  const re = /\b([A-Z][A-Za-z0-9_]*)\.([a-z_!?]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const model = m[1]!;
    const method = m[2]!;
    if (AR_CLASS_METHODS.has(method) && !RUBY_BUILTIN_CLASSES.has(model)) {
      seen.add(model);
    }
  }
  return [...seen];
}

// Keywords that open a block terminated by `end` (excluding `def`, which
// is handled explicitly so we can extract full method bodies).
const BLOCK_OPENER_RE =
  /^\s*(?:class|module|if|unless|while|until|for|case|begin)\b/;

// A `do` block at the end of a line (with optional block params).
const DO_OPENER_RE = /\bdo\s*(?:\|[^|]*\|)?\s*(?:#.*)?$/;

// A standalone `end` (the first token on the meaningful line).
// Also matches `end.something` (method chained on `end` keyword) which
// is valid Ruby, so we trim conservatively.
const END_RE = /^\s*end\b/;

export function parseRuby(
  filePath: string,
  relativePath: string,
  source: string,
): Candidate[] {
  // Lowercase basename so the gate matches the dispatcher's case-insensitive
  // extension match in parsers/index.ts (e.g., Users_Controller.RB routed by
  // the dispatcher used to drop here on a strict-case endsWith check).
  const basename = path.basename(filePath).toLowerCase();
  // Only parse files following the Rails controller naming convention.
  if (!basename.endsWith("_controller.rb")) return [];

  const lines = source.split("\n");

  // Determine class name: prefer what's in the source, fall back to filename.
  let className = fileToClassName(basename);
  const classSourceMatch = source.match(/^class\s+(\w+(?:::\w+)*)/m);
  if (classSourceMatch) className = classSourceMatch[1] ?? className;

  const candidates: Candidate[] = [];
  let outerDepth = 0; // depth outside any tracked class
  let classDepth = -1; // outerDepth at the moment we entered the class
  let inClass = false;
  let privateSection = false;
  const beforeActions: BeforeAction[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Blank lines and pure-comment lines never change structural depth.
    if (!trimmed || trimmed.startsWith("#")) continue;

    // ---- Class entry --------------------------------------------------
    if (!inClass && /^class\s+\w/.test(trimmed)) {
      classDepth = outerDepth;
      outerDepth++;
      inClass = true;
      continue;
    }

    // ---- before_action / before_filter declarations -------------------
    // Collect at immediate class-body depth (not inside methods).
    if (inClass && outerDepth === classDepth + 1) {
      const ba = parseBeforeAction(trimmed);
      if (ba) {
        beforeActions.push(ba);
        continue;
      }
    }

    // ---- Private/protected section boundary ---------------------------
    if (inClass && /^(?:private|protected)\s*$/.test(trimmed)) {
      privateSection = true;
      continue;
    }

    // ---- Public method definition -------------------------------------
    // Handle `def` specially: extract the full body so the outer depth
    // counter stays consistent (we don't process inner lines individually).
    if (
      inClass &&
      !privateSection &&
      outerDepth === classDepth + 1 &&
      /^def\s+\w/.test(trimmed) &&
      !/^def\s+self\./.test(trimmed)
    ) {
      const signatureText = collectDefSignature(lines, i);
      const defMatch = signatureText.match(
        /^def\s+(\w+[?!]?)\s*(?:\(([^)]*)\))?/,
      );
      if (defMatch) {
        const methodName = defMatch[1]!;
        const paramStr = (defMatch[2] ?? "").trim();
        const lineStart = i + 1; // 1-indexed

        const { endIdx, methodSource } = extractMethodBody(lines, i);
        const hints = buildHints(methodName, paramStr, className, beforeActions, methodSource);

        candidates.push({
          language: "ruby",
          filePath,
          relativePath,
          name: `${className}#${methodName}`,
          kind: methodName in REST_ROUTES ? "rails-action" : "function",
          lineStart,
          lineEnd: endIdx + 1, // 1-indexed
          source: methodSource,
          hints,
        });

        // Skip to the `end` line; the outer loop will advance past it.
        i = endIdx;
        continue;
      }
    }

    // ---- Generic depth tracking (all other openers/closers) -----------
    if (BLOCK_OPENER_RE.test(trimmed)) {
      outerDepth++;
    } else if (DO_OPENER_RE.test(trimmed)) {
      outerDepth++;
    } else if (END_RE.test(trimmed)) {
      outerDepth--;
      if (inClass && outerDepth === classDepth) {
        // We just closed the class body.
        inClass = false;
        privateSection = false;
        classDepth = -1;
      }
    }
    // `def` lines inside private sections or inside nested structures
    // that were NOT handled above still need depth tracking.
    else if (/^\s*def\s+/.test(trimmed)) {
      // Skip to the matching `end` so we don't accidentally pick up
      // nested method definitions (Ruby 2.0+ method-in-method).
      const { endIdx } = extractMethodBody(lines, i);
      i = endIdx;
    }
  }

  return candidates;
}

/**
 * Scan forward from `defIdx` (the `def` line) until the matching `end`,
 * tracking block depth. Returns the index of the `end` line and the
 * combined source text.
 */
function extractMethodBody(
  lines: string[],
  defIdx: number,
): { endIdx: number; methodSource: string } {
  let depth = 1; // the `def` itself
  let i = defIdx + 1;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    if (BLOCK_OPENER_RE.test(trimmed) || /^\s*def\s+/.test(trimmed)) {
      depth++;
    } else if (DO_OPENER_RE.test(trimmed)) {
      depth++;
    } else if (END_RE.test(trimmed)) {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }

  return {
    endIdx: i,
    methodSource: lines.slice(defIdx, i + 1).join("\n"),
  };
}

/**
 * Assemble the full `def` signature, possibly spanning multiple lines.
 *
 * Real-world Rails code wraps long parameter lists across lines:
 *
 *   def link_to(
 *     text,
 *     url:,
 *     **options
 *   )
 *
 * The single-line capture regex would match only `def link_to(`, see no
 * closing `)`, and drop the entire parameter list (hints.parameters
 * silently becomes undefined). This helper tracks paren depth forward
 * from `defIdx` and joins every line up to and including the one that
 * balances the opening paren back to zero, returning a single-line string
 * the regex can match in one go.
 *
 * Failure mode: a parameter default that itself contains a `)` on a
 * later line (e.g. `def foo(x = bar(\n  baz,\n))`) will still confuse the
 * `[^)]*` body of the param-capture regex; this matches the existing
 * single-line limitation, not a new regression.
 */
function collectDefSignature(lines: string[], defIdx: number): string {
  const first = lines[defIdx].trim();
  let parenDepth = countChars(first, "(") - countChars(first, ")");
  if (parenDepth <= 0) return first;

  let assembled = first;
  for (let i = defIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    assembled += " " + line.trim();
    parenDepth += countChars(line, "(") - countChars(line, ")");
    if (parenDepth <= 0) break;
  }
  return assembled;
}

function countChars(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/** Derive a CamelCase class name from a snake_case filename. */
function fileToClassName(basename: string): string {
  return basename
    .replace(/_controller\.rb$/, "Controller")
    .split("_")
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join("");
}

function buildHints(
  methodName: string,
  paramStr: string,
  className: string,
  beforeActions: BeforeAction[] = [],
  methodSource = "",
): CandidateHints {
  const hints: CandidateHints = {};

  // HTTP route hint for REST actions.
  const restRoute = REST_ROUTES[methodName];
  if (restRoute) {
    // Derive a pluralized resource name from the controller class name.
    const resource = controllerToResource(className);
    hints.httpRoute = {
      method: restRoute.method,
      path: restRoute.path.replace(":resources", resource),
    };
  }

  // Parse parameter list into structured hints.
  if (paramStr) {
    hints.parameters = splitParamsTopLevel(paramStr)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        // Extract the leading identifier, skipping splat / double-splat /
        // block prefixes (`*args`, `**opts`, `&block`). This also handles
        // keyword-arg syntax (`name:`, `age: 18`) and positional defaults
        // (`format = :json`); both reduce to the bare name.
        const match = p.match(/^[*&]*\s*(\w+)/);
        return { name: match?.[1] ?? p };
      });
  }

  // Surface applicable before_action callbacks as auth notes so the LLM
  // can describe access control without reading the class body.
  const applicableCallbacks = beforeActions
    .filter((ba) => beforeActionApplies(ba, methodName))
    .map((ba) => `:${ba.callback}`);
  if (applicableCallbacks.length > 0) {
    hints.notes = [`before_action: ${applicableCallbacks.join(", ")}`];
  }

  // Extract ActiveRecord model references from the method body.
  if (methodSource) {
    const models = extractActiveRecordModels(methodSource);
    if (models.length > 0) hints.databaseTables = models;

    // Function callees (rough: word followed by `(`).
    // Skip `def` lines so the method's own name is not recorded as a callee.
    const methodBody = methodSource
      .split("\n")
      .filter((line) => !/^\s*def\s/.test(line))
      .join("\n");
    const callees = new Set<string>();
    const callRe = /\b([a-zA-Z_][\w]*)\s*\(/g;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(methodBody)) !== null) {
      const name = cm[1] ?? "";
      if (name.length < 3) continue;
      if (RUBY_KEYWORDS.has(name)) continue;
      if (RUBY_STDLIB_METHODS.has(name)) continue;
      callees.add(name);
    }
    if (callees.size > 0) hints.callees = [...callees].slice(0, 30);

    // Side-effect notes: ActionMailer and background job queueing are
    // high-blast-radius operations that BAs need to know about.
    const sideEffects: string[] = [];
    // ActionMailer: `UserMailer.welcome.deliver_later` / `deliver_now`
    if (/\.\s*deliver_(?:later|now|later!|now!)/.test(methodSource)) {
      sideEffects.push("Sends email (ActionMailer)");
    }
    // ActiveJob / Sidekiq / Resque: `SomeJob.perform_later` / `perform_async` /
    // `perform_in` / `perform_at`
    if (/\bperform_(?:later|async|in|at)\s*\(/.test(methodSource)) {
      sideEffects.push("Enqueues background job");
    }
    // Message broker publishing. Three dominant Ruby broker libraries:
    //   - Bunny (RabbitMQ): `Bunny.new(...)` opens a connection; the
    //     presence of `Bunny.new` in a method body almost always leads to
    //     `exchange.publish(...)` a few lines later -- flagging the connection
    //     is the conservative signal.
    //   - Karafka (Kafka): `Karafka.producer.produce_sync(...)` and
    //     `produce_async(...)` are the two canonical publish paths in Karafka 2.x.
    //   - ruby-kafka: `kafka.deliver_message(...)` is the one-call publish API.
    // Mirrors Java JMS/AMQP/Kafka and C# MassTransit/Azure Service Bus notes.
    if (
      /\bBunny\.new\s*\(/.test(methodSource)
      || /\bKarafka\.producer\.produce_(?:sync|async)\s*\(/.test(methodSource)
      || /\bkafka\.deliver_message\s*\(/.test(methodSource)
    ) {
      sideEffects.push("Sends message to broker (Bunny / Karafka)");
    }
    // Common Ruby HTTP clients: HTTParty, Faraday, Net::HTTP, rest-client
    if (/\b(HTTParty|Faraday|RestClient)\b/.test(methodSource)
      || /Net::HTTP\b/.test(methodSource)) {
      sideEffects.push("Makes outbound HTTP request");
    }
    // External process execution. Ruby has many idioms for spawning a child
    // process; this detector covers the five most common, all audit-critical
    // because the spawned process inherits the server's privileges:
    //   - system("cmd", ...) / system 'cmd' / system "cmd"  (Kernel#system)
    //   - `cmd` / `cmd with args`                            (backtick literal)
    //   - IO.popen("cmd", ...)                               (pipe)
    //   - Process.spawn / Process.exec                       (explicit)
    //   - Open3.popen3 / capture3 / capture2 / capture2e / popen2 / popen2e
    // The `system` matcher requires the next token to be `(`, `'`, or `"` so
    // it doesn't trip on incidental uses like `obj.system` or `system.foo`.
    // Mirrors Java's Runtime.exec / ProcessBuilder and C#'s Process.Start
    // process-execution notes.
    if (
      /\bsystem\s*[("']/.test(methodSource)
      || /`[^`\n]+`/.test(methodSource)
      || /\bIO\.popen\b/.test(methodSource)
      || /\bProcess\.(?:spawn|exec)\b/.test(methodSource)
      || /\bOpen3\.(?:popen3|capture3|capture2|capture2e|popen2|popen2e)\b/.test(methodSource)
    ) {
      sideEffects.push("Executes external process");
    }
    // Cache mutation. Rails.cache.write / .delete / .delete_matched / .clear
    // mutate shared cache state. Read-only operations (Rails.cache.read,
    // .fetch, .exist?) are intentionally NOT flagged: no blast radius beyond
    // a possible cache miss. The .clear and .delete_matched variants in
    // particular are extremely high-blast-radius (clear ALL keys vs all keys
    // matching a pattern); the LLM should surface those as audit-critical
    // business rules. Mirrors Java @CacheEvict/@CachePut and C# IMemoryCache
    // mutation detection.
    if (/\bRails\.cache\.(?:write|write_multi|delete|delete_matched|delete_multi|clear)\b/.test(methodSource)) {
      sideEffects.push("Mutates application cache");
    }
    // Database transactions. Rails wraps atomic operations with
    // `Model.transaction do ... end` (or `{ ... }` curly-block form).
    // The pattern requires `.transaction` to be followed by `do`, `{`, or `(`
    // so common false positives are filtered out:
    //   - `record.transaction_id`  -> no block delimiter, skipped
    //   - `account.transactions`   -> plural, no block delimiter, skipped
    //   - `Account.transaction do` -> matches (Rails idiom)
    //   - `Account.transaction { ... }` -> matches (curly block)
    //   - `Account.transaction(requires_new: true) do` -> matches (with args)
    if (/\.transaction\s*(?:do\b|\{|\()/.test(methodSource)) {
      sideEffects.push("Executes within a database transaction");
    }
    // Stored procedure calls. Two reliable Rails patterns:
    //   1. exec_stored_procedure('proc', params) -- SQL Server adapter
    //      (ActiveRecord SQLServer Adapter gem). Method name is proc-specific;
    //      no Rails core method shares this name.
    //   2. connection.execute("CALL proc_name(...)") -- MySQL stored proc.
    //      connection.execute("EXEC proc_name ...") -- SQL Server direct call.
    //      The CALL/EXEC keyword at the start of the SQL string literal is
    //      exclusively for stored-procedure invocation; plain SELECT/INSERT/UPDATE
    //      queries never start with these words.
    // Both signals carry audit value: the proc may contain triggers,
    // cross-table writes, and logic invisible in the calling controller.
    // Mirrors Django cursor.callproc, C# CommandType.StoredProcedure, and
    // Java prepareCall / createStoredProcedureQuery / SimpleJdbcCall detection.
    if (
      /\bexec_stored_procedure\s*\(/.test(methodSource)
      || /\.execute\s*\(\s*["']\s*(?:CALL|EXEC)\s+/i.test(methodSource)
    ) {
      sideEffects.push("Calls stored procedure");
    }
    // Filesystem mutations. Writing, deleting, moving, or creating files
    // affects shared disk state and is audit-relevant. Reads (File.read,
    // File.readlines, File.foreach, File.exist?) are intentionally NOT
    // flagged: no blast radius. Detects four families:
    //   - File class mutators: write, delete, rename, truncate, unlink,
    //     chmod, chown
    //   - File.open with write or append mode (second arg starts with w/a)
    //   - FileUtils mutators: cp, cp_r, mv, rm, rm_f, rm_rf, mkdir, mkdir_p,
    //     touch, chmod, chown, ln, ln_s, remove
    //   - Dir mutators: mkdir, rmdir, delete, unlink
    if (
      /\bFile\.(?:write|delete|rename|truncate|unlink|chmod|chown)\s*\(/.test(methodSource)
      || /\bFile\.open\s*\(\s*[^,)]+,\s*["'][wa]/.test(methodSource)
      || /\bFileUtils\.(?:cp|cp_r|mv|rm|rm_f|rm_rf|mkdir|mkdir_p|touch|chmod|chown|ln|ln_s|remove)\b/.test(methodSource)
      || /\bDir\.(?:mkdir|rmdir|delete|unlink)\s*\(/.test(methodSource)
    ) {
      sideEffects.push("Writes to file system");
    }
    if (sideEffects.length > 0) {
      hints.notes = [...(hints.notes ?? []), ...sideEffects];
    }
  }

  return hints;
}

/**
 * Split a Ruby parameter string on commas at bracket depth zero.
 * Tracks `(`, `[`, `{` so that defaults containing internal commas don't
 * leak phantom params. Without this, `def f(items = [1, 2, 3])` splits to
 * `["items = [1", "2", "3]"]` and the `^[*&]*\s*(\w+)` extractor produces
 * `{name: "2"}` / `{name: "3"}` phantom entries the LLM would dutifully
 * document as real arguments. Same shape as Django's helper at
 * `src/core/parsers/django.ts#splitParamsTopLevel`.
 *
 * Failure mode: commas inside string literals (e.g. `def f(x = "a,b")`)
 * are not specially handled, identical to the upstream `[^)]*` regex's
 * pre-existing limitation; not a new regression.
 */
function splitParamsTopLevel(params: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of params) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Derive the REST resource path segment from the controller class name.
 *  `UsersController` -> `users`, `LineItemsController` -> `line_items`,
 *  `Admin::PostsController` -> `posts`.
 *
 *  Rails inflects PascalCase controller names to snake_case route segments,
 *  so a single-word controller maps cleanly but a multi-word one needs the
 *  camel-to-snake conversion. Pure ASCII regex; acronym handling matches
 *  the common (`APIController` -> `api`) cases but cannot honor user-defined
 *  inflection registries (`OAuth` -> `oauth`), which is documented at call
 *  sites as a 5% miss vs. the 95% standard case.
 */
function controllerToResource(className: string): string {
  // Strip module namespace (e.g. Admin::UsersController -> UsersController).
  const base = className.split("::").pop() ?? className;
  const stripped = base.replace(/Controller$/, "");
  // Two-pass PascalCase -> snake_case:
  // (1) acronym boundary (APIKeys -> API_Keys) so we don't end up with a_p_i_keys
  // (2) standard camelCase boundary (UserName -> User_Name)
  return stripped
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}
