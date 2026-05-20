import { describe, it, expect } from "vitest";
import { parseJava } from "./java.js";

describe("parseJava", () => {
  it("identifies a Spring controller method as a candidate", () => {
    const source = `package com.example;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class HelloController {

    @GetMapping("/hello")
    public String hello() {
        return "hello";
    }
}
`;
    const candidates = parseJava("/x/HelloController.java", "HelloController.java", source);
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.language).toBe("java");
    expect(c.kind).toBe("controller-method");
    expect(c.name).toBe("HelloController.hello");
    expect(c.hints.httpRoute?.method).toBe("GET");
    expect(c.hints.annotations).toContain("Controller");
    expect(c.hints.annotations).toContain("GetMapping");
  });

  it("identifies POST controller methods", () => {
    const source = `import org.springframework.stereotype.RestController;
import org.springframework.web.bind.annotation.PostMapping;

@RestController
class Api {
    @PostMapping("/items")
    public Object create(Object body) { return body; }
}
`;
    const candidates = parseJava("/x/Api.java", "Api.java", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.httpRoute?.method).toBe("POST");
  });

  it("extracts callees from the method body", () => {
    const source = `class S {
    public void doWork() {
        prepare();
        execute();
        cleanup();
    }
}
`;
    // Without @Service or controller annotation, this method is excluded
    // by selection heuristic. Add @Service so it is included.
    const annotated = source.replace("class S {", "@org.springframework.stereotype.Service\nclass S {");
    const candidates = parseJava("/x/S.java", "S.java", annotated);
    const doWork = candidates.find((c) => c.name === "S.doWork");
    expect(doWork).toBeDefined();
    expect(doWork!.hints.callees).toEqual(
      expect.arrayContaining(["prepare", "execute", "cleanup"]),
    );
  });

  it("skips trivial getters and setters on service classes", () => {
    const source = `import org.springframework.stereotype.Service;
@Service
class UserService {
    private String name;
    public String getName() { return name; }
    public void setName(String n) { this.name = n; }
    public void doRealWork() {
        validate();
        persist();
    }
}`;
    const candidates = parseJava("/x/UserService.java", "UserService.java", source);
    const names = candidates.map((c) => c.name);
    expect(names).toContain("UserService.doRealWork");
    expect(names).not.toContain("UserService.getName");
    expect(names).not.toContain("UserService.setName");
  });

  // --- HTTP route method mapping -----------------------------------------

  // Pins the `a.replace("Mapping", "").toUpperCase()` translation for the
  // remaining verbs the GET/POST cases above didn't exercise. A regression
  // changing the prefix-strip to a startsWith check or losing the
  // SPRING_HTTP_ANNOTATIONS membership for one of these would silently
  // drop the verb on routes a customer's whole API uses.
  it.each([
    ["PutMapping", "PUT"],
    ["DeleteMapping", "DELETE"],
    ["PatchMapping", "PATCH"],
  ])("maps @%s to method=%s", (annotation, expected) => {
    const source = `import org.springframework.stereotype.RestController;
import org.springframework.web.bind.annotation.${annotation};

@RestController
class Api {
    @${annotation}("/items/{id}")
    public Object op() { return null; }
}
`;
    const candidates = parseJava("/x/Api.java", "Api.java", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.httpRoute?.method).toBe(expected);
    expect(candidates[0]!.kind).toBe("controller-method");
  });

  it("translates @RequestMapping to method=ANY (the explicit special-case)", () => {
    // RequestMapping with no explicit method= argument means "any verb";
    // the parser signals this with the sentinel "ANY" so the LLM prompt
    // can describe it as a multi-verb endpoint. A regression dropping the
    // `=== "REQUEST"` branch would emit method="REQUEST" -- semantically wrong.
    const source = `import org.springframework.stereotype.RestController;
import org.springframework.web.bind.annotation.RequestMapping;

@RestController
class Api {
    @RequestMapping("/legacy")
    public Object legacy() { return null; }
}
`;
    const candidates = parseJava("/x/Api.java", "Api.java", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.httpRoute?.method).toBe("ANY");
  });

  it("emits httpRoute.path as empty string (path lives in the raw source for the LLM)", () => {
    // Documented design: the path arg is read by the LLM from the
    // candidate's source field, NOT by the parser. The path field is
    // intentionally "". A regression populating .path from the annotation
    // arg without escaping quotes/parens would risk malformed prompts.
    const source = `import org.springframework.stereotype.RestController;
import org.springframework.web.bind.annotation.GetMapping;

@RestController
class Api {
    @GetMapping("/items/{id}")
    public Object get() { return null; }
}
`;
    const candidates = parseJava("/x/Api.java", "Api.java", source);
    expect(candidates[0]!.hints.httpRoute?.path).toBe("");
  });

  // --- Selection heuristic -----------------------------------------------

  it("emits kind='function' for service-class methods without an HTTP annotation", () => {
    // Pins kind = route ? "controller-method" : "function". A regression
    // defaulting to "controller-method" everywhere would mislabel every
    // @Service method as an HTTP handler and break the LLM prompt routing.
    const source = `import org.springframework.stereotype.Service;
@Service
class Worker {
    public void run() {
        step();
    }
}
`;
    const candidates = parseJava("/x/Worker.java", "Worker.java", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.kind).toBe("function");
    expect(candidates[0]!.hints.httpRoute).toBeUndefined();
  });

  it("excludes methods on classes with no Spring annotation and no @*Mapping", () => {
    // Selection rule: if !route && !isController && !isService -> skip.
    // Without this guard, every method in every utility / DTO class in a
    // repo would be a candidate and the LLM cost would balloon.
    const source = `class Plain {
    public void doWork() {
        helper();
    }
    public int compute() {
        return 42;
    }
}
`;
    const candidates = parseJava("/x/Plain.java", "Plain.java", source);
    expect(candidates).toHaveLength(0);
  });

  it("includes a getter when its body is non-trivial (more than one statement)", () => {
    // looksLikeGetterSetter returns false when statements + returns > 1.
    // A regression making the trivial-check name-only (i.e. always skip
    // getXxx/setXxx/isXxx/hasXxx) would lose accessors that actually
    // contain side-effecting logic (caching, lazy-init, audit logging).
    const source = `import org.springframework.stereotype.Service;
@Service
class Cache {
    private String value;
    public String getValue() {
        log("getValue called");
        recordAccess();
        return value;
    }
}
`;
    const candidates = parseJava("/x/Cache.java", "Cache.java", source);
    const names = candidates.map((c) => c.name);
    expect(names).toContain("Cache.getValue");
  });

  it.each(["isActive", "hasPermission"])(
    "skips trivial %s-style accessors (is/has prefix)",
    (methodName) => {
      // Pins the `(get|set|is|has)[A-Z]` prefix regex. Only get/set are
      // exercised in the existing test; a regression narrowing the regex
      // to `(get|set)` would let trivial isXxx/hasXxx accessors through.
      const source = `import org.springframework.stereotype.Service;
@Service
class Acl {
    private boolean flag;
    public boolean ${methodName}() { return flag; }
    public void doRealWork() {
        validate();
    }
}
`;
      const candidates = parseJava("/x/Acl.java", "Acl.java", source);
      const names = candidates.map((c) => c.name);
      expect(names).toContain("Acl.doRealWork");
      expect(names).not.toContain(`Acl.${methodName}`);
    },
  );

  // --- Annotation normalization ------------------------------------------

  it("normalizes fully-qualified annotation names to the last segment", () => {
    // Real Spring codebases often skip the import and write
    // `@org.springframework.stereotype.Service`. The parser splits on `.`
    // and keeps the last segment so the heuristic Set lookup works.
    // A regression keeping the full FQN would silently exclude every
    // service in a codebase that uses the fully-qualified style.
    const source = `class Svc {
    @org.springframework.web.bind.annotation.GetMapping("/x")
    public String x() { return ""; }
}
`;
    // Class has no @Controller, so the route alone must drive inclusion
    // via the !route && !isController && !isService guard.
    const annotated = source.replace(
      "class Svc {",
      "@org.springframework.stereotype.Controller\nclass Svc {",
    );
    const candidates = parseJava("/x/Svc.java", "Svc.java", annotated);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.annotations).toContain("Controller");
    expect(candidates[0]!.hints.annotations).toContain("GetMapping");
    expect(candidates[0]!.hints.httpRoute?.method).toBe("GET");
  });

  // --- Parameter extraction ----------------------------------------------

  it("extracts parameter names and types from formal parameters", () => {
    // extractParameters reads childForFieldName("type") and ("name") on
    // each formal_parameter. A regression dropping the type or swapping
    // the field names would land in the LLM prompt as `?` or undefined.
    const source = `import org.springframework.stereotype.RestController;
import org.springframework.web.bind.annotation.PostMapping;

@RestController
class Api {
    @PostMapping("/items")
    public Object create(String name, int qty, java.util.List<String> tags) {
        return null;
    }
}
`;
    const candidates = parseJava("/x/Api.java", "Api.java", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.parameters).toEqual([
      { name: "name", type: "String" },
      { name: "qty", type: "int" },
      { name: "tags", type: "java.util.List<String>" },
    ]);
  });

  // --- Callee extraction -------------------------------------------------

  it("deduplicates callees via Set (same method called multiple times appears once)", () => {
    // extractCallees uses a Set, so 5 calls to log() collapse to one
    // entry. A regression switching to a plain array would balloon the
    // LLM prompt with noise for any method that calls a helper in a loop.
    const source = `import org.springframework.stereotype.Service;
@Service
class Repeat {
    public void run() {
        log("a");
        log("b");
        log("c");
        log("d");
        log("e");
    }
}
`;
    const candidates = parseJava("/x/Repeat.java", "Repeat.java", source);
    expect(candidates).toHaveLength(1);
    const callees = candidates[0]!.hints.callees ?? [];
    const logCount = callees.filter((c) => c === "log").length;
    expect(logCount).toBe(1);
  });

  it("caps callees at 30 entries (cost guardrail on prompt size)", () => {
    // The `.slice(0, 30)` cap exists so a method with 200 helper calls
    // doesn't blow up the LLM prompt. A regression removing the slice
    // would silently inflate token cost on methods like procedural
    // batch jobs that fan out to many helpers.
    const calls = Array.from({ length: 35 }, (_, i) => `helper${i}();`).join("\n        ");
    const source = `import org.springframework.stereotype.Service;
@Service
class Big {
    public void run() {
        ${calls}
    }
}
`;
    const candidates = parseJava("/x/Big.java", "Big.java", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.callees).toHaveLength(30);
  });

  // --- Multiple classes / inner classes ---------------------------------

  it("emits separate candidates for methods in multiple top-level classes in one file", () => {
    // collectByType walks the entire tree, so two top-level classes
    // each contribute their own candidates. A regression scoping to
    // rootNode.namedChildren only would miss the second class.
    const source = `import org.springframework.stereotype.Service;
import org.springframework.stereotype.RestController;
import org.springframework.web.bind.annotation.GetMapping;

@Service
class Worker {
    public void run() { step(); }
}

@RestController
class Api {
    @GetMapping("/x")
    public String x() { return ""; }
}
`;
    const candidates = parseJava("/x/Mixed.java", "Mixed.java", source);
    const byName = Object.fromEntries(candidates.map((c) => [c.name, c]));
    expect(byName["Worker.run"]).toBeDefined();
    expect(byName["Worker.run"]!.kind).toBe("function");
    expect(byName["Api.x"]).toBeDefined();
    expect(byName["Api.x"]!.kind).toBe("controller-method");
  });

  // --- Source slice / line numbers ---------------------------------------

  it("captures lineStart/lineEnd as 1-indexed and source contains the method text", () => {
    // tree-sitter positions are 0-indexed; the parser adds 1 so line
    // numbers match what an editor / `git blame` shows. A regression
    // dropping the +1 would shift every citation by one line.
    const source = `import org.springframework.stereotype.Service;
@Service
class Lined {
    public void method() {
        doIt();
    }
}
`;
    // method() body sits on lines 4-6 in the source above (1-indexed).
    const candidates = parseJava("/x/Lined.java", "Lined.java", source);
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.lineStart).toBe(4);
    expect(c.lineEnd).toBe(6);
    expect(c.source).toContain("public void method()");
    expect(c.source).toContain("doIt();");
  });

  // --- Java EE 6/8 support -----------------------------------------------

  it("identifies a JAX-RS @GET resource method as controller-method", () => {
    const source = `import javax.ws.rs.Path;
import javax.ws.rs.GET;
import javax.ws.rs.Produces;

@Path("/orders")
public class OrderResource {

    @GET
    @Produces("application/json")
    public Response listOrders() {
        return Response.ok().build();
    }
}
`;
    const candidates = parseJava("/x/OrderResource.java", "OrderResource.java", source);
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.kind).toBe("controller-method");
    expect(c.name).toBe("OrderResource.listOrders");
    expect(c.hints.httpRoute?.method).toBe("GET");
    expect(c.hints.annotations).toContain("Path");
    expect(c.hints.annotations).toContain("GET");
  });

  it.each([
    ["POST", "POST"],
    ["PUT", "PUT"],
    ["DELETE", "DELETE"],
    ["PATCH", "PATCH"],
    ["HEAD", "HEAD"],
    ["OPTIONS", "OPTIONS"],
  ])("maps JAX-RS @%s to method=%s", (annotation, expected) => {
    const source = `import javax.ws.rs.Path;
import javax.ws.rs.${annotation};

@Path("/items")
class ItemResource {
    @${annotation}
    public Object op() { return null; }
}
`;
    const candidates = parseJava("/x/ItemResource.java", "ItemResource.java", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.httpRoute?.method).toBe(expected);
    expect(candidates[0]!.kind).toBe("controller-method");
  });

  it("identifies an EJB @Stateless bean method as a function candidate", () => {
    const source = `import javax.ejb.Stateless;

@Stateless
public class OrderService {

    public void placeOrder(String item, int qty) {
        validate(item);
        persist(item, qty);
    }
}
`;
    const candidates = parseJava("/x/OrderService.java", "OrderService.java", source);
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.kind).toBe("function");
    expect(c.name).toBe("OrderService.placeOrder");
    expect(c.hints.annotations).toContain("Stateless");
  });

  it("identifies a @MessageDriven bean's onMessage method", () => {
    const source = `import javax.ejb.MessageDriven;

@MessageDriven
public class NotificationListener {
    public void onMessage(javax.jms.Message msg) {
        process(msg);
    }
}
`;
    const candidates = parseJava("/x/NotificationListener.java", "NotificationListener.java", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("NotificationListener.onMessage");
    expect(candidates[0]!.kind).toBe("function");
  });

  it("identifies a CDI @ApplicationScoped bean method", () => {
    const source = `import javax.enterprise.context.ApplicationScoped;

@ApplicationScoped
public class ConfigService {
    public String fetchSetting(String key) {
        return lookup(key);
    }
}
`;
    const candidates = parseJava("/x/ConfigService.java", "ConfigService.java", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("ConfigService.fetchSetting");
    expect(candidates[0]!.hints.annotations).toContain("ApplicationScoped");
  });

  it.each(["Stateful", "Singleton"])(
    "includes @%s EJB bean methods",
    (annotation) => {
      const source = `import javax.ejb.${annotation};

@${annotation}
class CartBean {
    public void addItem(String item) {
        save(item);
    }
}
`;
      const candidates = parseJava("/x/CartBean.java", "CartBean.java", source);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.hints.annotations).toContain(annotation);
    },
  );

  it.each(["RequestScoped", "SessionScoped", "Named", "Dependent"])(
    "includes @%s CDI bean methods",
    (annotation) => {
      const source = `import javax.enterprise.context.${annotation};

@${annotation}
class MyBean {
    public void execute() {
        step();
    }
}
`;
      const candidates = parseJava("/x/MyBean.java", "MyBean.java", source);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.hints.annotations).toContain(annotation);
    },
  );

  it("identifies @WebServlet doGet and doPost methods with implied HTTP routes", () => {
    const source = `import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

@WebServlet("/checkout")
public class CheckoutServlet extends HttpServlet {

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) {
        renderForm(req, resp);
    }

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse resp) {
        processOrder(req, resp);
    }

    private void renderForm(HttpServletRequest req, HttpServletResponse resp) {}
    private void processOrder(HttpServletRequest req, HttpServletResponse resp) {}
}
`;
    const candidates = parseJava("/x/CheckoutServlet.java", "CheckoutServlet.java", source);
    const byName = Object.fromEntries(candidates.map((c) => [c.name, c]));
    expect(byName["CheckoutServlet.doGet"]).toBeDefined();
    expect(byName["CheckoutServlet.doGet"]!.hints.httpRoute?.method).toBe("GET");
    expect(byName["CheckoutServlet.doGet"]!.kind).toBe("controller-method");
    expect(byName["CheckoutServlet.doPost"]).toBeDefined();
    expect(byName["CheckoutServlet.doPost"]!.hints.httpRoute?.method).toBe("POST");
    // Private helpers must not be included (they don't match SERVLET_METHOD_ROUTES).
    expect(byName["CheckoutServlet.renderForm"]).toBeUndefined();
    expect(byName["CheckoutServlet.processOrder"]).toBeUndefined();
  });

  it("exposes @WebServlet service() with method=ANY", () => {
    const source = `import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

@WebServlet("/legacy")
public class LegacyServlet extends HttpServlet {
    @Override
    public void service(HttpServletRequest req, HttpServletResponse resp) {
        dispatch(req, resp);
    }
}
`;
    const candidates = parseJava("/x/LegacyServlet.java", "LegacyServlet.java", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.httpRoute?.method).toBe("ANY");
    expect(candidates[0]!.kind).toBe("controller-method");
  });

  it("skips servlet lifecycle methods (init, destroy)", () => {
    const source = `import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;

@WebServlet("/app")
public class AppServlet extends HttpServlet {
    @Override
    public void init() { setup(); }
    @Override
    public void destroy() { teardown(); }
    @Override
    protected void doGet(javax.servlet.http.HttpServletRequest q, javax.servlet.http.HttpServletResponse r) {
        handle(q, r);
    }
}
`;
    const candidates = parseJava("/x/AppServlet.java", "AppServlet.java", source);
    const names = candidates.map((c) => c.name);
    expect(names).toContain("AppServlet.doGet");
    expect(names).not.toContain("AppServlet.init");
    expect(names).not.toContain("AppServlet.destroy");
  });

  it("does not emit non-HTTP servlet helper methods", () => {
    // Guards the 'if (isServlet && !route) continue' path: a class with
    // @WebServlet should NOT expose arbitrary helpers that don't match
    // SERVLET_METHOD_ROUTES.
    const source = `import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;

@WebServlet("/x")
class Srv extends HttpServlet {
    private void internalHelper() { compute(); }
}
`;
    const candidates = parseJava("/x/Srv.java", "Srv.java", source);
    expect(candidates).toHaveLength(0);
  });

  it("identifies @WebFilter doFilter as controller-method with method=ANY", () => {
    // WebFilter is in SERVLET_ANNOTATIONS and doFilter is in
    // SERVLET_METHOD_ROUTES, but no test pinned the wiring. A regression
    // dropping either entry would silently emit zero candidates for the
    // entire @WebFilter family (common in legacy Java EE apps for auth /
    // logging / CORS interception).
    const source = `import javax.servlet.annotation.WebFilter;
import javax.servlet.Filter;
import javax.servlet.FilterChain;
import javax.servlet.ServletRequest;
import javax.servlet.ServletResponse;

@WebFilter("/secure/*")
public class AuthFilter implements Filter {
    @Override
    public void doFilter(ServletRequest req, ServletResponse resp, FilterChain chain) {
        if (isAuthorized(req)) {
            chain.doFilter(req, resp);
        }
    }

    private boolean isAuthorized(ServletRequest req) { return true; }
}
`;
    const candidates = parseJava("/x/AuthFilter.java", "AuthFilter.java", source);
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.name).toBe("AuthFilter.doFilter");
    expect(c.kind).toBe("controller-method");
    expect(c.hints.httpRoute?.method).toBe("ANY");
    expect(c.hints.annotations).toContain("WebFilter");
  });

  it("emits @Path class method without a verb annotation as function (sub-resource locator)", () => {
    // A @Path class without a verb annotation on the method is a JAX-RS
    // sub-resource locator: it returns another resource instance that
    // owns the actual verb. The class marks isController=true, but
    // extractHttpRoute returns null (no Spring or JAX-RS verb, not a
    // servlet), so the method is kept and kind defaults to "function".
    // Pins the route=null + isController=true branch at the
    // `kind: route ? "controller-method" : "function"` ternary.
    const source = `import javax.ws.rs.Path;

@Path("/customers")
public class CustomerResource {

    @Path("{id}/orders")
    public OrderResource orders(String id) {
        return new OrderResource(id);
    }
}
`;
    const candidates = parseJava(
      "/x/CustomerResource.java",
      "CustomerResource.java",
      source,
    );
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.name).toBe("CustomerResource.orders");
    expect(c.kind).toBe("function");
    expect(c.hints.httpRoute).toBeUndefined();
    expect(c.hints.annotations).toContain("Path");
  });

  // tree-sitter-node's `parse(string)` overload throws "Invalid argument"
  // when source exceeds its internal buffer (~32 KB). 2026-05-16 jspwiki
  // real-repo run hit 6 such files (WikiEngine.java=39 KB, etc.). The
  // callback overload pages through the source and has no upper limit.
  //
  // This test synthesizes a >40 KB source so a regression that reverts
  // parser.parse(callback) → parser.parse(string) trips here, not in
  // production. The synthetic source is REAL Java that tree-sitter can
  // parse cleanly, just made long via repetition of a controller class
  // with N unique service methods.
  it("parses files >32KB without throwing 'Invalid argument' (tree-sitter buffer-overflow regression guard)", () => {
    let source =
      "package org.example;\n" +
      "import org.springframework.stereotype.Controller;\n" +
      "@Controller\n" +
      "public class Large {\n";
    // Each method below is ~125 bytes. 500 methods → ~63 KB total,
    // well past the 32 KB limit that triggers the buffer overflow
    // (and past WikiEngine.java's 39 KB / SpamFilter.java's 47 KB).
    for (let i = 0; i < 500; i++) {
      source +=
        `  public String method${i}(String input) {\n` +
        `    String result = "prefix_" + input + "_${i}";\n` +
        `    return result.toUpperCase();\n` +
        `  }\n`;
    }
    source += "}\n";
    expect(source.length).toBeGreaterThan(32 * 1024);
    // The load-bearing assertion is "doesn't throw", the candidate
    // list will be large but specific counts are not the point here.
    let candidates: ReturnType<typeof parseJava>;
    expect(() => {
      candidates = parseJava("/x/Large.java", "Large.java", source);
    }).not.toThrow();
    // Sanity: tree-sitter actually parsed the content, not just
    // bailed out silently. We expect ~250 candidates (one per method,
    // though some may be filtered by the trivial-getter heuristic).
    expect(candidates!.length).toBeGreaterThan(100);
  });
});

describe("parseJava surfaceMode", () => {
  // Pins the three-way gate on which classes the parser surfaces
  // methods from. Default 'annotated' preserves pre-2026-05-16 behavior
  // (covered by every other test in this file). The two non-default
  // modes exist for legacy Java codebases that pre-date framework
  // annotations and rely on package conventions or Javadoc instead
  // (motivated by the JSPWiki signal run: ~zero @Controller/@Service
  // annotations across the entire codebase).

  it("'annotated' (default) still detects an @Controller class (backwards-compat)", () => {
    // Symmetric assertion against the byte-identical-behavior promise:
    // a regression that flipped the gate logic on default mode would
    // surface methods that previously got skipped (or skip ones that
    // were emitted). Three call shapes pinned: no-options (default
    // applied inside parseJava), explicit options.surfaceMode='annotated',
    // and undefined options.surfaceMode (also defaults).
    const source = `package com.example;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class HelloController {
    @GetMapping("/hello")
    public String hello() {
        return "hi";
    }
}
`;
    for (const opts of [
      undefined,
      { surfaceMode: "annotated" as const },
      { surfaceMode: undefined },
    ]) {
      const candidates = parseJava(
        "/x/HelloController.java",
        "HelloController.java",
        source,
        opts,
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.name).toBe("HelloController.hello");
      expect(candidates[0]!.kind).toBe("controller-method");
    }
  });

  it("'all-public-classes' surfaces a Javadoc'd 3-method class with no framework annotations", () => {
    // The JSPWiki-style case: plain `public class` with substantive
    // public methods and a class-level Javadoc, no @Controller /
    // @Service / @Component. Default mode skips it (no annotation =
    // no gate fires); 'all-public-classes' picks it up.
    //
    // Three public non-trivial methods (>=3 threshold). A fourth
    // trivial getter is included to prove the trivial-accessor skip
    // still applies post-eligibility.
    const source = `package org.example.wiki;

/**
 * Routes incoming wiki page requests through the rendering pipeline.
 * Owns version selection, lock acquisition, and the per-request
 * permission check.
 */
public class WikiRouter {
    private String name;

    public String route(String path, String method) {
        validate(path);
        return resolveTarget(path);
    }

    public boolean acquireLock(String pageId, String userId) {
        if (isLocked(pageId)) {
            recordContention(pageId, userId);
            return false;
        }
        return claim(pageId, userId);
    }

    public void invalidateCache(String pageId) {
        notify(pageId);
        recompute(pageId);
        flush();
    }

    public String getName() {
        return name;
    }

    private boolean isLocked(String pageId) { return false; }
    private boolean claim(String pageId, String userId) { return true; }
    private void recordContention(String pageId, String userId) {}
    private void validate(String path) {}
    private String resolveTarget(String path) { return path; }
    private void notify(String pageId) {}
    private void recompute(String pageId) {}
    private void flush() {}
}
`;
    // Default mode: the class has no framework annotation -> nothing
    // surfaces. Negative assertion proves the new mode is the ONLY
    // reason the methods appear, not a side effect of some other change.
    const defaultCandidates = parseJava(
      "/x/WikiRouter.java",
      "WikiRouter.java",
      source,
    );
    expect(defaultCandidates).toHaveLength(0);

    // 'all-public-classes' mode: the three public non-trivial methods
    // surface. getName is the trivial getter that must NOT surface.
    const candidates = parseJava(
      "/x/WikiRouter.java",
      "WikiRouter.java",
      source,
      { surfaceMode: "all-public-classes" },
    );
    const names = candidates.map((c) => c.name).sort();
    expect(names).toEqual([
      "WikiRouter.acquireLock",
      "WikiRouter.invalidateCache",
      "WikiRouter.route",
    ]);
    // Non-annotated mode emits methods with kind='function' (no HTTP
    // route to lift them to 'controller-method'); pin the kind so a
    // regression labeling them 'controller-method' surfaces here.
    for (const c of candidates) {
      expect(c.kind).toBe("function");
      expect(c.hints.httpRoute).toBeUndefined();
    }
  });

  it("'package-allowlist' surfaces a class in a *.service.* package with no Javadoc and no annotations", () => {
    // The convention-driven case: legacy Java codebases that organize
    // by layer-per-package (com.foo.service, com.foo.dao). The class
    // here has NO Javadoc and NO annotations, so 'all-public-classes'
    // would skip it (Javadoc required). 'package-allowlist' picks it
    // up purely on the package path.
    const source = `package com.example.service.user;

public class UserAccountService {
    public String createUser(String email, String name) {
        validate(email);
        return persist(email, name);
    }

    public void deactivateUser(String userId) {
        markInactive(userId);
        notifyAuditLog(userId);
    }

    public String resetPassword(String userId) {
        String token = generateToken();
        sendResetEmail(userId, token);
        return token;
    }

    private void validate(String email) {}
    private String persist(String email, String name) { return ""; }
    private void markInactive(String userId) {}
    private void notifyAuditLog(String userId) {}
    private String generateToken() { return ""; }
    private void sendResetEmail(String userId, String token) {}
}
`;
    // Default mode skips (no annotation). 'all-public-classes' also
    // skips (no Javadoc on the class). 'package-allowlist' picks it up.
    expect(
      parseJava("/x/UserAccountService.java", "service/user/UserAccountService.java", source),
    ).toHaveLength(0);
    expect(
      parseJava(
        "/x/UserAccountService.java",
        "service/user/UserAccountService.java",
        source,
        { surfaceMode: "all-public-classes" },
      ),
    ).toHaveLength(0);

    const candidates = parseJava(
      "/x/UserAccountService.java",
      "service/user/UserAccountService.java",
      source,
      { surfaceMode: "package-allowlist" },
    );
    const names = candidates.map((c) => c.name).sort();
    expect(names).toEqual([
      "UserAccountService.createUser",
      "UserAccountService.deactivateUser",
      "UserAccountService.resetPassword",
    ]);

    // Symmetric negative: a class in a NON-allowlisted package (no
    // service/business/manager/dao/api segment) must NOT surface in
    // 'package-allowlist' mode, even with otherwise-identical body.
    const offPackageSource = source.replace(
      "package com.example.service.user;",
      "package com.example.util.string;",
    );
    expect(
      parseJava(
        "/x/StringUtils.java",
        "util/string/StringUtils.java",
        offPackageSource,
        { surfaceMode: "package-allowlist" },
      ),
    ).toHaveLength(0);
  });
});

describe("parseJava JMH benchmark skip", () => {
  // Pins the JMH-class skip (BENCHMARK_ANNOTATIONS, default-on).
  // Motivated by the 2026-05-16 dropwizard run: in-tree JMH stubs like
  // DropwizardResourceConfigBenchmark.java produce low-confidence pages
  // about `return "asset_by_id"`-style measurement scaffolding, never
  // business logic. The directory-glob filter (**/*benchmark*/**)
  // catches dropwizard-benchmarks/ but misses in-tree harnesses that
  // sit next to production code; this annotation gate is the
  // content-level backstop.

  it("skips a @BenchmarkMode-annotated class even when it carries an HTTP-verb method (annotation skip beats route detection)", () => {
    // The class additionally carries @State and a method that looks
    // like a controller method (@GET). Without the JMH skip, the
    // @GET would lift this to a controller-method candidate. With
    // the skip, the whole class drops, no candidates at all. Pins
    // the "skip BEFORE the per-mode gate" placement: a regression
    // moving the check after the framework gate would let
    // benchmark + framework annotations slip through.
    const source = `package com.example.bench;

import org.openjdk.jmh.annotations.BenchmarkMode;
import org.openjdk.jmh.annotations.Mode;
import org.openjdk.jmh.annotations.State;
import org.openjdk.jmh.annotations.Scope;
import org.openjdk.jmh.annotations.Benchmark;
import javax.ws.rs.GET;
import javax.ws.rs.Path;

@BenchmarkMode(Mode.Throughput)
@State(Scope.Benchmark)
@Path("/asset")
public class AssetLookupBenchmark {
    @Benchmark
    @GET
    public String lookup() {
        return "asset_by_id";
    }

    @Benchmark
    public String lookupCached() {
        return "asset_cached";
    }

    public String warmup() {
        prime();
        compute();
        record();
        return "warm";
    }
}
`;
    // Three call shapes pinned: default mode + both non-default modes
    // ALL skip the class, the JMH gate is universal across modes (a
    // regression scoping it to one branch would surface here under
    // the other two).
    for (const opts of [
      undefined,
      { surfaceMode: "all-public-classes" as const },
      { surfaceMode: "package-allowlist" as const },
    ]) {
      const candidates = parseJava(
        "/x/AssetLookupBenchmark.java",
        "bench/AssetLookupBenchmark.java",
        source,
        opts,
      );
      expect(candidates).toEqual([]);
    }
  });

  it("surfaces a @BenchmarkMode class in default annotated mode when includeJmhBenchmarks is true", () => {
    // Pins the opt-in path in the default (annotated) surfaceMode: opted-in
    // JMH classes bypass the framework annotation gate because they carry
    // no framework annotations by design. Without this bypass, setting
    // includeJmhBenchmarks=true in annotated mode would be a silent no-op.
    const source = `package com.example.bench;

import org.openjdk.jmh.annotations.BenchmarkMode;
import org.openjdk.jmh.annotations.State;
import org.openjdk.jmh.annotations.Scope;

@BenchmarkMode
@State(Scope.Thread)
public class ThroughputBenchmark {
    public void measureCreate() {
        doCreate();
        verifyCreated();
    }
    public void measureDelete() {
        doDelete();
        verifyDeleted();
    }
}
`;
    // No surfaceMode override: annotated is the default. No Javadoc or
    // 3-method threshold required (those are all-public-classes constraints).
    const candidates = parseJava(
      "/x/ThroughputBenchmark.java",
      "ThroughputBenchmark.java",
      source,
      { includeJmhBenchmarks: true },
    );
    expect(candidates.length).toBeGreaterThan(0);
    // Both public non-trivial methods surface.
    const names = candidates.map((c) => c.name).sort();
    expect(names).toEqual([
      "ThroughputBenchmark.measureCreate",
      "ThroughputBenchmark.measureDelete",
    ]);
  });

  it("with includeJmhBenchmarks=true, a mixed JMH+framework class surfaces all public non-trivial methods (not just route-mapped ones)", () => {
    // A class with both JMH annotations (@BenchmarkMode, @Path) and
    // includeJmhBenchmarks=true must use the non-framework gate (all
    // public non-trivial methods), NOT the route-only gate. A regression
    // restoring useFrameworkGate=true for this class would surface only
    // the @GET-mapped method and silently drop the others.
    const source = `package com.example.bench;

import org.openjdk.jmh.annotations.BenchmarkMode;
import org.openjdk.jmh.annotations.State;
import org.openjdk.jmh.annotations.Scope;
import javax.ws.rs.GET;
import javax.ws.rs.Path;

@BenchmarkMode
@State(Scope.Thread)
@Path("/asset")
public class MixedBenchmark {
    @GET
    public String routedMethod() {
        return fetch();
    }

    public void unmappedMethod() {
        compute();
        record();
    }
}
`;
    const candidates = parseJava(
      "/x/MixedBenchmark.java",
      "MixedBenchmark.java",
      source,
      { includeJmhBenchmarks: true },
    );
    const names = candidates.map((c) => c.name).sort();
    // Both methods surface, not just the @GET-mapped one.
    expect(names).toEqual([
      "MixedBenchmark.routedMethod",
      "MixedBenchmark.unmappedMethod",
    ]);
  });

  it("does NOT skip a non-JMH class whose annotations happen to look unrelated", () => {
    // Symmetric negative against the BENCHMARK_ANNOTATIONS set: a
    // class with @Component (Spring) and @Cacheable (Spring Cache)
    // shares no overlap with {BenchmarkMode, State, Benchmark} and
    // must NOT be skipped. A regression broadening the match (e.g.
    // a substring check that caught `*State*` -> `RestController`,
    // or `*Benchmark*` -> a hypothetical `Benchmarked` annotation)
    // would empty this test's expected candidates.
    const source = `package com.example;

import org.springframework.stereotype.Service;
import org.springframework.cache.annotation.Cacheable;

@Service
public class ReportService {
    @Cacheable("reports")
    public String generateReport(String reportId) {
        loadData(reportId);
        return formatReport();
    }

    public void invalidateReport(String reportId) {
        flush(reportId);
        notifySubscribers(reportId);
    }
}
`;
    const candidates = parseJava(
      "/x/ReportService.java",
      "ReportService.java",
      source,
    );
    // @Service + non-trivial public methods = both surface in default
    // 'annotated' mode (the framework-stereotype path).
    const names = candidates.map((c) => c.name).sort();
    expect(names).toEqual([
      "ReportService.generateReport",
      "ReportService.invalidateReport",
    ]);
  });
});
