import path from "node:path";
import type { Candidate, CandidateHints } from "../types.js";

/**
 * Django view parser; pragmatic regex/indentation-scan approach.
 *
 * Targets:
 *   - Files named `views.py`
 *   - Files ending in `_views.py` (e.g. `user_views.py`, `api_views.py`)
 *   - Python files inside a `views/` directory
 *
 * Surfaces:
 *   - Function-based views (FBVs): top-level `def name(request, ...)` functions
 *   - Class-based view (CBV) HTTP verb methods: get/post/put/patch/delete on
 *     classes that inherit from known Django or DRF view bases
 *   - DRF ViewSet action methods: list/retrieve/create/update/partial_update/destroy
 *
 * Python is whitespace-significant, so class body extent is tracked by comparing
 * indentation depth rather than matching `end` tokens. The approach handles 95%
 * of real Django codebases; edge cases (multi-line strings with `def` inside,
 * deeply nested class hierarchies) are conservatively kept.
 *
 * ADR-037.
 */

// DRF ViewSet canonical action methods mapped to HTTP verb and path suffix.
const DRF_ACTIONS: Record<string, { method: string; pathSuffix: string }> = {
  list:           { method: "GET",    pathSuffix: "" },
  retrieve:       { method: "GET",    pathSuffix: "/:id" },
  create:         { method: "POST",   pathSuffix: "" },
  update:         { method: "PUT",    pathSuffix: "/:id" },
  partial_update: { method: "PATCH",  pathSuffix: "/:id" },
  destroy:        { method: "DELETE", pathSuffix: "/:id" },
};

// HTTP verb method names on class-based views.
const HTTP_VERB_METHODS: Record<string, string> = {
  get:     "GET",
  post:    "POST",
  put:     "PUT",
  patch:   "PATCH",
  delete:  "DELETE",
  head:    "HEAD",
  options: "OPTIONS",
};

// Known Django and DRF view base class names (unqualified, no module prefix).
const DJANGO_VIEW_BASES = new Set([
  "View",
  "TemplateView", "RedirectView",
  "DetailView", "ListView", "FormView",
  "CreateView", "UpdateView", "DeleteView",
  "ArchiveIndexView", "YearArchiveView", "MonthArchiveView",
  "WeekArchiveView", "DayArchiveView", "TodayArchiveView", "DateDetailView",
  "BaseDetailView", "BaseListView", "BaseCreateView", "BaseUpdateView",
  "BaseDeleteView", "BaseFormView",
  "APIView", "GenericAPIView",
  "ViewSet", "GenericViewSet", "ReadOnlyModelViewSet", "ModelViewSet",
]);

export function parseDjango(
  filePath: string,
  relativePath: string,
  source: string,
): Candidate[] {
  if (!isDjangoViewFile(filePath)) return [];

  const lines = source.split("\n");
  const candidates: Candidate[] = [];

  let inViewClass = false;
  let classIndent = 0;
  let className = "";

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Blank lines and pure comments don't affect structure.
    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

    const indent = getIndent(raw);

    // Exit view class when indentation returns to (or before) the class's level.
    if (inViewClass && indent <= classIndent) {
      inViewClass = false;
      // Fall through: process this line as module-level.
    }

    // ---- Module level -------------------------------------------------
    if (!inViewClass && indent === 0) {
      // Class declaration (handles multi-line base lists)
      if (/^class\s+/.test(trimmed)) {
        const { signature, endIdx: sigEndIdx } = collectParenedHeader(lines, i);
        const classMatch = signature.match(/^class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/);
        if (classMatch) {
          const name = classMatch[1]!;
          const bases = classMatch[2]!;
          if (isViewClass(bases)) {
            inViewClass = true;
            classIndent = 0;
            className = name;
          }
          i = sigEndIdx + 1;
          continue;
        }
      }

      // Function definition (handles multi-line signatures)
      if (/^def\s+/.test(trimmed)) {
        const { signature, endIdx: sigEndIdx } = collectParenedHeader(lines, i);
        const defMatch = signature.match(/^def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
        if (defMatch) {
          const name = defMatch[1]!;
          const params = defMatch[2]!;
          const decoratorStart = findDecoratorStart(lines, i);
          const { endIdx } = extractPythonBody(lines, i, sigEndIdx);

          if (!name.startsWith("_") && isFbv(params)) {
            candidates.push({
              language: "python",
              filePath,
              relativePath,
              name,
              kind: "django-view",
              lineStart: decoratorStart + 1, // 1-indexed; includes leading decorators
              lineEnd: endIdx + 1,
              source: lines.slice(decoratorStart, endIdx + 1).join("\n"),
              hints: buildFbvHints(params),
            });
          }
          i = endIdx + 1;
          continue;
        }
      }
    }

    // ---- Inside view class --------------------------------------------
    if (inViewClass && indent > classIndent) {
      if (/^def\s+/.test(trimmed)) {
        const { signature, endIdx: sigEndIdx } = collectParenedHeader(lines, i);
        const defMatch = signature.match(/^def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
        if (defMatch) {
          const name = defMatch[1]!;
          const params = defMatch[2]!;
          const decoratorStart = findDecoratorStart(lines, i);
          const { endIdx } = extractPythonBody(lines, i, sigEndIdx);

          const httpVerb = HTTP_VERB_METHODS[name];
          const drfAction = DRF_ACTIONS[name];

          if (!name.startsWith("_") && (httpVerb !== undefined || drfAction !== undefined)) {
            candidates.push({
              language: "python",
              filePath,
              relativePath,
              name: `${className}#${name}`,
              kind: "django-view",
              lineStart: decoratorStart + 1, // 1-indexed; includes leading decorators
              lineEnd: endIdx + 1,
              source: lines.slice(decoratorStart, endIdx + 1).join("\n"),
              hints: buildCbvHints(name, params, className, httpVerb, drfAction),
            });
          }
          i = endIdx + 1;
          continue;
        }
      }
    }

    i++;
  }

  return candidates;
}

/** Return true when filePath looks like a Django views module.
 *
 * Matches any depth under a `views/` package, including sub-packages used for
 * API versioning (`views/api/v1.py`) or domain grouping (`views/admin/users.py`).
 * Requires a literal `/views/` segment so look-alike names like `subviews/foo.py`
 * are not picked up.
 */
function isDjangoViewFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (basename === "views.py" || basename.endsWith("_views.py")) return true;
  return /[/\\]views[/\\].+\.py$/.test(filePath);
}

/**
 * Return true when the class `bases` string includes at least one known
 * Django/DRF view base. Handles qualified names (`views.View`) and any
 * class ending in `View` or `ViewSet` to catch project-local base classes.
 */
function isViewClass(bases: string): boolean {
  return bases.split(",").some((b) => {
    const name = b.trim().split(".").pop() ?? "";
    return (
      DJANGO_VIEW_BASES.has(name) ||
      (name.endsWith("View") && name.length > 4) ||
      name.endsWith("ViewSet")
    );
  });
}

/**
 * Return true when the parameter list begins with `request`, indicating a
 * function-based view (FBV) signature.
 *
 * Allows for a type annotation (`request: HttpRequest`) or a default value
 * (`request=None`); rejects look-alike names (`request_id`, `requests`).
 */
function isFbv(params: string): boolean {
  const first = params.split(",")[0]?.trim() ?? "";
  if (!first) return false;
  const name = first.replace(/^\*+/, "").split(/\s*[=:]\s*/)[0]?.trim() ?? "";
  return name === "request";
}

/**
 * Scan backward from `defIdx` to include any decorator lines (`@...`)
 * immediately preceding the function definition, skipping blank/comment lines.
 * Returns the index of the first decorator (or `defIdx` if none).
 *
 * Works for both module-level FBV decorators (no indent) and class-internal
 * CBV method decorators (indented to match the def). Indentation is irrelevant
 * to the walk-back; what matters is bracket balance and the `@`-prefix anchor.
 *
 * Handles multi-line decorator forms by tracking bracket depth across lines:
 *   @method_decorator(
 *     cache_page(60 * 15),
 *     name="dispatch",
 *   )
 *   def view(request): ...
 * A line is considered part of a multi-line decorator's bracket span when the
 * net `)` minus `(` count of lines walked back since the last `@` is positive.
 * `[]` and `{}` are counted as brackets too (Python allows implicit line
 * continuation inside any of these). Bracket counts inside string literals
 * are not specially handled; the failure mode is over-inclusion of a non-
 * decorator line above a function, never under-inclusion of a real decorator.
 */
function findDecoratorStart(lines: string[], defIdx: number): number {
  let start = defIdx;
  let j = defIdx - 1;
  let bracketDepth = 0;

  while (j >= 0) {
    const trimmed = lines[j].trim();
    if (!trimmed || trimmed.startsWith("#")) { j--; continue; }

    const wasInsideBrackets = bracketDepth > 0;
    for (const ch of trimmed) {
      if (ch === ")" || ch === "]" || ch === "}") bracketDepth++;
      else if (ch === "(" || ch === "[" || ch === "{") bracketDepth--;
    }

    if (bracketDepth < 0) {
      // Walked past the decorator's opening bracket on a line that opens more
      // than was previously closed; only valid if it's the `@`-prefixed line.
      if (trimmed.startsWith("@")) start = j;
      break;
    }

    if (bracketDepth === 0 && trimmed.startsWith("@")) {
      start = j;
      j--;
      continue;
    }

    if (wasInsideBrackets || bracketDepth > 0) {
      // Inside a multi-line decorator's bracket span; keep walking back.
      j--;
      continue;
    }

    break;
  }
  return start;
}

/**
 * Scan forward from `scanStartIdx` until a non-blank, non-comment line at the
 * same (or lesser) indentation level as `lines[defIdx]` is found. Returns the
 * last line inside the body.
 *
 * `scanStartIdx` defaults to `defIdx` for single-line `def foo(...):` shapes.
 * For wrapped signatures, callers pass the index of the line containing the
 * closing `):` so the body scanner doesn't terminate prematurely on the
 * `)` line (which sits at the same indent as the def line).
 *
 * Callers slice `lines` themselves from the decorator-start anchor through
 * `endIdx` to capture decorator lines above `defIdx` in the source.
 */
function extractPythonBody(
  lines: string[],
  defIdx: number,
  scanStartIdx: number = defIdx,
): { endIdx: number } {
  const defIndent = getIndent(lines[defIdx]);
  let endIdx = scanStartIdx;
  let j = scanStartIdx + 1;

  while (j < lines.length) {
    const trimmed = lines[j].trim();
    if (!trimmed || trimmed.startsWith("#")) { j++; continue; }
    if (getIndent(lines[j]) <= defIndent) break;
    endIdx = j;
    j++;
  }

  return { endIdx };
}

/**
 * Collect a (possibly multi-line) parenthesised header into a single-line
 * string the downstream regex can match in one go. Tracks paren depth across
 * lines so `def my_view(\n    request,\n    pk,\n):` becomes
 * `def my_view( request, pk, ):` and
 * `class UserView(\n    LoginRequiredMixin,\n    View,\n):` becomes
 * `class UserView( LoginRequiredMixin, View, ):`. Returns the joined header
 * plus the index of the line containing the closing `)` (or `startIdx` for
 * single-line headers); the caller passes that index into `extractPythonBody`
 * so the body scan starts AFTER the wrapped signature (or skips past the
 * closing `):` line for wrapped class headers).
 *
 * Failure mode mirrors the existing single-line `[^)]*` capture regex: a
 * default value or base expression containing an unbalanced `)` in a string
 * literal (e.g. `def foo(x="(")`) would confuse the depth tracker, but this
 * is vanishingly rare in real Django code.
 */
function collectParenedHeader(
  lines: string[],
  startIdx: number,
): { signature: string; endIdx: number } {
  const first = lines[startIdx];
  let depth = countChars(first, "(") - countChars(first, ")");
  if (depth <= 0) return { signature: first.trim(), endIdx: startIdx };

  let assembled = first.trim();
  for (let j = startIdx + 1; j < lines.length; j++) {
    const line = lines[j];
    assembled += " " + line.trim();
    depth += countChars(line, "(") - countChars(line, ")");
    if (depth <= 0) return { signature: assembled, endIdx: j };
  }
  return { signature: assembled, endIdx: startIdx };
}

function countChars(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/** Count leading spaces; tabs count as 4. */
function getIndent(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === " ") count++;
    else if (ch === "\t") count += 4;
    else break;
  }
  return count;
}

function buildFbvHints(params: string): CandidateHints {
  const hints: CandidateHints = {};
  const parsed = parseParams(params);
  if (parsed.length > 0) hints.parameters = parsed;
  return hints;
}

function buildCbvHints(
  _methodName: string,
  params: string,
  className: string,
  httpVerb: string | undefined,
  drfAction: { method: string; pathSuffix: string } | undefined,
): CandidateHints {
  const hints: CandidateHints = {};

  if (httpVerb !== undefined) {
    hints.httpRoute = { method: httpVerb, path: "/:resource" };
  } else if (drfAction !== undefined) {
    const resource = classToResource(className);
    hints.httpRoute = {
      method: drfAction.method,
      path: `/${resource}${drfAction.pathSuffix}`,
    };
  }

  const parsed = parseParams(params).filter(
    (p) => p.name !== "self" && p.name !== "request",
  );
  if (parsed.length > 0) hints.parameters = parsed;

  return hints;
}

/**
 * Derive a REST resource name from a view class name.
 * `UserViewSet` -> `user`, `PostAPIView` -> `post`, `OrderLineItemView` -> `order_line_item`,
 * `APIKeyViewSet` -> `api_key`. Mirrors the two-pass PascalCase -> snake_case
 * idiom used by the Rails parser's controller-to-resource conversion:
 * (1) acronym boundary so `APIKey` becomes `API_Key` (not `a_p_i_key`),
 * (2) standard camel boundary so `UserName` becomes `User_Name`.
 */
function classToResource(className: string): string {
  const base = className
    .replace(/ViewSet$/, "")
    .replace(/APIView$/, "")
    .replace(/View$/, "");
  return base
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Split a Python parameter list into structured `{ name }` entries.
 *
 * Splits on commas at bracket depth zero so generic type annotations
 * (`Dict[str, int]`, `Optional[List[Tuple[str, Any]]]`) and dict / list /
 * tuple defaults are treated as a single param rather than chopped apart.
 * Without the depth-aware split, a comma inside `[...]` would emit phantom
 * params like `{ name: "int]" }` or `{ name: "Any]]" }` from the trailing
 * fragment of the annotation; the LLM would document those as real arguments.
 *
 * Skips Python's positional-only (`/`) and keyword-only (`*`) markers; these
 * are syntax tokens that change argument-passing rules for the params that
 * follow, not parameters themselves. Without this filter they leak into
 * `hints.parameters` as `{ name: "/" }` and `{ name: "" }` (the latter from
 * `*` losing its sole character to the `^[*]+` strip).
 *
 * Examples:
 *   `def my_view(request, *, format="json")`             -> ["request", "format"]
 *   `def my_view(request, pk, /, slug, *, format)`       -> ["request","pk","slug","format"]
 *   `def my_view(*args, **kwargs)`                       -> ["args", "kwargs"]
 *   `def my_view(request, filters: Dict[str, int])`      -> ["request", "filters"]
 */
function parseParams(params: string): Array<{ name: string }> {
  return splitParamsTopLevel(params)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => p !== "*" && p !== "/")
    .map((p) => {
      const name = p.replace(/^[*]+/, "").split(/\s*[=:]\s*/)[0]?.trim() ?? p;
      return { name };
    });
}

/**
 * Split a Python parameter string on commas at bracket depth zero.
 * Tracks `(`, `[`, `{` (Python allows implicit line continuation inside any
 * of these, and all three can appear in real param defaults / annotations).
 * String-literal commas are not specially handled; the failure mode mirrors
 * the documented limitation of the upstream `[^)]*` regex (a comma inside
 * a string default like `def f(x="a,b")` would still split incorrectly,
 * but the surrounding `[^)]*` regex would have already mis-captured the
 * params block in that case).
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
