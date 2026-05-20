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
  const basename = path.basename(filePath);
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
        const hints = buildHints(methodName, paramStr, className);

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
