import Parser from "tree-sitter";
import Java from "tree-sitter-java";
import type {
  Candidate,
  CandidateHints,
  JavaSurfaceMode,
} from "../types.js";

export interface ParseJavaOptions {
  /** See JavaSurfaceMode in core/types.ts. Default 'annotated' preserves
   *  the framework-annotation-driven gate this parser shipped with. */
  surfaceMode?: JavaSurfaceMode;
  /** When true, JMH benchmark classes (@BenchmarkMode / @State / @Benchmark)
   *  are surfaced instead of skipped. Default false. */
  includeJmhBenchmarks?: boolean;
}

/** Package-segment allowlist for 'package-allowlist' surface mode. A
 *  class is eligible when its package, split on `.`, contains any of
 *  these as a segment (e.g. `com.example.service.foo` matches via
 *  `service`). Lowercase; the check is case-sensitive because Java
 *  package conventions are always lowercase. */
const PACKAGE_ALLOWLIST_SEGMENTS = new Set([
  "service",
  "business",
  "manager",
  "dao",
  "api",
]);

/** Minimum public-non-trivial-method count for 'all-public-classes'
 *  mode. Three is the Option A heuristic from the design discussion:
 *  catches utility / business classes that carry several genuine
 *  operations while rejecting DTOs / one-method config holders. */
const ALL_PUBLIC_METHOD_THRESHOLD = 3;

const SPRING_HTTP_ANNOTATIONS = new Set([
  "GetMapping",
  "PostMapping",
  "PutMapping",
  "DeleteMapping",
  "PatchMapping",
  "RequestMapping",
]);

const CONTROLLER_ANNOTATIONS = new Set(["Controller", "RestController"]);

const SERVICE_ANNOTATIONS = new Set(["Service", "Component", "Repository"]);

// Java EE 6/8 -----------------------------------------------------------

// JAX-RS: @Path on a class marks it as a resource (like @Controller).
const JAXRS_RESOURCE_ANNOTATIONS = new Set(["Path"]);

// JAX-RS HTTP verb annotations on methods.
const JAXRS_HTTP_ANNOTATIONS = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
]);

// EJB session/message beans are service-like entry points.
const EJB_ANNOTATIONS = new Set([
  "Stateless",
  "Stateful",
  "Singleton",
  "MessageDriven",
]);

// CDI managed beans: scope annotations imply a bean that owns business logic.
const CDI_ANNOTATIONS = new Set([
  "Named",
  "ApplicationScoped",
  "RequestScoped",
  "SessionScoped",
  "Dependent",
]);

// @WebServlet / @WebFilter: the class IS the HTTP handler.
const SERVLET_ANNOTATIONS = new Set(["WebServlet", "WebFilter"]);

// JMH micro-benchmarks. Any class carrying one of these is a
// performance-measurement stub (annotated body sketches `return "id"`
// / `return "asset_by_id"` constants) and never represents business
// logic worth a use-case page. The 2026-05-16 dropwizard run produced
// 3 low-confidence pages from this exact pattern, motivating the skip.
// Path-glob exclusion (**/*benchmark*/**) catches dropwizard-benchmarks/
// but misses in-tree JMH harnesses that live next to production code
// (a common pattern in libraries: src/main/java/foo/Foo.java +
// src/main/java/foo/FooBenchmark.java); this annotation gate is the
// content-level backstop.
//
// Controlled by ParseJavaOptions.includeJmhBenchmarks (default false).
// Caliper / other benchmark frameworks are out of scope; only JMH
// annotations are covered.
const BENCHMARK_ANNOTATIONS = new Set([
  "BenchmarkMode",
  "State",
  "Benchmark",
]);

// Servlet method names carry an implied HTTP verb.
const SERVLET_METHOD_ROUTES: Record<string, string> = {
  doGet: "GET",
  doPost: "POST",
  doPut: "PUT",
  doDelete: "DELETE",
  doPatch: "PATCH",
  doHead: "HEAD",
  doOptions: "OPTIONS",
  service: "ANY",
  doFilter: "ANY",
};

/**
 * Parse a Java source file and emit Candidate use-case regions.
 * Handles Spring MVC, JAX-RS (Java EE 6/8), EJB beans, CDI managed beans,
 * and Servlet / Filter classes.
 */
export function parseJava(
  filePath: string,
  relativePath: string,
  source: string,
  options: ParseJavaOptions = {},
): Candidate[] {
  const surfaceMode: JavaSurfaceMode = options.surfaceMode ?? "annotated";
  const includeJmhBenchmarks = options.includeJmhBenchmarks ?? false;
  const parser = new Parser();
  parser.setLanguage(Java);
  // tree-sitter-node's `parse(string)` overload throws "Invalid argument"
  // on files larger than its internal buffer (~32 KB). Real legacy
  // codebases routinely have larger files: 2026-05-16 jspwiki run hit
  // 6 skipped files (WikiEngine.java=39 KB, SpamFilter.java=47 KB,
  // SecurityVerifier.java=35 KB, etc.). The callback overload pages
  // through the source in 4 KB chunks and has no upper limit, same
  // parse output, no buffer-overflow risk.
  const tree = parser.parse((index: number) => {
    if (index >= source.length) return "";
    return source.slice(index, Math.min(source.length, index + 4096));
  });

  const candidates: Candidate[] = [];
  const classes = collectByType(tree.rootNode, "class_declaration");
  const packageName = extractPackageName(tree.rootNode);

  for (const cls of classes) {
    const className =
      cls.childForFieldName("name")?.text ?? "UnknownClass";
    const classAnnotations = collectAnnotationsOn(cls);
    const classModifiers = collectKeywordModifiers(cls);

    // JMH benchmark skip: applies BEFORE the surfaceMode gate so it
    // takes effect across every mode (a customer running
    // all-public-classes against a repo with in-tree JMH stubs gets
    // the same protection as the default 'annotated' mode).
    const isJmhClass = hasAny(classAnnotations, BENCHMARK_ANNOTATIONS);
    if (!includeJmhBenchmarks && isJmhClass) continue;

    const isController =
      hasAny(classAnnotations, CONTROLLER_ANNOTATIONS) ||
      hasAny(classAnnotations, JAXRS_RESOURCE_ANNOTATIONS);
    const isService =
      hasAny(classAnnotations, SERVICE_ANNOTATIONS) ||
      hasAny(classAnnotations, EJB_ANNOTATIONS) ||
      hasAny(classAnnotations, CDI_ANNOTATIONS);
    const isServlet = hasAny(classAnnotations, SERVLET_ANNOTATIONS);

    // Class-level eligibility gate driven by surfaceMode. The
    // 'annotated' branch falls through to the existing per-method
    // selection logic so v1 behavior is byte-identical when the config
    // default is in effect. Non-annotated branches resolve eligibility
    // up-front so we either visit every public non-trivial method on
    // the class or skip the class entirely.
    //
    // Exception: an opted-in JMH class (isJmhClass && includeJmhBenchmarks)
    // bypasses the framework gate even in 'annotated' mode. Pure JMH classes
    // carry no framework annotations, so the framework gate would produce 0
    // candidates; even mixed classes (JMH + @Path etc.) are opted in fully
    // so all public non-trivial methods surface, not just route-mapped ones.
    let useFrameworkGate = false;
    if (surfaceMode === "annotated") {
      useFrameworkGate = !isJmhClass;
    } else if (surfaceMode === "all-public-classes") {
      if (!isAllPublicEligible(cls, className, classModifiers)) continue;
    } else if (surfaceMode === "package-allowlist") {
      if (!isPackageEligible(packageName)) continue;
    }

    const methods = collectByType(cls, "method_declaration");
    for (const method of methods) {
      const methodName =
        method.childForFieldName("name")?.text ?? "unknownMethod";
      const methodAnnotations = collectAnnotationsOn(method);
      const methodModifiers = collectKeywordModifiers(method);
      const route = extractHttpRoute(methodAnnotations, methodName, isServlet);

      const isTrivial = looksLikeGetterSetter(methodName, method);

      if (useFrameworkGate) {
        // Original selection heuristic: include if controller, has
        // route, or is a method on a service class and is not a
        // trivial accessor.
        if (!route && !isController && !isService && !isServlet) continue;
        if (!route && isTrivial) continue;
        // Servlet classes: only expose methods that map to HTTP verbs.
        if (isServlet && !route) continue;
      } else {
        // Non-annotated modes: the class is already eligible; surface
        // public non-trivial methods (skip private/package-private
        // helpers and trivial getters/setters).
        if (!methodModifiers.includes("public")) continue;
        if (isTrivial) continue;
      }

      const lineStart = method.startPosition.row + 1;
      const lineEnd = method.endPosition.row + 1;
      const methodSource = source.slice(
        method.startIndex,
        method.endIndex,
      );

      const hints: CandidateHints = {
        annotations: [...classAnnotations, ...methodAnnotations],
        parameters: extractParameters(method),
        httpRoute: route ?? undefined,
        callees: extractCallees(method),
      };

      candidates.push({
        language: "java",
        filePath,
        relativePath,
        name: `${className}.${methodName}`,
        kind: route ? "controller-method" : "function",
        lineStart,
        lineEnd,
        source: methodSource,
        hints,
      });
    }
  }

  return candidates;
}

// --- helpers ------------------------------------------------------------

type SyntaxNode = Parser.SyntaxNode;

function collectByType(node: SyntaxNode, type: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const walk = (n: SyntaxNode) => {
    if (n.type === type) out.push(n);
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) walk(child);
    }
  };
  walk(node);
  return out;
}

function collectAnnotationsOn(node: SyntaxNode): string[] {
  // Annotations sit as siblings before the declaration name; tree-sitter
  // exposes them as direct children of type "modifiers" containing
  // "marker_annotation" or "annotation" nodes.
  // Annotation names may be qualified (e.g. `org.springframework.stereotype.Service`);
  // we normalize to the last segment so downstream matching is uniform.
  const annotations: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "modifiers") {
      for (let j = 0; j < child.namedChildCount; j++) {
        const m = child.namedChild(j);
        if (!m) continue;
        if (m.type === "marker_annotation" || m.type === "annotation") {
          const nameNode = m.childForFieldName("name");
          if (nameNode) {
            const fullName = nameNode.text;
            const simpleName = fullName.split(".").pop() ?? fullName;
            annotations.push(simpleName);
          }
        }
      }
    }
  }
  return annotations;
}

function hasAny(list: string[], set: Set<string>): boolean {
  return list.some((a) => set.has(a));
}

function extractHttpRoute(
  methodAnnotations: string[],
  methodName: string,
  isServlet: boolean,
): { method: string; path: string } | null {
  // Spring MVC
  for (const a of methodAnnotations) {
    if (SPRING_HTTP_ANNOTATIONS.has(a)) {
      const method = a.replace("Mapping", "").toUpperCase();
      return { method: method === "REQUEST" ? "ANY" : method, path: "" };
    }
  }
  // JAX-RS verb annotations (@GET, @POST, ...)
  for (const a of methodAnnotations) {
    if (JAXRS_HTTP_ANNOTATIONS.has(a)) {
      return { method: a, path: "" };
    }
  }
  // Servlet: method name encodes the HTTP verb by convention.
  if (isServlet) {
    const impliedMethod = SERVLET_METHOD_ROUTES[methodName];
    if (impliedMethod) return { method: impliedMethod, path: "" };
  }
  return null;
}

function extractParameters(
  method: SyntaxNode,
): Array<{ name: string; type?: string }> {
  const result: Array<{ name: string; type?: string }> = [];
  const params = method.childForFieldName("parameters");
  if (!params) return result;
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (!p) continue;
    if (p.type === "formal_parameter" || p.type === "spread_parameter") {
      const typeNode = p.childForFieldName("type");
      const nameNode = p.childForFieldName("name");
      result.push({
        name: nameNode?.text ?? "?",
        type: typeNode?.text,
      });
    }
  }
  return result;
}

function extractCallees(method: SyntaxNode): string[] {
  const callees = new Set<string>();
  const walk = (n: SyntaxNode) => {
    if (n.type === "method_invocation") {
      const nameNode = n.childForFieldName("name");
      if (nameNode) callees.add(nameNode.text);
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) walk(child);
    }
  };
  walk(method);
  return [...callees].slice(0, 30);
}

/** Collect keyword modifiers (public, private, static, abstract, ...)
 *  from a class or method's `modifiers` child, excluding annotations.
 *  Iterates ALL children (named + unnamed) because tree-sitter-java
 *  exposes the keyword tokens as anonymous nodes inside the modifiers
 *  block. */
function collectKeywordModifiers(node: SyntaxNode): string[] {
  const out: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type !== "modifiers") continue;
    for (let j = 0; j < child.childCount; j++) {
      const m = child.child(j);
      if (!m) continue;
      if (m.type === "marker_annotation" || m.type === "annotation") continue;
      out.push(m.text);
    }
  }
  return out;
}

/** Extract the package name from a Java file's top-level
 *  `package_declaration`, or null if no package is declared (default
 *  package, which never matches the allowlist). */
function extractPackageName(root: SyntaxNode): string | null {
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child?.type !== "package_declaration") continue;
    const m = child.text.match(/^package\s+([\w.]+)\s*;/);
    return m ? m[1] : null;
  }
  return null;
}

/** True when the package, split on `.`, has any segment in the
 *  PACKAGE_ALLOWLIST_SEGMENTS set. Captures the convention `*.service.*`,
 *  `*.business.*`, `*.manager.*`, `*.dao.*`, `*.api.*` from the surface
 *  spec without dragging in a glob library. */
function isPackageEligible(pkg: string | null): boolean {
  if (!pkg) return false;
  return pkg.split(".").some((s) => PACKAGE_ALLOWLIST_SEGMENTS.has(s));
}

/** True when the class qualifies under 'all-public-classes' mode:
 *  non-abstract, non-test (by name convention), >= 3 public non-trivial
 *  methods, AND has a class-level Javadoc block (non-empty /** ... *\/).
 *  The Javadoc requirement keeps the surface narrow enough that we
 *  don't drown in framework-stub utility classes that happen to expose
 *  three setters. */
function isAllPublicEligible(
  cls: SyntaxNode,
  className: string,
  classModifiers: string[],
): boolean {
  if (classModifiers.includes("abstract")) return false;
  // Common JUnit naming patterns: FooTest, FooTests, FooIT (integration
  // test). Also TestFoo (less common but seen in legacy codebases).
  if (
    /Test$|Tests$|IT$/.test(className) ||
    className.startsWith("Test")
  ) {
    return false;
  }
  const methods = collectByType(cls, "method_declaration");
  let publicNonTrivial = 0;
  for (const m of methods) {
    const name = m.childForFieldName("name")?.text ?? "";
    if (!collectKeywordModifiers(m).includes("public")) continue;
    if (looksLikeGetterSetter(name, m)) continue;
    publicNonTrivial++;
  }
  if (publicNonTrivial < ALL_PUBLIC_METHOD_THRESHOLD) return false;
  if (!hasClassJavadoc(cls)) return false;
  return true;
}

/** True when the class declaration is immediately preceded by a
 *  Javadoc-style block comment (`/ ** ... * /`) that contains
 *  non-whitespace content beyond the comment delimiters and asterisk
 *  rails. Tree-sitter-java attaches block comments as siblings (NOT
 *  children) of the class declaration, so we walk `previousSibling`
 *  rather than reaching into the class's own subtree. */
function hasClassJavadoc(cls: SyntaxNode): boolean {
  // previousNamedSibling skips whitespace tokens, which is what we
  // want, the Javadoc is the immediately-preceding non-whitespace node.
  const prev = cls.previousNamedSibling;
  if (!prev) return false;
  if (prev.type !== "block_comment") return false;
  const text = prev.text;
  if (!text.startsWith("/**")) return false;
  // Strip /** and trailing */, then drop asterisk rails ("* ", "  *",
  // bare lines of asterisks) and check that any prose remains.
  const inner = text
    .slice(3, -2)
    .split("\n")
    .map((line) => line.replace(/^\s*\*+\s?/, "").trim())
    .join("")
    .trim();
  return inner.length > 0;
}

function looksLikeGetterSetter(name: string, method: SyntaxNode): boolean {
  if (!/^(get|set|is|has)[A-Z]/.test(name)) return false;
  // A getter/setter typically has 0-1 statements in its body.
  const body = method.childForFieldName("body");
  if (!body) return true;
  const stmts = collectByType(body, "expression_statement");
  const returns = collectByType(body, "return_statement");
  return stmts.length + returns.length <= 1;
}
