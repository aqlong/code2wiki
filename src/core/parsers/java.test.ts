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

  it("extracts route path from @GetMapping(\"/template\") annotation argument", () => {
    const source = `import org.springframework.web.bind.annotation.*;

@RestController
class Api {
    @GetMapping("/items/{id}")
    public Object getById(int id) { return null; }

    @PostMapping("/items")
    public Object create() { return null; }

    @DeleteMapping("/items/{id}/tags/{tagId}")
    public void removeTag(int id, int tagId) {}

    @GetMapping
    public Object list() { return null; }
}
`;
    const candidates = parseJava("/x/Api.java", "Api.java", source);

    const get = candidates.find((c) => c.name === "Api.getById")!;
    expect(get.hints.httpRoute).toEqual({ method: "GET", path: "/items/{id}" });

    const post = candidates.find((c) => c.name === "Api.create")!;
    expect(post.hints.httpRoute).toEqual({ method: "POST", path: "/items" });

    const del = candidates.find((c) => c.name === "Api.removeTag")!;
    expect(del.hints.httpRoute).toEqual({ method: "DELETE", path: "/items/{id}/tags/{tagId}" });

    // No argument: path stays empty string
    const list = candidates.find((c) => c.name === "Api.list")!;
    expect(list.hints.httpRoute).toEqual({ method: "GET", path: "" });
  });

  it("extracts route path from @RequestMapping(value = \"/path\") named argument", () => {
    const source = `import org.springframework.web.bind.annotation.*;

@RestController
class LegacyApi {
    @RequestMapping(value = "/legacy/users", method = RequestMethod.GET)
    public Object getUsers() { return null; }

    @RequestMapping(path = "/legacy/orders")
    public Object getOrders() { return null; }
}
`;
    const candidates = parseJava("/x/LegacyApi.java", "LegacyApi.java", source);
    const users = candidates.find((c) => c.name === "LegacyApi.getUsers")!;
    expect(users.hints.httpRoute?.path).toBe("/legacy/users");

    const orders = candidates.find((c) => c.name === "LegacyApi.getOrders")!;
    expect(orders.hints.httpRoute?.path).toBe("/legacy/orders");
  });

  it("prepends class-level @RequestMapping prefix to method-level route paths", () => {
    // Spring REST controllers commonly have @RequestMapping("/api/v1") at the
    // class level and verb-specific mappings at the method level. The combined
    // route is /api/v1/users/{id}, not just /users/{id}. Without the prefix
    // the LLM route hint is incomplete.
    const source = `import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
public class UserController {
    @GetMapping("/users/{id}")
    public Object getUser(int id) { return null; }

    @PostMapping("/users")
    public Object createUser() { return null; }

    @GetMapping
    public Object listAll() { return null; }
}
`;
    const candidates = parseJava("/x/UserController.java", "UserController.java", source);

    const get = candidates.find((c) => c.name === "UserController.getUser")!;
    expect(get.hints.httpRoute).toEqual({ method: "GET", path: "/api/v1/users/{id}" });

    const post = candidates.find((c) => c.name === "UserController.createUser")!;
    expect(post.hints.httpRoute).toEqual({ method: "POST", path: "/api/v1/users" });

    // No method path arg: prefix only
    const list = candidates.find((c) => c.name === "UserController.listAll")!;
    expect(list.hints.httpRoute).toEqual({ method: "GET", path: "/api/v1" });
  });

  it("prepends class-level JAX-RS @Path prefix to method-level @Path", () => {
    const source = `import javax.ws.rs.*;

@Path("/orders")
public class OrderResource {
    @GET
    @Path("/{orderId}")
    public Response getOrder(int orderId) { return null; }

    @POST
    public Response createOrder() { return null; }
}
`;
    const candidates = parseJava("/x/OrderResource.java", "OrderResource.java", source);

    const get = candidates.find((c) => c.name === "OrderResource.getOrder")!;
    expect(get.hints.httpRoute).toEqual({ method: "GET", path: "/orders/{orderId}" });

    const post = candidates.find((c) => c.name === "OrderResource.createOrder")!;
    expect(post.hints.httpRoute).toEqual({ method: "POST", path: "/orders" });
  });

  // --- Auth annotation notes -------------------------------------------

  it("surfaces Spring Security + JEE auth annotations as hints.notes", () => {
    // @PreAuthorize / @Secured / @RolesAllowed signal restricted access.
    // Bundling them into notes gives the LLM an unambiguous signal so it
    // includes authorization context in the generated use-case page, instead
    // of having to infer it from the raw annotations list.
    const source = `import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;
import javax.annotation.security.RolesAllowed;

@RestController
@RequestMapping("/api")
public class AdminController {
    @GetMapping("/reports")
    @PreAuthorize("hasRole('ADMIN')")
    public Object getReports() { return null; }

    @DeleteMapping("/users/{id}")
    @RolesAllowed("ADMIN")
    public void deleteUser(int id) {}

    @GetMapping("/public")
    public Object publicEndpoint() { return null; }
}
`;
    const candidates = parseJava("/x/AdminController.java", "AdminController.java", source);

    const reports = candidates.find((c) => c.name === "AdminController.getReports")!;
    expect(reports.hints.notes).toEqual(["auth: PreAuthorize"]);

    const del = candidates.find((c) => c.name === "AdminController.deleteUser")!;
    expect(del.hints.notes).toEqual(["auth: RolesAllowed"]);

    // No auth annotation: notes should be absent (not an empty array)
    const pub = candidates.find((c) => c.name === "AdminController.publicEndpoint")!;
    expect(pub.hints.notes).toBeUndefined();
  });

  it("includes class-level auth annotation in notes when method inherits it", () => {
    // @Secured on the class applies to all methods; it should appear in
    // notes even when the method itself carries no auth annotation.
    const source = `import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.annotation.Secured;

@RestController
@Secured("ROLE_USER")
public class UserController {
    @GetMapping("/profile")
    public Object getProfile() { return null; }
}
`;
    const candidates = parseJava("/x/UserController.java", "UserController.java", source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.hints.notes).toEqual(["auth: Secured"]);
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

  it("filters JVM stdlib noise from callees (Stream/Optional/Object/logger)", () => {
    // Without this filter, Stream-heavy methods fill the 30-cap with
    // `stream`, `flatMap`, `collect`, `toList`, etc., pushing real business
    // calls off the list. Filter keeps `findActive`, `toDto`, `isExpired`
    // (the actual business signal) while dropping pipeline noise.
    const source = `import org.springframework.stereotype.Service;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import java.util.List;
import java.util.Optional;
@Service
class Reporter {
    private static final Logger log = LoggerFactory.getLogger(Reporter.class);
    public List<UserDto> report() {
        log.debug("starting");
        log.info("computing");
        return findActive()
            .stream()
            .filter(u -> !u.isExpired())
            .map(u -> toDto(u))
            .sorted()
            .distinct()
            .collect(java.util.stream.Collectors.toList());
    }
    List<User> findActive() { return null; }
    UserDto toDto(User u) { return null; }
}
`;
    const candidates = parseJava("/x/Reporter.java", "Reporter.java", source);
    const callees = candidates[0]!.hints.callees ?? [];
    // Business signal stays.
    expect(callees).toContain("findActive");
    expect(callees).toContain("toDto");
    expect(callees).toContain("isExpired");
    // Stdlib noise gets dropped.
    expect(callees).not.toContain("stream");
    expect(callees).not.toContain("collect");
    expect(callees).not.toContain("sorted");
    expect(callees).not.toContain("distinct");
    expect(callees).not.toContain("toList");
    expect(callees).not.toContain("debug");
    expect(callees).not.toContain("info");
    // Note: `filter` and `map` are intentionally NOT filtered (too generic
    // to safely exclude, business code commonly uses these names).
  });

  it("JAVA_STDLIB_METHODS covers every documented alternative (defends set-deletion drift)", () => {
    // Each entry in the JAVA_STDLIB_METHODS set is filtered. A single-entry
    // deletion would silently let that noise back into the callees hint.
    // This loop calls each method as a bare invocation; if any one starts
    // appearing in callees, the named-failure assertion identifies it.
    const stdlibMethods = [
      "equals", "hashCode", "toString", "getClass",
      "stream", "parallelStream", "flatMap", "reduce", "collect",
      "sorted", "distinct", "peek", "limit", "skip",
      "findFirst", "findAny", "anyMatch", "allMatch", "noneMatch",
      "toList", "toArray", "toSet", "toMap",
      "ofNullable", "isPresent", "orElse", "orElseGet", "orElseThrow",
      "ifPresent", "ifPresentOrElse",
      "debug", "info", "warn", "error", "trace",
      "isDebugEnabled", "isInfoEnabled", "isWarnEnabled", "isErrorEnabled", "isTraceEnabled",
    ];
    for (const m of stdlibMethods) {
      const source = `import org.springframework.stereotype.Service;
@Service
class T${m} {
    public void run() {
        obj.${m}();
        doBusinessThing();
    }
}
`;
      const cs = parseJava(`/x/T${m}.java`, `T${m}.java`, source);
      const callees = cs[0]?.hints.callees ?? [];
      expect(callees, `${m} should be filtered from callees`).not.toContain(m);
      // Sanity: the business call still surfaces, proving the test fixture is exercising the filter (not a parser miss).
      expect(callees, `${m} fixture should still surface doBusinessThing`).toContain("doBusinessThing");
    }
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

  it("skips static methods on @RestController classes (Spring cannot dispatch to static methods)", () => {
    const source = `package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }

    @GetMapping("/helper")
    public static String staticHelper() { return "nope"; }

    public static UserController of(UserService s) { return new UserController(s); }
}
`;
    const candidates = parseJava(
      "/x/UserController.java",
      "UserController.java",
      source,
    );
    const names = candidates.map((c) => c.name);
    expect(names).toEqual(["UserController.list"]);
    expect(names).not.toContain("UserController.staticHelper");
    expect(names).not.toContain("UserController.of");
  });
});

// ---- Spring Data repository extraction (databaseTables) -----------------

describe("parseJava: JPA repository databaseTables hints", () => {
  it("extracts a single model from an injected repository call", () => {
    const source = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/users")
public class UserController {
    private final UserRepository userRepository;

    @GetMapping("/{id}")
    public User get(Long id) {
        return userRepository.findById(id).orElseThrow();
    }
}
`;
    const cs = parseJava("/x/UserController.java", "UserController.java", source);
    expect(cs).toHaveLength(1);
    expect(cs[0]?.hints.databaseTables).toEqual(["User"]);
  });

  it("extracts multiple distinct models from a single method", () => {
    const source = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/orders")
public class OrderController {
    @PostMapping
    public Order place(OrderRequest req) {
        User user = userRepository.findById(req.getUserId()).orElseThrow();
        Product product = productRepository.findById(req.getProductId()).orElseThrow();
        return orderRepository.save(new Order(user, product));
    }
}
`;
    const cs = parseJava("/x/OrderController.java", "OrderController.java", source);
    expect(cs).toHaveLength(1);
    expect(cs[0]?.hints.databaseTables).toEqual(
      expect.arrayContaining(["User", "Product", "Order"]),
    );
    expect(cs[0]?.hints.databaseTables).toHaveLength(3);
  });

  it("deduplicates repeated calls to the same repository", () => {
    const source = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class ArticleController {
    @GetMapping("/articles/{id}")
    public Article get(Long id) {
        Article article = articleRepository.findById(id).orElseThrow();
        articleRepository.incrementViewCount(id);
        return article;
    }
}
`;
    const cs = parseJava("/x/ArticleController.java", "ArticleController.java", source);
    expect(cs[0]?.hints.databaseTables).toEqual(["Article"]);
  });

  it("handles this.repository prefix (constructor injection style)", () => {
    const source = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class PostController {
    @GetMapping("/posts")
    public List<Post> list() {
        return this.postRepository.findAll();
    }
}
`;
    const cs = parseJava("/x/PostController.java", "PostController.java", source);
    expect(cs[0]?.hints.databaseTables).toEqual(["Post"]);
  });

  it("leaves databaseTables undefined when no repository call is present", () => {
    const source = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class PingController {
    @GetMapping("/ping")
    public String ping() { return "pong"; }
}
`;
    const cs = parseJava("/x/PingController.java", "PingController.java", source);
    expect(cs[0]?.hints.databaseTables).toBeUndefined();
  });
});

// ---- Side-effect notes (email, HTTP, events, messaging) ------------------

describe("parseJava: side-effect notes", () => {
  it("surfaces email note when JavaMailSender is referenced", () => {
    const source = `package com.example;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.web.bind.annotation.*;

@RestController
public class NotifyController {
    private final JavaMailSender mailSender;
    public NotifyController(JavaMailSender mailSender) { this.mailSender = mailSender; }

    @PostMapping("/notify")
    public String notify() {
        SimpleMailMessage msg = new SimpleMailMessage();
        msg.setTo("user@example.com");
        mailSender.send(msg);
        return "sent";
    }
}
`;
    const cs = parseJava("/x/NotifyController.java", "NotifyController.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Sends email")).toBe(true);
  });

  it("surfaces HTTP note when RestTemplate is referenced", () => {
    const source = `package com.example;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.bind.annotation.*;

@RestController
public class ProxyController {
    private final RestTemplate restTemplate;
    public ProxyController(RestTemplate restTemplate) { this.restTemplate = restTemplate; }

    @GetMapping("/proxy")
    public String proxy() {
        return restTemplate.getForObject("https://api.example.com/data", String.class);
    }
}
`;
    const cs = parseJava("/x/ProxyController.java", "ProxyController.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Makes outbound HTTP request")).toBe(true);
  });

  it("surfaces Spring event note when publishEvent is called", () => {
    const source = `package com.example;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.web.bind.annotation.*;

@RestController
public class OrderController {
    private final ApplicationEventPublisher publisher;
    public OrderController(ApplicationEventPublisher publisher) { this.publisher = publisher; }

    @PostMapping("/orders")
    public String create() {
        publisher.publishEvent(new OrderCreatedEvent());
        return "ok";
    }
}
`;
    const cs = parseJava("/x/OrderController.java", "OrderController.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Publishes Spring application event")).toBe(true);
  });

  it("surfaces broker note when KafkaTemplate is used", () => {
    const source = `package com.example;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.web.bind.annotation.*;

@RestController
public class EventController {
    private final KafkaTemplate<String, String> kafka;
    public EventController(KafkaTemplate<String, String> kafka) { this.kafka = kafka; }

    @PostMapping("/publish")
    public String publish(@RequestBody String payload) {
        kafka.send("events", payload);
        return "ok";
    }
}
`;
    const cs = parseJava("/x/EventController.java", "EventController.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Sends message to broker (JMS, AMQP, or Kafka)")).toBe(true);
  });

  it("does not add side-effect notes for a plain controller", () => {
    const source = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class PingController {
    @GetMapping("/ping")
    public String ping() { return "pong"; }
}
`;
    const cs = parseJava("/x/PingController.java", "PingController.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.every((n) =>
      !n.includes("email") && !n.includes("HTTP") && !n.includes("event") && !n.includes("broker"),
    )).toBe(true);
  });
});

// ---- Side-effect note coverage (defensive per-alternative pins) ----------
//
// The 4 side-effect regexes at java.ts:271/275/279-281/285 collectively
// enumerate ~24 alternatives (6 email + 7 HTTP + 3 event branches + 7
// broker). The existing 5 side-effect tests above cover only one or two
// alternatives per regex; the remainder is undefended. A refactor that
// silently drops a single alternative (e.g. removing "WebClient" from the
// HTTP alternation, or "JmsTemplate" from the broker alternation) would
// degrade the load-bearing BLAST RADIUS / Notes signal for any controller
// using ONLY that alternative -- a real customer mis-generation regression
// decoupled from any test surface.
//
// and the Ruby AR_CLASS_METHODS pin at ruby.test.ts (ce63ba4): one it-block
// per regex with a for-loop over the alternatives, each fixture isolated so
// only that one alternative appears in methodSource. Each alternative
// embedded in a string literal so the fixture stays parser-clean regardless
// of whether the identifier is a Java type, field, or arbitrary token --
// the regex matches at byte boundaries (\b is character-class-based), so a
// string-literal embedding is equivalent to a bare reference for matching.

describe("parseJava: side-effect notes (per-alternative coverage)", () => {
  const buildFixture = (token: string) => `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class TestCtl {
    @GetMapping("/x")
    public String x() {
        String marker = "${token}";
        return marker;
    }
}
`;

  it("email regex covers all 7 alternatives (type names + DI field names)", () => {
    const alts = [
      // Spring mail type names
      "JavaMailSender",
      "SimpleMailMessage",
      "MimeMessage",
      "MimeMessageHelper",
      // camelCase DI field names (type hidden by constructor injection)
      "mailSender",       // Spring docs default field name
      "javaMailSender",   // matches Spring Boot auto-configured bean name
      "emailSender",      // common Spring Boot developer preference
    ];
    for (const alt of alts) {
      const cs = parseJava("/x/TestCtl.java", "TestCtl.java", buildFixture(alt));
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${alt} should emit "Sends email"`).toContain("Sends email");
    }
  });

  it("HTTP regex covers all 13 alternatives (Spring, Java 11, OkHttp, Apache HttpClient)", () => {
    // Pins every alternative in the HTTP detection OR-group. Each fixture
    // injects exactly one token; a regression that drops an alternative fails
    // the corresponding labeled expectation and names the missing token. Count
    // went from 7 to 13 when OkHttp (OkHttpClient / okHttpClient), Apache
    // HttpClient (CloseableHttpClient / HttpClientBuilder / closeableHttpClient),
    // and the Java 11 HttpClient type name were added for legacy Java shops.
    const alts = [
      // Spring family
      "RestTemplate",
      "WebClient",
      "FeignClient",
      "restTemplate",
      "webClient",
      "feignClient",
      // Java 11 HttpClient (type name + field name)
      "HttpClient",
      "httpClient",
      // OkHttp (square/okhttp, popular in Android-adjacent Java backends)
      "OkHttpClient",
      "okHttpClient",
      // Apache HttpClient (legacy Java shops, still common in pre-Spring-5 code)
      "CloseableHttpClient",
      "HttpClientBuilder",
      "closeableHttpClient",
    ];
    for (const alt of alts) {
      const cs = parseJava("/x/TestCtl.java", "TestCtl.java", buildFixture(alt));
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${alt} should emit "Makes outbound HTTP request"`).toContain("Makes outbound HTTP request");
    }
  });

  it("Spring event branches cover all 3 patterns (method call + 2 token casings)", () => {
    // Three independent OR branches: .publishEvent( method call,
    // PascalCase ApplicationEventPublisher, camelCase
    // applicationEventPublisher. Each fixture isolates exactly one
    // branch: branch 1's "publisher.publishEvent(null)" token matches
    // only the .publishEvent( regex (regex is case-sensitive, the bare
    // word "publisher" doesn't collide with the Pascal/camel variants of
    // applicationEventPublisher).
    const probes = [
      { token: "publisher.publishEvent(null)", label: ".publishEvent(" },
      { token: "ApplicationEventPublisher", label: "ApplicationEventPublisher" },
      { token: "applicationEventPublisher", label: "applicationEventPublisher" },
    ];
    for (const { token, label } of probes) {
      const cs = parseJava("/x/TestCtl.java", "TestCtl.java", buildFixture(token));
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${label} should emit "Publishes Spring application event"`).toContain(
        "Publishes Spring application event",
      );
    }
  });

  it("broker regex covers all 7 alternatives", () => {
    const alts = [
      "JmsTemplate",
      "RabbitTemplate",
      "KafkaTemplate",
      "jmsTemplate",
      "rabbitTemplate",
      "kafkaTemplate",
      "kafka",
    ];
    for (const alt of alts) {
      const cs = parseJava("/x/TestCtl.java", "TestCtl.java", buildFixture(alt));
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${alt} should emit broker note`).toContain(
        "Sends message to broker (JMS, AMQP, or Kafka)",
      );
    }
  });

  it("filesystem note fires for java.nio.Files mutators", () => {
    const source = `package com.example;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.web.bind.annotation.*;

@RestController
public class ExportController {
    @PostMapping("/export")
    public String export() throws Exception {
        Files.write(Path.of("/tmp/report.csv"), buildCsv().getBytes());
        return "ok";
    }
    String buildCsv() { return ""; }
}
`;
    const cs = parseJava("/x/E.java", "E.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Writes to file system");
  });

  it("filesystem note fires for FileWriter and other java.io writer streams", () => {
    const source = `package com.example;
import java.io.FileWriter;
import org.springframework.web.bind.annotation.*;

@RestController
public class LogController {
    @PostMapping("/log")
    public void appendLog(String entry) throws Exception {
        try (FileWriter w = new FileWriter("/var/log/app.log", true)) {
            w.write(entry);
        }
    }
}
`;
    const cs = parseJava("/x/L.java", "L.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Writes to file system");
  });

  it("filesystem note fires for Spring multipart upload (MultipartFile.transferTo)", () => {
    const source = `package com.example;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import java.io.File;

@RestController
public class UploadController {
    @PostMapping("/upload")
    public String upload(@RequestParam("file") MultipartFile file) throws Exception {
        file.transferTo(new File("/uploads/" + file.getOriginalFilename()));
        return "ok";
    }
}
`;
    const cs = parseJava("/x/U.java", "U.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Writes to file system");
  });

  it("filesystem note does NOT fire for read-only file operations", () => {
    const source = `package com.example;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileReader;
import org.springframework.web.bind.annotation.*;

@RestController
public class ImportController {
    @GetMapping("/import")
    public String load() throws Exception {
        byte[] data = Files.readAllBytes(Path.of("/tmp/in.csv"));
        FileReader r = new FileReader("/tmp/other.csv");
        return new String(data);
    }
}
`;
    const cs = parseJava("/x/I.java", "I.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Writes to file system")).toBe(false);
  });

  it("Files.X mutator regex covers all 9 alternatives", () => {
    // Each Files.X mutator is independently pinned so a regression
    // narrowing the alternation list names the broken method.
    const mutators = [
      "write", "delete", "deleteIfExists", "move", "copy",
      "createDirectories", "createDirectory", "createFile",
      "createTempFile", "createTempDirectory",
    ];
    for (const m of mutators) {
      const source = `package com.example;
import java.nio.file.Files;
import org.springframework.web.bind.annotation.*;

@RestController
public class T${m} {
    @PostMapping("/op")
    public void op() throws Exception {
        Files.${m}(arg);
    }
}
`;
      const cs = parseJava(`/x/T${m}.java`, `T${m}.java`, source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `Files.${m} should emit filesystem note`).toContain("Writes to file system");
    }
  });

  it("writer/stream regex covers all 5 java.io writer types", () => {
    const writerTypes = [
      "FileWriter", "FileOutputStream", "BufferedWriter", "PrintWriter", "OutputStreamWriter",
    ];
    for (const w of writerTypes) {
      const source = `package com.example;
import java.io.${w};
import org.springframework.web.bind.annotation.*;

@RestController
public class T_${w} {
    @PostMapping("/op")
    public void op() throws Exception {
        ${w} writer = null;
    }
}
`;
      const cs = parseJava(`/x/T_${w}.java`, `T_${w}.java`, source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${w} should emit filesystem note`).toContain("Writes to file system");
    }
  });

  it("transaction note fires for method-level @Transactional", () => {
    const source = `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrderService {
    @Transactional
    public void placeOrder(Long userId) {
        // ... mutate orders + line_items + inventory atomically
    }
}
`;
    const cs = parseJava("/x/OrderService.java", "OrderService.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes within a database transaction (@Transactional)");
  });

  it("transaction note fires for class-level @Transactional (applies to all methods)", () => {
    const source = `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional
public class CheckoutService {
    public void checkout(Long cartId) {
        // class-level @Transactional applies
    }
    public void refund(Long orderId) {
        // class-level @Transactional applies here too
    }
}
`;
    const cs = parseJava("/x/CheckoutService.java", "CheckoutService.java", source);
    expect(cs).toHaveLength(2);
    for (const candidate of cs) {
      const notes = candidate.hints.notes ?? [];
      expect(notes, `${candidate.name} should emit @Transactional note`).toContain(
        "Executes within a database transaction (@Transactional)",
      );
    }
  });

  it("transaction note fires for Java EE @TransactionAttribute", () => {
    const source = `package com.example;
import javax.ejb.Stateless;
import javax.ejb.TransactionAttribute;
import javax.ejb.TransactionAttributeType;

@Stateless
public class InvoiceBean {
    @TransactionAttribute(TransactionAttributeType.REQUIRED)
    public void issueInvoice(Long orderId) { }
}
`;
    const cs = parseJava("/x/InvoiceBean.java", "InvoiceBean.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes within a database transaction (@Transactional)");
  });

  it("transaction note does NOT fire for plain non-transactional methods", () => {
    const source = `package com.example;
import org.springframework.stereotype.Service;

@Service
public class PingService {
    public String ping() { return "pong"; }
}
`;
    const cs = parseJava("/x/P.java", "P.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n.includes("transaction"))).toBe(false);
  });

  it("JAVA_TRANSACTION_ANNOTATIONS covers all 2 alternatives", () => {
    const variants = ["Transactional", "TransactionAttribute"];
    for (const v of variants) {
      const source = `package com.example;
import org.springframework.stereotype.Service;
@Service
public class T_${v} {
    @${v}
    public void op() { }
}
`;
      const cs = parseJava(`/x/T_${v}.java`, `T_${v}.java`, source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `@${v} should emit transaction note`).toContain(
        "Executes within a database transaction (@Transactional)",
      );
    }
  });

  it("transaction note fires for programmatic TransactionTemplate.execute", () => {
    const source = `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class OrderService {
    private final TransactionTemplate transactionTemplate;

    public void processOrder(Order order) {
        transactionTemplate.execute(status -> {
            orderRepo.save(order);
            inventoryService.reserve(order.getItems());
            return null;
        });
    }
}
`;
    const cs = parseJava("/x/OrderService.java", "OrderService.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes within a database transaction (TransactionTemplate)");
  });

  it("transaction note fires for PlatformTransactionManager (type visible in method body)", () => {
    // PlatformTransactionManager is the lower-level Spring transaction API.
    // Detected when the type name appears as a local variable or parameter
    // type inside the method (e.g., fetched from context, or passed in).
    const source = `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.DefaultTransactionDefinition;

@Service
public class LegacyService {
    private final ApplicationContext ctx;

    public void transfer(long from, long to, long amount) {
        PlatformTransactionManager txManager = ctx.getBean(PlatformTransactionManager.class);
        TransactionStatus status = txManager.getTransaction(new DefaultTransactionDefinition());
        try {
            debitAccount(from, amount);
            creditAccount(to, amount);
            txManager.commit(status);
        } catch (Exception e) {
            txManager.rollback(status);
            throw e;
        }
    }
}
`;
    const cs = parseJava("/x/LegacyService.java", "LegacyService.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes within a database transaction (TransactionTemplate)");
  });

  it("cache-mutation note fires for @CacheEvict", () => {
    const source = `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.cache.annotation.CacheEvict;

@Service
public class UserService {
    @CacheEvict(value = "users", allEntries = true)
    public void rebuild() {
        // ...
    }
}
`;
    const cs = parseJava("/x/U.java", "U.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Mutates application cache (@CacheEvict / @CachePut)");
  });

  it("cache-mutation note fires for @CachePut", () => {
    const source = `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.cache.annotation.CachePut;

@Service
public class ProductService {
    @CachePut(value = "products", key = "#p.id")
    public Product save(Product p) {
        return p;
    }
}
`;
    const cs = parseJava("/x/P.java", "P.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Mutates application cache (@CacheEvict / @CachePut)");
  });

  it("cache-mutation note does NOT fire for @Cacheable (read-on-miss only)", () => {
    // @Cacheable only writes on cache miss (read-through pattern). Low blast
    // radius compared to @CacheEvict / @CachePut. Intentionally excluded so
    // the note doesn't dilute compliance signal.
    const source = `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.cache.annotation.Cacheable;

@Service
public class ReadOnlyService {
    @Cacheable("users")
    public User findById(Long id) {
        return null;
    }
}
`;
    const cs = parseJava("/x/R.java", "R.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n.includes("cache"))).toBe(false);
  });

  it("JAVA_CACHE_MUTATION_ANNOTATIONS covers all 2 alternatives", () => {
    const variants = ["CacheEvict", "CachePut"];
    for (const v of variants) {
      const source = `package com.example;
import org.springframework.stereotype.Service;
@Service
public class T_${v} {
    @${v}("x")
    public void op() { }
}
`;
      const cs = parseJava(`/x/T_${v}.java`, `T_${v}.java`, source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `@${v} should emit cache-mutation note`).toContain(
        "Mutates application cache (@CacheEvict / @CachePut)",
      );
    }
  });

  it("process-execution note fires for Runtime.getRuntime().exec(...)", () => {
    const source = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class PdfController {
    @PostMapping("/render")
    public byte[] render(String html) throws Exception {
        Process p = Runtime.getRuntime().exec(new String[]{"wkhtmltopdf", "-", "-"});
        return p.getInputStream().readAllBytes();
    }
}
`;
    const cs = parseJava("/x/P.java", "P.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes external process");
  });

  it("process-execution note fires for ProcessBuilder", () => {
    const source = `package com.example;
import org.springframework.web.bind.annotation.*;
import java.io.File;

@RestController
public class ConvertController {
    @PostMapping("/convert")
    public String convert() throws Exception {
        ProcessBuilder pb = new ProcessBuilder("ffmpeg", "-i", "in.mp4", "out.mp3");
        pb.redirectErrorStream(true);
        pb.start();
        return "ok";
    }
}
`;
    const cs = parseJava("/x/C.java", "C.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes external process");
  });

  it("process-execution note does NOT fire for ProcessHandle introspection or plain controllers", () => {
    // ProcessHandle.current() inspects the JVM's own process; it does NOT
    // spawn anything. Should stay out of the side-effect list.
    const source = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class PingController {
    @GetMapping("/pid")
    public long pid() {
        return ProcessHandle.current().pid();
    }

    @GetMapping("/ping")
    public String ping() {
        return "pong";
    }
}
`;
    const cs = parseJava("/x/P.java", "P.java", source);
    for (const candidate of cs) {
      const notes = candidate.hints.notes ?? [];
      expect(notes.some((n) => n === "Executes external process")).toBe(false);
    }
  });
});

describe("parseJava: background-job notes (@Async / TaskExecutor / CompletableFuture)", () => {
  // Spring Boot and Java 8+ offer three canonical fire-and-forget patterns;
  // all three are audit-critical because downstream effects happen in a worker
  // (BackgroundJob.Enqueue), Ruby ActiveJob (perform_later / perform_async),
  // and Django Celery (.delay / .apply_async).

  it("surfaces background-job note for @Async-annotated method", () => {
    const source = `package com.example;
import org.springframework.scheduling.annotation.Async;
import org.springframework.web.bind.annotation.*;

@RestController
public class ReportController {
    @Async
    @PostMapping("/reports")
    public void generateReport(String id) {
        buildReport(id);
    }
    void buildReport(String id) {}
}
`;
    const cs = parseJava("/x/R.java", "R.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Enqueues background job");
  });

  it("surfaces background-job note for CompletableFuture.runAsync dispatch", () => {
    const source = `package com.example;
import java.util.concurrent.CompletableFuture;
import org.springframework.web.bind.annotation.*;

@RestController
public class ExportController {
    @PostMapping("/export")
    public String export() {
        CompletableFuture.runAsync(() -> buildAndUploadReport());
        return "accepted";
    }
    void buildAndUploadReport() {}
}
`;
    const cs = parseJava("/x/E.java", "E.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Enqueues background job");
  });

  it("surfaces background-job note for CompletableFuture.supplyAsync dispatch", () => {
    const source = `package com.example;
import java.util.concurrent.CompletableFuture;
import org.springframework.web.bind.annotation.*;

@RestController
public class PricingController {
    @GetMapping("/price")
    public CompletableFuture<String> price() {
        return CompletableFuture.supplyAsync(() -> fetchPrice());
    }
    String fetchPrice() { return ""; }
}
`;
    const cs = parseJava("/x/P.java", "P.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Enqueues background job");
  });

  it("surfaces background-job note for TaskExecutor.execute dispatch", () => {
    const source = `package com.example;
import org.springframework.core.task.TaskExecutor;
import org.springframework.web.bind.annotation.*;

@RestController
public class JobController {
    private final TaskExecutor taskExecutor;

    @PostMapping("/jobs")
    public String enqueue() {
        taskExecutor.execute(() -> runBatchJob());
        return "queued";
    }
    void runBatchJob() {}
}
`;
    const cs = parseJava("/x/J.java", "J.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Enqueues background job");
  });

  it("pins all three detection alternatives in isolation", () => {
    const probes = [
      {
        label: "@Async annotation",
        source: `package com.example;
import org.springframework.scheduling.annotation.Async;
@org.springframework.web.bind.annotation.RestController
public class C {
    @Async @org.springframework.web.bind.annotation.PostMapping("/x")
    public void go() { doWork(); }
    void doWork() {}
}`,
      },
      {
        label: "CompletableFuture.runAsync",
        source: `package com.example;
import java.util.concurrent.CompletableFuture;
@org.springframework.web.bind.annotation.RestController
public class C {
    @org.springframework.web.bind.annotation.PostMapping("/x")
    public String go() { CompletableFuture.runAsync(() -> work()); return "ok"; }
    void work() {}
}`,
      },
      {
        label: "CompletableFuture.supplyAsync",
        source: `package com.example;
import java.util.concurrent.CompletableFuture;
@org.springframework.web.bind.annotation.RestController
public class C {
    @org.springframework.web.bind.annotation.GetMapping("/x")
    public CompletableFuture<String> go() { return CompletableFuture.supplyAsync(() -> "v"); }
}`,
      },
      {
        label: "taskExecutor.execute",
        source: `package com.example;
import org.springframework.core.task.TaskExecutor;
@org.springframework.web.bind.annotation.RestController
public class C {
    private final TaskExecutor taskExecutor;
    @org.springframework.web.bind.annotation.PostMapping("/x")
    public String go() { taskExecutor.execute(() -> run()); return "ok"; }
    void run() {}
}`,
      },
    ];
    for (const { label, source } of probes) {
      const cs = parseJava("/x/C.java", "C.java", source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${label} should emit background-job note`).toContain(
        "Enqueues background job",
      );
    }
  });

  it("does NOT surface background-job note when no async dispatch is present", () => {
    const source = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class PingController {
    @GetMapping("/ping")
    public String ping() {
        return "pong";
    }
}
`;
    const cs = parseJava("/x/P.java", "P.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Enqueues background job")).toBe(false);
  });
});

describe("parseJava: stored procedure notes (JPA / JDBC / SimpleJdbcCall)", () => {
  // Stored procs may have side effects invisible in the Java code (triggers,
  // cross-table writes, audit logging in the DB layer), so compliance readers
  // need them surfaced as business rules. Mirrors CFML's <cfstoredproc> note

  it("surfaces stored-procedure note for JPA EntityManager.createStoredProcedureQuery", () => {
    const source = `package com.example;
import jakarta.persistence.EntityManager;
import jakarta.persistence.StoredProcedureQuery;
import org.springframework.web.bind.annotation.*;

@RestController
public class ReportController {
    private final EntityManager em;

    @PostMapping("/reports/{id}")
    public String run(@PathVariable Long id) {
        StoredProcedureQuery q = em.createStoredProcedureQuery("sp_GenerateReport");
        q.registerStoredProcedureParameter(1, Long.class, ParameterMode.IN);
        q.setParameter(1, id);
        q.execute();
        return "ok";
    }
}
`;
    const cs = parseJava("/x/R.java", "R.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Calls stored procedure");
  });

  it("surfaces stored-procedure note for JDBC Connection.prepareCall", () => {
    const source = `package com.example;
import java.sql.CallableStatement;
import java.sql.Connection;
import org.springframework.web.bind.annotation.*;

@RestController
public class OrderController {
    private final Connection conn;

    @PostMapping("/orders/fulfill")
    public String fulfill(Long orderId) throws Exception {
        try (CallableStatement cs = conn.prepareCall("{ call sp_FulfillOrder(?) }")) {
            cs.setLong(1, orderId);
            cs.execute();
        }
        return "ok";
    }
}
`;
    const cs = parseJava("/x/O.java", "O.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Calls stored procedure");
  });

  it("surfaces stored-procedure note for Spring SimpleJdbcCall", () => {
    const source = `package com.example;
import org.springframework.jdbc.core.simple.SimpleJdbcCall;
import org.springframework.web.bind.annotation.*;
import javax.sql.DataSource;
import java.util.Map;

@RestController
public class CleanupController {
    private final DataSource ds;

    @PostMapping("/cleanup")
    public String run() {
        SimpleJdbcCall call = new SimpleJdbcCall(ds).withProcedureName("sp_PurgeExpiredSessions");
        Map<String, Object> result = call.execute();
        return "ok";
    }
}
`;
    const cs = parseJava("/x/C.java", "C.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Calls stored procedure");
  });

  it("pins all three detection alternatives in isolation", () => {
    const probes = [
      {
        label: "createStoredProcedureQuery (JPA)",
        body: `em.createStoredProcedureQuery("sp_x").execute();`,
      },
      {
        label: "prepareCall (JDBC)",
        body: `conn.prepareCall("{ call sp_x(?) }").execute();`,
      },
      {
        label: "SimpleJdbcCall (Spring)",
        body: `new SimpleJdbcCall(ds).withProcedureName("sp_x").execute();`,
      },
    ];
    for (const { label, body } of probes) {
      const source = `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class C {
    @PostMapping("/x")
    public String go() throws Exception { ${body} return "ok"; }
}`;
      const cs = parseJava("/x/C.java", "C.java", source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${label} should emit stored-procedure note`).toContain(
        "Calls stored procedure",
      );
    }
  });

  it("does NOT surface stored-procedure note for plain SQL queries", () => {
    const source = `package com.example;
import jakarta.persistence.EntityManager;
import org.springframework.web.bind.annotation.*;

@RestController
public class ProductController {
    private final EntityManager em;

    @GetMapping("/products")
    public String list() {
        return em.createQuery("SELECT p FROM Product p").getResultList().toString();
    }
}
`;
    const cs = parseJava("/x/P.java", "P.java", source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Calls stored procedure")).toBe(false);
  });
});
