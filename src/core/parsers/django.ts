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

// Python control-flow keywords and common built-ins excluded from callee extraction.
const PYTHON_KEYWORDS = new Set([
  "if", "elif", "else", "for", "while", "with", "try", "except", "finally",
  "raise", "return", "yield", "import", "from", "class", "def", "lambda",
  "pass", "break", "continue", "not", "and", "or", "in", "is", "print",
  "isinstance", "issubclass", "type", "len", "range", "enumerate", "zip",
  "map", "filter", "sorted", "reversed", "list", "dict", "set", "tuple",
  "str", "int", "float", "bool", "bytes", "object", "super", "vars", "dir",
  "hasattr", "getattr", "setattr", "delattr", "next", "iter", "open",
  "repr", "format", "abs", "min", "max", "sum", "any", "all", "input",
  "property", "staticmethod", "classmethod",
]);

// Django / DRF decorators that control view access. Surfaced as hints.notes
// so the LLM can describe auth requirements without reading the function body.
const DJANGO_AUTH_DECORATORS = new Set([
  "login_required",
  "permission_required",
  "staff_member_required",
  "user_passes_test",
  "permission_classes",    // DRF @permission_classes([...]) on FBVs
  "authentication_classes",
]);

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

// Auth mixins that apply login/permission requirements to all methods in a CBV.
// Keys are unqualified class names; values are the auth note strings emitted,
// matching the @login_required / @permission_required FBV decorator patterns.
const DJANGO_AUTH_MIXINS: Record<string, string> = {
  LoginRequiredMixin: "auth: login_required",
  PermissionRequiredMixin: "auth: permission_required",
  UserPassesTestMixin: "auth: user_passes_test",
};

function extractMixinAuthNotes(bases: string): string[] {
  const notes: string[] = [];
  for (const b of bases.split(",")) {
    const name = b.trim().split(".").pop() ?? "";
    const note = DJANGO_AUTH_MIXINS[name];
    if (note) notes.push(note);
  }
  return notes;
}

// Return the depth-balanced substring inside the parens beginning at openIdx
// (which must point at '('), or null if the parens never close. String
// literals are not specially handled; a ')' inside a quoted arg would close
// early, but auth-decorator arguments (perm strings, mixin/test names) don't
// contain parens in practice, and the failure mode is a dropped note rather
// than a wrong one.
function extractBalancedParen(text: string, openIdx: number): string | null {
  let depth = 0;
  for (let k = openIdx; k < text.length; k++) {
    const ch = text[k];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, k);
    }
  }
  return null;
}

// First positional argument of a decorator arg list: everything up to the
// first top-level comma. Nested () [] {} are skipped so a comma inside them
// (e.g. permission_required('app.view', raise_exception=True)) doesn't split
// the positional arg early.
function firstTopLevelArg(args: string): string {
  let depth = 0;
  for (let k = 0; k < args.length; k++) {
    const ch = args[k];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) return args.slice(0, k);
  }
  return args;
}

// Map a decorator expression (`login_required` or `permission_required('x')`)
// to its `auth: ...` note, or null when the name is not an access decorator.
function authNoteForDecoratorExpr(expr: string): string | null {
  const m = expr.trim().match(/^(\w+)\s*(?:\(([\s\S]*)\))?\s*$/);
  if (!m) return null;
  const name = m[1]!;
  if (!DJANGO_AUTH_DECORATORS.has(name)) return null;
  return m[2] !== undefined ? `auth: ${name}(${m[2].trim()})` : `auth: ${name}`;
}

// Django CBVs apply an FBV access decorator to the whole class (or one method)
// via @method_decorator(login_required, name='dispatch'). @method_decorator is
// not itself an access decorator, so unwrap each occurrence and surface the
// wrapped (first positional) decorator as the auth note. Handles single-line
// and multi-line forms; the block text is already bracket-balanced because the
// caller bounds it via findDecoratorStart.
function methodDecoratorAuthNotes(blockText: string): string[] {
  const notes: string[] = [];
  const marker = "@method_decorator(";
  let from = 0;
  for (;;) {
    const at = blockText.indexOf(marker, from);
    if (at === -1) break;
    const openIdx = at + marker.length - 1; // points at '('
    const inner = extractBalancedParen(blockText, openIdx);
    if (inner === null) break;
    from = openIdx + inner.length + 2; // past the matched ')'
    const note = authNoteForDecoratorExpr(firstTopLevelArg(inner));
    if (note) notes.push(note);
  }
  return notes;
}

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
  let classPermissions: string[] = [];
  let classModels: string[] = [];
  let classMixinAuthNotes: string[] = [];

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
      classPermissions = [];
      classModels = [];
      classMixinAuthNotes = [];
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
            classPermissions = [];
            classModels = [];
            // Class-level auth comes from two sources: inherited auth mixins
            // and @method_decorator(...) applied above the class declaration.
            // Dedup so a class that both inherits LoginRequiredMixin and stacks
            // @method_decorator(login_required) emits the note once.
            classMixinAuthNotes = Array.from(new Set([
              ...extractMixinAuthNotes(bases),
              ...extractDecoratorNotes(lines, findDecoratorStart(lines, i), i),
            ]));
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
            const authNotes = extractDecoratorNotes(lines, decoratorStart, i);
            candidates.push({
              language: "python",
              filePath,
              relativePath,
              name,
              kind: "django-view",
              lineStart: decoratorStart + 1, // 1-indexed; includes leading decorators
              lineEnd: endIdx + 1,
              source: lines.slice(decoratorStart, endIdx + 1).join("\n"),
              hints: buildFbvHints(params, authNotes, lines.slice(decoratorStart, endIdx + 1).join("\n")),
            });
          }
          i = endIdx + 1;
          continue;
        }
      }
    }

    // ---- Inside view class --------------------------------------------
    if (inViewClass && indent > classIndent) {
      // Collect `permission_classes = [ClassA, ClassB]` at the class body level.
      // This is a class attribute in DRF that applies to every method.
      // Handles both single-line and multi-line list forms: real DRF code
      // routinely formats permission lists across several lines, e.g.
      //     permission_classes = [
      //         IsAuthenticated,
      //         IsAdminUser,
      //     ]
      // so we accumulate lines until the closing `]` is found.
      const pcStart = trimmed.match(/^permission_classes\s*=\s*\[(.*)$/);
      if (pcStart) {
        let inner = pcStart[1] ?? "";
        let j = i;
        while (!inner.includes("]") && j + 1 < lines.length) {
          j++;
          inner += " " + lines[j].trim();
        }
        const closeIdx = inner.indexOf("]");
        if (closeIdx >= 0) inner = inner.substring(0, closeIdx);
        classPermissions = inner
          .split(",")
          .map((s) => s.trim().split(".").pop()!.replace(/[()[\]]/g, ""))
          .filter(Boolean);
        i = j + 1;
        continue;
      }

      // Extract `queryset = ModelName.objects.method()` and `model = ModelName`
      // class attributes so the LLM knows which model this view operates on
      // even before reading the method body.
      const qsMatch = trimmed.match(/^queryset\s*=\s*([A-Z][A-Za-z0-9_]*)\.objects\./);
      if (qsMatch?.[1] && !classModels.includes(qsMatch[1])) {
        classModels.push(qsMatch[1]);
        i++;
        continue;
      }
      const modelAttrMatch = trimmed.match(/^model\s*=\s*([A-Z][A-Za-z0-9_]*)\s*$/);
      if (modelAttrMatch?.[1] && !classModels.includes(modelAttrMatch[1])) {
        classModels.push(modelAttrMatch[1]);
        i++;
        continue;
      }

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
          const customAction = parseActionDecorator(lines, decoratorStart, i);

          // Surface standard HTTP verb methods, DRF standard actions (list/create/...),
          // and DRF custom @action methods. Non-decorated private/utility methods are skipped.
          if (!name.startsWith("_") && (httpVerb !== undefined || drfAction !== undefined || customAction !== null)) {
            const authNotes = extractDecoratorNotes(lines, decoratorStart, i);
            // For @action methods, build a route using the decorator's detail + methods
            // and append the action method name to the path (DRF default url_name behaviour).
            const effectiveDrfAction = drfAction ?? (customAction
              ? { method: customAction.method, pathSuffix: `${customAction.pathSuffix}/${name}` }
              : undefined);
            candidates.push({
              language: "python",
              filePath,
              relativePath,
              name: `${className}#${name}`,
              kind: "django-view",
              lineStart: decoratorStart + 1, // 1-indexed; includes leading decorators
              lineEnd: endIdx + 1,
              source: lines.slice(decoratorStart, endIdx + 1).join("\n"),
              hints: buildCbvHints(name, params, className, httpVerb, effectiveDrfAction, [...classMixinAuthNotes, ...authNotes], classPermissions, classModels, lines.slice(decoratorStart, endIdx + 1).join("\n")),
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
  // Lowercase both basename and full path so the gate matches the dispatcher's
  // case-insensitive extension match in parsers/index.ts (e.g., Views.PY routed
  // by the dispatcher used to drop here on strict-case checks).
  const lowered = filePath.toLowerCase();
  const basename = path.basename(lowered);
  if (basename === "views.py" || basename.endsWith("_views.py")) return true;
  return /[/\\]views[/\\].+\.py$/.test(lowered);
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
 * Scan the decorator block above a `def` for a DRF `@action(...)` decorator
 * and parse its `detail` and `methods` arguments.
 *
 * Returns `{ method, pathSuffix }` in the same shape used by `DRF_ACTIONS` so
 * `buildCbvHints` can treat custom actions identically to standard ones.
 * Returns null when no `@action` decorator is present.
 *
 * Handles both single-line and multi-line decorator forms:
 *   @action(detail=True, methods=["post"])
 *   @action(
 *       detail=False,
 *       methods=["get", "post"],
 *   )
 *
 * `url_path` overrides are intentionally ignored; the `name` used in the
 * path is the action method name (matches DRF's default behaviour).
 */
function parseActionDecorator(
  lines: string[],
  decoratorStart: number,
  defIdx: number,
): { method: string; pathSuffix: string } | null {
  const decoratorText = lines.slice(decoratorStart, defIdx).join("\n");
  if (!/\@action\s*\(/.test(decoratorText)) return null;

  // Match @action(...) including multi-line forms. The decorator block was
  // already collected by findDecoratorStart so bracket balance is guaranteed.
  const actionMatch = decoratorText.match(/@action\s*\(([\s\S]*?)\)/);
  if (!actionMatch) return null;
  const args = actionMatch[1] ?? "";

  // detail=True means the route includes the resource pk, detail=False does not.
  const detailMatch = args.match(/\bdetail\s*=\s*(True|False)/);
  const detail = detailMatch ? detailMatch[1] === "True" : false;

  // methods=['post'] or methods=["get", "post"] -- first entry is the primary verb.
  const methodsMatch = args.match(/\bmethods\s*=\s*\[([^\]]*)\]/);
  let method = "GET";
  if (methodsMatch) {
    const first = methodsMatch[1]!.split(",")[0]?.trim().replace(/['"]/g, "").toUpperCase();
    if (first) method = first;
  }

  // path suffix: detail actions nest under /:id/<name>, list actions under /<name>.
  // The action method name is appended by the caller (not here) so pathSuffix only
  // contains the optional /:id segment.
  const pathSuffix = detail ? "/:id" : "";
  return { method, pathSuffix };
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

/**
 * Scan lines[fromIdx..toIdx) for auth-relevant decorators and return a notes
 * array, e.g. `["auth: login_required"]` or `["auth: permission_required('app.perm')"]`.
 * Multi-line decorator args are not fully reconstructed; only single-line forms
 * produce a parenthesised note.
 */
function extractDecoratorNotes(
  lines: string[],
  fromIdx: number,
  toIdx: number,
): string[] {
  const notes: string[] = [];
  for (let j = fromIdx; j < toIdx; j++) {
    const trimmed = lines[j].trim();
    if (!trimmed.startsWith("@")) continue;
    const nameMatch = trimmed.match(/^@(\w+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1]!;
    if (!DJANGO_AUTH_DECORATORS.has(name)) continue;
    const argMatch = trimmed.match(/^@\w+\(([^)]*)\)/);
    if (argMatch) {
      notes.push(`auth: ${name}(${argMatch[1].trim()})`);
    } else {
      notes.push(`auth: ${name}`);
    }
  }
  // Unwrap @method_decorator(<access decorator>, name='dispatch') forms, which
  // the per-line scan above skips (the head name is method_decorator, not an
  // access decorator). Additive: no overlap with the direct-decorator notes.
  notes.push(...methodDecoratorAuthNotes(lines.slice(fromIdx, toIdx).join("\n")));
  return notes;
}

/**
 * Extract Django ORM model names from a view body by scanning for the
 * `ModelName.objects.` QuerySet accessor pattern. This is canonical Django
 * and unmistakable: only model classes use `.objects.`. Results are
 * de-duplicated and surfaced as `databaseTables` so the LLM understands
 * which models the view reads or writes without scanning the full body.
 *
 * Examples matched:
 *   Order.objects.filter(status="open")   -> "Order"
 *   User.objects.create(email=email)      -> "User"
 *   get_object_or_404(Post, pk=pk)        -> (not matched -- no .objects.)
 */
function extractOrmModels(source: string): string[] {
  const seen = new Set<string>();
  const re = /\b([A-Z][A-Za-z0-9_]*)\.objects\./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    seen.add(m[1]!);
  }
  return [...seen];
}

function extractCallees(source: string): string[] {
  // Skip `def` / `async def` signature lines so the function's own name is
  // not recorded as a callee (e.g. `def create_order(request):` would
  // otherwise produce `create_order` as a spurious entry).
  const body = source
    .split("\n")
    .filter((line) => !/^\s*(async\s+)?def\s/.test(line))
    .join("\n");
  const seen = new Set<string>();
  const callRe = /\b([a-zA-Z_][\w]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(body)) !== null) {
    const name = m[1] ?? "";
    if (name.length < 3) continue;
    if (PYTHON_KEYWORDS.has(name)) continue;
    seen.add(name);
  }
  return [...seen].slice(0, 30);
}

/**
 * Detect high-blast-radius side effects in the view source and return them as
 * plain-English notes. Email and outbound HTTP are highlighted because they
 * affect external systems and cannot be undone after the fact.
 */
function extractSideEffectNotes(source: string): string[] {
  const notes: string[] = [];
  // Django email APIs: send_mail, send_mass_mail, mail_admins, mail_managers,
  // EmailMessage, EmailMultiAlternatives (all imported from django.core.mail).
  if (/\b(send_mail|send_mass_mail|mail_admins|mail_managers|EmailMessage|EmailMultiAlternatives)\s*\(/.test(source)) {
    notes.push("Sends email (Django mail)");
  }
  // Common HTTP client libraries used in Django projects.
  if (/\brequests\.(get|post|put|patch|delete|head|options|request)\s*\(/.test(source)
    || /\bhttpx\.(get|post|put|patch|delete|head|options|request)\s*\(/.test(source)
    || /\burllib\.request\.urlopen\s*\(/.test(source)) {
    notes.push("Makes outbound HTTP request");
  }
  // Background job dispatch via Celery -- the dominant async task library in
  // Django projects. Two canonical dispatch forms:
  //   - task.delay(arg1, arg2)                   (shorthand, most common)
  //   - task.apply_async(args=[...], countdown=N) (full API, with routing)
  // Both enqueue the task on the configured broker (Redis / RabbitMQ) and
  // return immediately; the real work happens out of band in a worker process.
  // Audit-critical: the documented view is the trigger, not the executor, and
  // downstream side effects (email, DB writes, file creation) happen later.
  // Mirrors C# Hangfire (BackgroundJob.Enqueue) and Ruby ActiveJob
  // (perform_later / perform_async) background-job notes.
  // False-positive risk is low: `.delay(` and `.apply_async(` are Celery idioms
  // with no common alternative meaning in Django view code.
  if (/\.delay\s*\(/.test(source) || /\.apply_async\s*\(/.test(source)) {
    notes.push("Enqueues background job");
  }
  // Message broker publishing. Four common Python/Django broker libraries:
  //   - Pika (RabbitMQ Python client): `channel.basic_publish(exchange=..., ...)`
  //     is the one canonical publish call; it is always audit-critical.
  //   - Kombu (AMQP abstraction used by Celery): `producer.publish(message, ...)`
  //     is the direct publish API (distinct from Celery task dispatch which is
  //     captured under "Enqueues background job" above).
  //   - kafka-python: `KafkaProducer(...)` is the class instantiation; presence
  //     in a view body means a message is about to be produced.
  //   - confluent-kafka: `producer.produce(...)` is the low-level produce call.
  // Mirrors Java JMS/AMQP/Kafka and C# MassTransit/Azure Service Bus notes.
  if (
    /\bchannel\.basic_publish\s*\(/.test(source)
    || /\bproducer\.publish\s*\(/.test(source)
    || /\bKafkaProducer\s*\(/.test(source)
    || /\bproducer\.produce\s*\(/.test(source)
  ) {
    notes.push("Sends message to broker (Kombu / Pika)");
  }
  // Stored procedure calls via Python DB-API 2.0. `cursor.callproc(name,
  // args)` is the canonical stored-proc API in every Django project that
  // drops to raw SQL: `with connection.cursor() as c: c.callproc(...)`.
  // The method name is proc-specific (no callproc for plain SQL), so it
  // is always audit-critical: the proc may have triggers, cross-table
  // writes, and logic invisible in the calling view. Mirrors C#
  // CommandType.StoredProcedure, Java prepareCall / createStoredProcedureQuery
  // / SimpleJdbcCall, and CFML <cfstoredproc> detection.
  if (/\.callproc\s*\(/.test(source)) {
    notes.push("Calls stored procedure");
  }
  // External process execution. Python has two canonical idioms for
  // spawning a child process; both run with the server's privileges and
  // are audit-critical (common in PDF rendering, image conversion, legacy
  // CLI tool integration). Read-only helpers (subprocess.list2cmdline)
  // are intentionally NOT flagged.
  //   - subprocess module: run, Popen, call, check_call, check_output,
  //     getoutput, getstatusoutput
  //   - os module: system, popen, exec* family (execl/execv/execlp/...),
  //     spawn* family (spawnl/spawnv/spawnlp/...)
  // Mirrors Java's Runtime.exec / ProcessBuilder, C#'s Process.Start, and
  // Ruby's system / backtick / Open3 process-execution notes.
  if (
    /\bsubprocess\.(?:run|Popen|call|check_call|check_output|getoutput|getstatusoutput)\s*\(/.test(source)
    || /\bos\.(?:system|popen|exec[a-z]*|spawn[a-z]*)\s*\(/.test(source)
  ) {
    notes.push("Executes external process");
  }
  // Cache mutation. Django apps share state via django.core.cache. The
  // singular `cache` (default cache) and `caches['name']` (named cache)
  // forms both expose the same mutation API. Read-only operations
  // (cache.get, cache.get_many, cache.has_key, cache.get_or_set) are
  // intentionally NOT flagged: no blast radius beyond a possible cache
  // miss. .clear() is extremely high-blast-radius (wipes the entire
  // cache) and .delete_pattern() is pattern-based (high blast radius);
  // both produce the note like every other mutation.
  // Mirrors Java @CacheEvict/@CachePut, C# IMemoryCache mutations, and
  // Rails.cache.write/.delete signal.
  const cacheMutationMethods = "(?:set|set_many|add|delete|delete_many|delete_pattern|clear|incr|decr|touch)";
  if (
    new RegExp(`\\bcache\\.${cacheMutationMethods}\\s*\\(`).test(source)
    || new RegExp(`\\bcaches\\[[^\\]]+\\]\\.${cacheMutationMethods}\\s*\\(`).test(source)
  ) {
    notes.push("Mutates application cache");
  }
  // Database transactions. Django uses two equivalent forms, both covered
  // by a single \btransaction\.atomic\b pattern:
  //   - Context manager: `with transaction.atomic(): ...`
  //   - Decorator:       `@transaction.atomic` (with or without parens)
  // Matches CFML <cftransaction>, Java @Transactional, C# TransactionScope,
  // and Rails Model.transaction side-effect notes.
  if (/\btransaction\.atomic\b/.test(source)) {
    notes.push("Executes within a database transaction");
  }
  // Filesystem mutations. Writing, deleting, moving, or creating files
  // affects shared disk state and is audit-relevant. Reads (open(path) without
  // mode arg, open(path, "r"), Path.read_text, os.stat, os.listdir) are
  // intentionally NOT flagged: no blast radius. Detects five families:
  //   - Built-in open() with write/append/exclusive mode (w / a / x / w+ / a+
  //     / wb / ab, optionally with + or b suffix). The first argument may be a
  //     computed path with one level of call nesting (the dominant upload idiom
  //     open(os.path.join(MEDIA_ROOT, name), "w") / open(get_path(), "w")).
  //   - os module mutators: remove, unlink, rename, rmdir, makedirs, mkdir,
  //     replace, symlink, link, chmod, chown
  //   - shutil mutators: copy, copyfile, copytree, copy2, copymode, move, rmtree
  //   - pathlib write methods: .write_text(, .write_bytes(
  //   - Django storage backend: default_storage.save / .delete
  if (
    /\bopen\s*\((?:[^()]|\([^()]*\))*,\s*["'][wax][b+]*["']/.test(source)
    || /\bos\.(?:remove|unlink|rename|rmdir|makedirs|mkdir|replace|symlink|link|chmod|chown)\s*\(/.test(source)
    || /\bshutil\.(?:copy|copyfile|copytree|copy2|copymode|move|rmtree)\s*\(/.test(source)
    || /\.write_text\s*\(/.test(source)
    || /\.write_bytes\s*\(/.test(source)
    || /\bdefault_storage\.(?:save|delete)\s*\(/.test(source)
  ) {
    notes.push("Writes to file system");
  }
  return notes;
}

function buildFbvHints(
  params: string,
  authNotes: string[] = [],
  source = "",
): CandidateHints {
  const hints: CandidateHints = {};
  const parsed = parseParams(params);
  if (parsed.length > 0) hints.parameters = parsed;
  const sideEffects = extractSideEffectNotes(source);
  const allNotes = [...authNotes, ...sideEffects];
  if (allNotes.length > 0) hints.notes = allNotes;
  const models = extractOrmModels(source);
  if (models.length > 0) hints.databaseTables = models;
  const callees = extractCallees(source);
  if (callees.length > 0) hints.callees = callees;
  return hints;
}

function buildCbvHints(
  _methodName: string,
  params: string,
  className: string,
  httpVerb: string | undefined,
  drfAction: { method: string; pathSuffix: string } | undefined,
  authNotes: string[] = [],
  classPermissions: string[] = [],
  classModels: string[] = [],
  source = "",
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

  // Merge method-level decorator notes, class-level permission_classes, and
  // side-effect notes (email, HTTP) all into hints.notes.
  const allNotes = [...authNotes];
  if (classPermissions.length > 0) {
    allNotes.push(`permission_classes: ${classPermissions.join(", ")}`);
  }
  allNotes.push(...extractSideEffectNotes(source));
  if (allNotes.length > 0) hints.notes = allNotes;

  // Merge class-level queryset/model attrs with method-body ORM calls.
  const methodModels = extractOrmModels(source);
  const allModels = [...new Set([...classModels, ...methodModels])];
  if (allModels.length > 0) hints.databaseTables = allModels;

  const callees = extractCallees(source);
  if (callees.length > 0) hints.callees = callees;

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
 * Split a Python parameter list into structured `{ name, type? }` entries.
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
 * When a PEP 3107 annotation is present (`name: Type` or `name: Type = default`),
 * the type is extracted and returned in the `type` field. The default-value
 * separator `=` is found depth-aware so generic defaults like
 * `items: List[str] = []` correctly yield `type = "List[str]"` rather than
 * truncating at the `]` character.
 *
 * Examples:
 *   `def my_view(request, *, format="json")`             -> [{name:"request"}, {name:"format"}]
 *   `def my_view(request, pk, /, slug, *, format)`       -> [{name:"request"},{name:"pk"},...]
 *   `def my_view(*args, **kwargs)`                       -> [{name:"args"}, {name:"kwargs"}]
 *   `def my_view(request, filters: Dict[str, int])`      -> [{name:"request"}, {name:"filters",type:"Dict[str, int]"}]
 *   `def my_view(request, pk: int = None)`               -> [{name:"request"}, {name:"pk",type:"int"}]
 */
function parseParams(params: string): Array<{ name: string; type?: string }> {
  return splitParamsTopLevel(params)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => p !== "*" && p !== "/")
    .map((p) => {
      const stripped = p.replace(/^[*]+/, "");

      // Find the first `:` and first `=` at bracket depth 0 in one pass.
      // A `:` inside `{"a": 1}` or `Literal["x:y"]` is at depth > 0 and is
      // NOT a type annotation separator. An `=` before any depth-0 `:` means
      // this is a plain `name = default` param with no annotation.
      let depth = 0;
      let firstColon = -1;
      let firstEq = -1;
      for (let i = 0; i < stripped.length; i++) {
        const ch = stripped[i];
        if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
        if (ch === ")" || ch === "]" || ch === "}") { depth--; continue; }
        if (depth !== 0) continue;
        if (ch === ":" && firstColon < 0) firstColon = i;
        if (ch === "=" && firstEq < 0) { firstEq = i; break; }
      }

      const hasAnnotation = firstColon >= 0 && (firstEq < 0 || firstColon < firstEq);
      if (!hasAnnotation) {
        const name = (firstEq >= 0 ? stripped.slice(0, firstEq) : stripped).trim();
        return { name };
      }

      const name = stripped.slice(0, firstColon).trim();
      // Extract type from `afterColon`, finding the `=` default separator at depth 0.
      const afterColon = stripped.slice(firstColon + 1).trim();
      let d2 = 0;
      let eqInType = -1;
      for (let i = 0; i < afterColon.length; i++) {
        const ch = afterColon[i];
        if (ch === "(" || ch === "[" || ch === "{") { d2++; continue; }
        if (ch === ")" || ch === "]" || ch === "}") { d2--; continue; }
        if (ch === "=" && d2 === 0) { eqInType = i; break; }
      }
      const type = (eqInType >= 0 ? afterColon.slice(0, eqInType).trim() : afterColon) || undefined;
      return { name, type };
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
