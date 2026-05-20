// Triviality filters for the candidate set. Run AFTER parsing in
// scanProject so each parser's tests stay focused on "did we extract the
// method?" and the filtering policy lives in one place.
//
// Today: isConstantReturnOnly(), methods whose entire executable body
// is `return <literal>;`. These are framework lifecycle stubs
// (Application.cfc#onRequestStart returning true), placeholder hooks,
// or empty defaults. Producing a use-case page for them wastes LLM
// tokens and ships docs that describe a constant placeholder as if it
// were business logic.
//
// Surfaced 2026-05-16 from the TestBox multi-repo signal run:
// cfml/browser/Application.cfc#onRequestStart had a single-line body
// `return true;` and the LLM produced an "Allow Every Incoming
// Request to Proceed" page.
//
// Tomorrow: pure-delegation methods (return other.method(args)) ship
// as a sibling helper in this file, gated by includeDelegations.

import type { Candidate } from "../types.js";

// Match a single literal token at the position. Order matters: try
// keywords + numbers before the looser string / collection forms so
// `true` doesn't get partially-matched by something more permissive.
//
// - Booleans, null, and CFML's `yes`/`no` aliases (case-insensitive).
// - Integers, with optional leading sign.
// - Single- OR double-quoted string with no embedded quote characters.
//   String-with-escapes is intentionally NOT matched: it usually
//   carries meaningful copy that a doc would want to surface (URLs,
//   error messages). Constant single-word strings ("ok", "v1") match.
// - Empty struct `{}` or empty array `[]`. Non-empty collections
//   would carry real data and are kept.
const LITERAL_RE = String.raw`(?:` +
  String.raw`true|false|null|yes|no` +
  String.raw`|-?\d+` +
  String.raw`|"[^"\\]*"|'[^'\\]*'` +
  String.raw`|\{\s*\}|\[\s*\]` +
  String.raw`)`;

/**
 * True when the candidate's body is exactly one return-of-a-literal
 * statement (possibly preceded by `<cfargument>` declarations or
 * `var`-style locals that don't appear in the body of a constant-return
 * method anyway). Comments are stripped before the match so a JSDoc
 * block above `return true;` doesn't matter.
 */
export function isConstantReturnOnly(source: string): boolean {
  const body = extractBody(source);
  if (body === null) return false;
  const stripped = stripComments(body).trim();
  if (stripped.length === 0) return false;

  // CFML tag-style: `<cfreturn LITERAL/>` or `<cfreturn LITERAL>` or
  // `<cfreturn>` (void). Also allow optional `<cfargument ...>` tags
  // before the return (they're declarations, not executable logic).
  const cfReturnRe = new RegExp(
    String.raw`^(?:<cfargument\b[^>]*>\s*)*<cfreturn\b(?:\s+` +
      LITERAL_RE +
      String.raw`\s*)?/?\s*>\s*$`,
    "i",
  );
  if (cfReturnRe.test(stripped)) return true;

  // Script/Java: `return LITERAL;` or `return;` (void).
  const scriptReturnRe = new RegExp(
    String.raw`^return(?:\s+` + LITERAL_RE + String.raw`)?\s*;?\s*$`,
    "i",
  );
  if (scriptReturnRe.test(stripped)) return true;

  return false;
}

/**
 * Pull the body out of a function source. Handles:
 *   - `function foo(...) { BODY }` (script + Java)
 *   - `<cffunction ...> BODY </cffunction>` (CFML tag)
 * Returns null when the structure isn't recognized, so callers default
 * to "not constant" (conservative; we'd rather keep a candidate than
 * silently drop one we can't analyze).
 */
function extractBody(source: string): string | null {
  // CFML tag-style first: the <cffunction> wrapper is unambiguous.
  const tagMatch = source.match(
    /<cffunction\b[^>]*>([\s\S]*?)<\/cffunction\s*>/i,
  );
  if (tagMatch) return tagMatch[1] ?? null;

  // Script / Java: take everything between the first `{` after the
  // first `)` and the matching close brace. Naive: doesn't track
  // string state, so a `}` inside a string literal inside the body
  // would close early. That's fine here because we're only trying to
  // recognize trivial single-statement bodies; complex bodies fail
  // the regex below and the candidate is kept (the conservative path).
  const parenClose = source.indexOf(")");
  if (parenClose < 0) return null;
  const open = source.indexOf("{", parenClose);
  if (open < 0) return null;
  const close = source.lastIndexOf("}");
  if (close <= open) return null;
  return source.slice(open + 1, close);
}

function stripComments(s: string): string {
  // CFML tag comments `<!--- ... --->` (3 dashes).
  let out = s.replace(/<!---[\s\S]*?--->/g, "");
  // Block comments `/* ... */` including JSDoc.
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");
  // Single-line `// ...` to end of line.
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}

/**
 * Filter `candidates` by dropping every entry whose body is exactly a
 * literal return. `includeConstantReturns` skips the filter when the
 * customer wants the placeholder docs anyway (audit completeness).
 */
export function filterConstantReturns(
  candidates: Candidate[],
  includeConstantReturns: boolean,
): Candidate[] {
  if (includeConstantReturns) return candidates;
  return candidates.filter((c) => !isConstantReturnOnly(c.source));
}
