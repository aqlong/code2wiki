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

// Annotations that carry a class-level route prefix (Spring @RequestMapping
// and JAX-RS @Path). Looked up once per class to prepend to method paths.
const CLASS_PATH_ANNOTATIONS = new Set(["RequestMapping", "Path"]);

// Spring Security + JEE security annotations that restrict access.
// Surfaced as a dedicated `notes: ["auth: ..."]` hint so the LLM gets an
// unambiguous signal about authorization requirements without having to
// parse the full annotations list. Mirrors the C# parser's Authorize handling.
const JAVA_AUTH_ANNOTATIONS = new Set([
  "Secured",
  "PreAuthorize",
  "PostAuthorize",
  "RolesAllowed",
  "PermitAll",
  "DenyAll",
  "PreFilter",
  "PostFilter",
]);

// Transaction-marking annotations. Spring's @Transactional and Java EE's
// @Transactional / @TransactionAttribute all signal that the method (or every
// method in the class, when class-level) runs inside a database transaction.
// Promoted to a side-effect note so compliance / audit readers see the
// "runs in a transaction" business rule the same way they see "Sends email"
// or "Calls stored procedure(s)". CFML's <cftransaction> already produces an
// equivalent note; this brings Java to parity.
const JAVA_TRANSACTION_ANNOTATIONS = new Set([
  "Transactional",
  "TransactionAttribute",
]);

// Cache-mutating annotations. Spring's @CacheEvict invalidates one or all
// cached entries; @CachePut writes a value to the cache unconditionally. Both
// affect shared application state outside the immediate request, so the LLM
// needs to surface them as business rules. @Cacheable READS from cache but
// only writes on miss, so it's intentionally NOT in this set -- low enough
// blast radius that flagging it would just be noise.
const JAVA_CACHE_MUTATION_ANNOTATIONS = new Set([
  "CacheEvict",
  "CachePut",
]);

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

// JVM / functional-API method names that are noise in the callees hint.
// These are uniquely Stream / Optional / Object / SLF4J methods that almost
// never appear as business-coded method names with the same exact spelling.
// Generic names (add, get, put, set, find, map, filter, forEach, count, size,
// isEmpty) are NOT included because they collide with business calls.
const JAVA_STDLIB_METHODS = new Set([
  // java.lang.Object
  "equals", "hashCode", "toString", "getClass",
  // Stream pipeline (excludes filter/map/forEach/count to avoid business collision)
  "stream", "parallelStream", "flatMap", "reduce", "collect",
  "sorted", "distinct", "peek", "limit", "skip",
  "findFirst", "findAny", "anyMatch", "allMatch", "noneMatch",
  "toList", "toArray", "toSet", "toMap",
  // Optional pipeline (excludes get/of to avoid business collision)
  "ofNullable", "isPresent", "orElse", "orElseGet", "orElseThrow",
  "ifPresent", "ifPresentOrElse",
  // SLF4J logger methods (debug/info/warn/error/trace as bare method names are
  // virtually always logger calls; business "info" is typically getInfo / userInfo)
  "debug", "info", "warn", "error", "trace",
  "isDebugEnabled", "isInfoEnabled", "isWarnEnabled", "isErrorEnabled", "isTraceEnabled",
]);

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

    // Class-level path prefix: Spring @RequestMapping("/base") and JAX-RS
    // @Path("/base") on the class establish a prefix that applies to every
    // method route. Extracted once per class and prepended below.
    const classPathPrefix =
      extractAnnotationPath(cls, CLASS_PATH_ANNOTATIONS) ?? "";

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
      // Spring's DispatcherServlet dispatches via an instance activator;
      // static methods cannot be HTTP endpoints regardless of annotations.
      if (methodModifiers.includes("static")) continue;
      const route = extractHttpRoute(methodAnnotations, methodName, isServlet, method);
      if (route && classPathPrefix) {
        route.path = joinPaths(classPathPrefix, route.path);
      }

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

      const allAnnotations = [...classAnnotations, ...methodAnnotations];
      const authHits = allAnnotations.filter((a) => JAVA_AUTH_ANNOTATIONS.has(a));
      const notes: string[] = authHits.length > 0
        ? [`auth: ${authHits.join(", ")}`]
        : [];

      const models = extractJpaModels(methodSource);

      // Side-effect notes: surface high-blast-radius operations so the LLM
      // can document them as explicit business rules. Match both PascalCase
      // type names (e.g. `JavaMailSender`) and camelCase field names (e.g.
      // `mailSender`) since DI hides the type in the constructor / field
      // declaration and the method body only references the field.
      // Email: JavaMailSender, MimeMessage(Helper), SimpleMailMessage (type names)
      // + common camelCase DI field names. Spring Boot auto-configures a
      // JavaMailSenderImpl bean that is typically injected as one of three
      // field names: `mailSender` (Spring docs default), `javaMailSender`
      // (matches the bean name), or `emailSender` (developer preference,
      // equally common in Spring Boot tutorials and real-world code).
      if (/\b(?:JavaMailSender|SimpleMailMessage|MimeMessage|MimeMessageHelper|mailSender|javaMailSender|emailSender)\b/.test(methodSource)) {
        notes.push("Sends email");
      }
      // HTTP: Spring (RestTemplate, WebClient, FeignClient), Java 11 HttpClient,
      // OkHttp (OkHttpClient), Apache HttpClient (CloseableHttpClient, HttpClientBuilder),
      // or common camelCase field variants of each.
      if (/\b(?:RestTemplate|WebClient|FeignClient|HttpClient|OkHttpClient|CloseableHttpClient|HttpClientBuilder|restTemplate|webClient|httpClient|feignClient|okHttpClient|closeableHttpClient)\b/.test(methodSource)) {
        notes.push("Makes outbound HTTP request");
      }
      // Spring events: ApplicationEventPublisher.publishEvent
      if (/\.publishEvent\s*\(/.test(methodSource)
        || /\bApplicationEventPublisher\b/.test(methodSource)
        || /\bapplicationEventPublisher\b/.test(methodSource)) {
        notes.push("Publishes Spring application event");
      }
      // Background jobs. Three Spring / Java patterns all fire-and-forget:
      //   - @Async on the method itself: the caller returns immediately while
      //     Spring runs this method in a configured ThreadPoolTaskExecutor.
      //   - taskExecutor.execute(...) / taskExecutor.submit(...): explicit
      //     submission to a named Spring TaskExecutor bean (camelCase field
      //     name or PascalCase type). Covers both Runnable and Callable forms.
      //   - CompletableFuture.runAsync(...) / supplyAsync(...): Java 8+ async
      //     execution in the common-pool or a custom Executor. Often used in
      //     Spring Boot alongside @Async for non-Spring-managed dispatch.
      // Audit-critical: downstream effects (DB writes, email, file creation)
      // happen in a worker thread, out of band with the current request.
      // Mirrors C# Hangfire (BackgroundJob.Enqueue), Ruby ActiveJob
      // (perform_later / perform_async), and Django Celery (.delay / .apply_async).
      if (
        allAnnotations.includes("Async")
        || /\b(?:taskExecutor|threadPoolTaskExecutor|asyncTaskExecutor|TaskExecutor)\b.*\.(?:execute|submit)\s*\(/.test(methodSource)
        || /\bCompletableFuture\.(?:runAsync|supplyAsync)\s*\(/.test(methodSource)
      ) {
        notes.push("Enqueues background job");
      }
      // Messaging: JmsTemplate (JMS), RabbitTemplate (AMQP), KafkaTemplate
      if (/\b(?:JmsTemplate|RabbitTemplate|KafkaTemplate|jmsTemplate|rabbitTemplate|kafkaTemplate|kafka)\b/.test(methodSource)) {
        notes.push("Sends message to broker (JMS, AMQP, or Kafka)");
      }
      // Database transactions. @Transactional (Spring or Java EE) and
      // @TransactionAttribute (EJB) mark a method (or all methods of an
      // annotated class) as transactional. Critical for auditors: all
      // database operations inside the method succeed or fail together.
      if (allAnnotations.some((a) => JAVA_TRANSACTION_ANNOTATIONS.has(a))) {
        notes.push("Executes within a database transaction (@Transactional)");
      }
      // Programmatic transactions. When declarative @Transactional can't be used
      // (e.g., same-bean method calls bypass Spring AOP), developers use the
      // programmatic API instead. Two Spring forms:
      //   - TransactionTemplate.execute(status -> { ... }) -- high-level wrapper,
      //     the common choice: creates, commits, and rolls back automatically.
      //     DI typically injects it as a field named `transactionTemplate`
      //     (camelCase), so we match both the PascalCase type and the camelCase
      //     field name.
      //   - PlatformTransactionManager -- low-level, used in framework code and
      //     legacy Spring MVC apps. Appears in method scope as a type annotation
      //     on a local variable or parameter.
      // Both carry the same audit weight as @Transactional: the enclosed DB ops
      // are all-or-nothing even though no annotation is visible on the method.
      if (
        /\b(?:TransactionTemplate|transactionTemplate)\b/.test(methodSource)
        || /\bPlatformTransactionManager\b/.test(methodSource)
      ) {
        notes.push("Executes within a database transaction (TransactionTemplate)");
      }
      // Stored procedure calls. Three canonical Java entry points, all
      // dispatch to a stored proc in the DB. Stored procs may have side
      // effects invisible in the Java code (triggers, cross-table writes,
      // audit logging in the DB layer), so compliance readers need them
      // surfaced as business rules. Mirrors CFML's <cfstoredproc> and C#'s
      // CommandType.StoredProcedure notes.
      //   - JPA:    em.createStoredProcedureQuery("sp_name")
      //   - JDBC:   conn.prepareCall("{ call sp_name(?) }")
      //   - Spring: new SimpleJdbcCall(...).withProcedureName(...)
      // The dedicated method names (`createStoredProcedureQuery`, `prepareCall`)
      // and the Spring class name (`SimpleJdbcCall`) are all stored-proc-only
      // signals in idiomatic JDBC / JPA / Spring code.
      if (
        /\.createStoredProcedureQuery\s*\(/.test(methodSource)
        || /\.prepareCall\s*\(/.test(methodSource)
        || /\bSimpleJdbcCall\b/.test(methodSource)
      ) {
        notes.push("Calls stored procedure");
      }
      // Cache mutation. @CacheEvict invalidates cached data; @CachePut writes
      // unconditionally. Both affect shared application state and can cause
      // downstream staleness / extra DB load, so auditors and ops need them
      // surfaced as business rules.
      if (allAnnotations.some((a) => JAVA_CACHE_MUTATION_ANNOTATIONS.has(a))) {
        notes.push("Mutates application cache (@CacheEvict / @CachePut)");
      }
      // External process execution. Runtime.getRuntime().exec(...) and
      // ProcessBuilder are the two canonical ways to spawn an OS process
      // from Java. Audit-critical because the spawned process runs with the
      // server's privileges; common in PDF generation, image manipulation,
      // file conversion, and legacy system integration. Read-only patterns
      // like ProcessHandle.current() (process introspection without spawning)
      // are intentionally NOT flagged.
      if (
        /\bRuntime\.getRuntime\s*\(\s*\)\s*\.exec\s*\(/.test(methodSource)
        || /\bProcessBuilder\b/.test(methodSource)
      ) {
        notes.push("Executes external process");
      }
      // Filesystem mutations. Writing, deleting, moving, or uploading files
      // affects shared disk state and is audit-relevant (uploaded files may
      // be malicious, deleted files cannot be recovered). Reads (Files.read*,
      // FileReader, FileInputStream) are intentionally NOT flagged: no blast
      // radius. Detects three families:
      //   - java.nio.Files mutators (write/delete/move/copy/createDirectories/etc.)
      //   - java.io writer / output-stream types (FileWriter, FileOutputStream,
      //     PrintWriter, BufferedWriter, OutputStreamWriter)
      //   - Spring multipart upload (MultipartFile or any .transferTo( call)
      if (
        /\bFiles\.(?:write|delete|deleteIfExists|move|copy|createDirectories|createDirectory|createFile|createTempFile|createTempDirectory)\s*\(/.test(methodSource)
        || /\b(?:FileWriter|FileOutputStream|BufferedWriter|PrintWriter|OutputStreamWriter)\b/.test(methodSource)
        || /\bMultipartFile\b/.test(methodSource)
        || /\.transferTo\s*\(/.test(methodSource)
      ) {
        notes.push("Writes to file system");
      }

      const hints: CandidateHints = {
        annotations: allAnnotations,
        parameters: extractParameters(method),
        httpRoute: route ?? undefined,
        callees: extractCallees(method),
        databaseTables: models.length > 0 ? models : undefined,
        notes: notes.length > 0 ? notes : undefined,
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
  methodNode?: SyntaxNode,
): { method: string; path: string } | null {
  // Spring MVC
  for (const a of methodAnnotations) {
    if (SPRING_HTTP_ANNOTATIONS.has(a)) {
      const method = a.replace("Mapping", "").toUpperCase();
      const path = methodNode ? extractAnnotationPath(methodNode, SPRING_HTTP_ANNOTATIONS) ?? "" : "";
      return { method: method === "REQUEST" ? "ANY" : method, path };
    }
  }
  // JAX-RS verb annotations (@GET, @POST, ...) - @Path on the method is a
  // separate annotation that carries the path template.
  for (const a of methodAnnotations) {
    if (JAXRS_HTTP_ANNOTATIONS.has(a)) {
      const jaxRsPathAnnotations = new Set(["Path"]);
      const path = methodNode ? extractAnnotationPath(methodNode, jaxRsPathAnnotations) ?? "" : "";
      return { method: a, path };
    }
  }
  // Servlet: method name encodes the HTTP verb by convention.
  if (isServlet) {
    const impliedMethod = SERVLET_METHOD_ROUTES[methodName];
    if (impliedMethod) return { method: impliedMethod, path: "" };
  }
  return null;
}

/**
 * Walk a method node's annotation list and find the first string path
 * argument on any annotation whose name is in `targetAnnotations`.
 *
 * Handles two forms:
 *   - Bare value:  `@GetMapping("/users/{id}")`
 *   - Named value: `@RequestMapping(value = "/users")` or `path = "..."`
 *
 * Returns the path string without surrounding quotes, or undefined when
 * no matching annotation with a string path argument is found.
 */
function extractAnnotationPath(
  methodNode: SyntaxNode,
  targetAnnotations: Set<string>,
): string | undefined {
  for (let i = 0; i < methodNode.namedChildCount; i++) {
    const child = methodNode.namedChild(i);
    if (!child || child.type !== "modifiers") continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const m = child.namedChild(j);
      if (!m || m.type !== "annotation") continue;
      const nameNode = m.childForFieldName("name");
      if (!nameNode) continue;
      const simpleName = nameNode.text.split(".").pop() ?? nameNode.text;
      if (!targetAnnotations.has(simpleName)) continue;
      const argList = m.childForFieldName("arguments");
      if (!argList) continue;
      const path = extractPathFromAnnotationArgs(argList);
      if (path !== undefined) return path;
    }
  }
  return undefined;
}

/**
 * Extract a path string from an `annotation_argument_list` node.
 * Accepts a bare string literal (positional) or a named `value`/`path` pair.
 */
function extractPathFromAnnotationArgs(argList: SyntaxNode): string | undefined {
  for (let i = 0; i < argList.namedChildCount; i++) {
    const child = argList.namedChild(i);
    if (!child) continue;

    if (child.type === "string_literal") {
      // Bare positional string: @GetMapping("/users/{id}")
      const fragment = child.namedChild(0);
      return fragment?.text ?? child.text.replace(/^"(.*)"$/, "$1");
    }

    if (child.type === "element_value_pair") {
      // Named argument: value = "/path" or path = "/path"
      const key = child.namedChild(0);
      if (!key || (key.text !== "value" && key.text !== "path")) continue;
      const val = child.namedChild(1);
      if (!val || val.type !== "string_literal") continue;
      const fragment = val.namedChild(0);
      return fragment?.text ?? val.text.replace(/^"(.*)"$/, "$1");
    }
  }
  return undefined;
}

/**
 * Concatenate a class-level path prefix with a method-level path suffix,
 * normalizing the slash boundary so both `/prefix` + `/suffix` and
 * `prefix` + `suffix` produce `prefix/suffix` without double slashes.
 */
function joinPaths(prefix: string, suffix: string): string {
  if (!prefix) return suffix;
  if (!suffix) return prefix;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const s = suffix.startsWith("/") ? suffix.slice(1) : suffix;
  return s ? `${p}/${s}` : p;
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

/**
 * Scan method source for Spring Data repository calls and derive model names.
 *
 * Spring Data convention: `userRepository.findById(id)` -> model "User".
 * Works for both field-injection style (`userRepository.`) and occasional
 * static-style (`UserRepository.`); capitalises the prefix in both cases.
 * Handles `this.userRepository.save(x)` because `\b` fires at the `u`.
 */
function extractJpaModels(methodSource: string): string[] {
  const seen = new Set<string>();
  const re = /\b([a-zA-Z]\w*)Repository\./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(methodSource)) !== null) {
    const prefix = m[1]!;
    seen.add(prefix.charAt(0).toUpperCase() + prefix.slice(1));
  }
  return [...seen];
}

function extractCallees(method: SyntaxNode): string[] {
  const callees = new Set<string>();
  const walk = (n: SyntaxNode) => {
    if (n.type === "method_invocation") {
      const nameNode = n.childForFieldName("name");
      if (nameNode && !JAVA_STDLIB_METHODS.has(nameNode.text)) {
        callees.add(nameNode.text);
      }
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
