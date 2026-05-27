import { describe, it, expect } from "vitest";
import { parseDjango } from "./django.js";

function names(source: string, file = "views.py"): string[] {
  return parseDjango(`/app/${file}`, `app/${file}`, source).map((c) => c.name);
}

function candidates(source: string, file = "views.py") {
  return parseDjango(`/app/${file}`, `app/${file}`, source);
}

// ---- File gate -----------------------------------------------------------

describe("parseDjango: file gate", () => {
  const source = "def index(request):\n    return render(request, 'index.html')\n";

  it("parses views.py", () => {
    expect(candidates(source, "views.py")).toHaveLength(1);
  });

  it("parses *_views.py variants", () => {
    expect(candidates(source, "user_views.py")).toHaveLength(1);
    expect(candidates(source, "api_views.py")).toHaveLength(1);
  });

  it("parses files inside a views/ directory", () => {
    const result = parseDjango("/app/views/users.py", "app/views/users.py", source);
    expect(result).toHaveLength(1);
  });

  it("parses files inside nested views/ sub-packages (API versioning, domain grouping)", () => {
    // Django apps commonly group views under `views/api/v1.py` or `views/admin/users.py`;
    // the original gate matched only depth-1 under views/.
    const apiV1 = parseDjango("/app/views/api/v1.py", "app/views/api/v1.py", source);
    expect(apiV1).toHaveLength(1);
    const adminUsers = parseDjango(
      "/app/views/admin/users.py",
      "app/views/admin/users.py",
      source,
    );
    expect(adminUsers).toHaveLength(1);
    const deep = parseDjango(
      "/myproj/app/views/api/posts/list.py",
      "myproj/app/views/api/posts/list.py",
      source,
    );
    expect(deep).toHaveLength(1);
  });

  it("does NOT pick up look-alike directories without a literal /views/ segment", () => {
    // `subviews/` and `overviews/` are not Django views packages; the gate must
    // require a literal `views` path segment, not just the substring.
    expect(
      parseDjango("/app/subviews/foo.py", "app/subviews/foo.py", source),
    ).toHaveLength(0);
    expect(
      parseDjango("/app/overviews/foo.py", "app/overviews/foo.py", source),
    ).toHaveLength(0);
  });

  it("skips non-view files", () => {
    expect(candidates(source, "models.py")).toHaveLength(0);
    expect(candidates(source, "urls.py")).toHaveLength(0);
    expect(candidates(source, "forms.py")).toHaveLength(0);
    expect(candidates(source, "serializers.py")).toHaveLength(0);
    expect(candidates(source, "admin.py")).toHaveLength(0);
  });

  it("matches the basename case-insensitively (parity with the dispatcher)", () => {
    // parsers/index.ts dispatches on path.extname(...).toLowerCase(), so a
    // Windows-origin file like Views.PY routes through to parseDjango. The
    // basename gate must accept the same set or the file silently drops.
    expect(candidates(source, "Views.PY")).toHaveLength(1);
    expect(candidates(source, "views.PY")).toHaveLength(1);
    expect(candidates(source, "User_Views.PY")).toHaveLength(1);
    // The `/views/` path-segment branch must also tolerate uppercased segments
    // and extensions (case-insensitive filesystems on macOS / Windows).
    expect(
      parseDjango("/app/Views/users.PY", "app/Views/users.PY", source),
    ).toHaveLength(1);
    // Sanity: look-alike directories still must not match even when uppercased.
    expect(
      parseDjango("/app/Subviews/foo.PY", "app/Subviews/foo.PY", source),
    ).toHaveLength(0);
  });
});

// ---- Function-based views (FBVs) -----------------------------------------

describe("parseDjango: function-based views", () => {
  const SOURCE = `
from django.shortcuts import render

def index(request):
    return render(request, 'index.html')

def user_detail(request, pk):
    user = User.objects.get(pk=pk)
    return render(request, 'detail.html', {'user': user})

def helper(x, y):
    return x + y

def _private_view(request):
    pass
`;

  it("surfaces FBVs whose first param is 'request'", () => {
    const ns = names(SOURCE);
    expect(ns).toContain("index");
    expect(ns).toContain("user_detail");
  });

  it("does NOT surface functions without a 'request' first param", () => {
    const ns = names(SOURCE);
    expect(ns).not.toContain("helper");
  });

  it("does NOT surface private views (underscore prefix)", () => {
    const ns = names(SOURCE);
    expect(ns).not.toContain("_private_view");
  });

  it("assigns kind='django-view' to FBVs", () => {
    const cs = candidates(SOURCE);
    const index = cs.find((c) => c.name === "index")!;
    expect(index.kind).toBe("django-view");
  });

  it("sets language='python' on FBV candidates", () => {
    const cs = candidates(SOURCE);
    for (const c of cs) {
      expect(c.language).toBe("python");
    }
  });

  it("does NOT add httpRoute hints to FBVs (URL unknown without urls.py)", () => {
    const cs = candidates(SOURCE);
    const index = cs.find((c) => c.name === "index")!;
    expect(index.hints.httpRoute).toBeUndefined();
  });

  it("includes decorator lines in FBV source and lineStart", () => {
    const source = `
@login_required
@permission_required('app.view_user')
def protected_view(request):
    return render(request, 'protected.html')
`;
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.source).toContain("@login_required");
    expect(cs[0]!.source).toContain("@permission_required");
    expect(cs[0]!.source).toContain("def protected_view");
  });
});

// ---- FBV first-param matching --------------------------------------------

describe("parseDjango: FBV first-param matching", () => {
  it("rejects look-alike names that merely start with 'request'", () => {
    // `request_id` previously slipped through a `startsWith("request")` check
    // and surfaced this helper as a fake FBV.
    const source = `
def get_user(request_id, user_id):
    return User.objects.get(pk=user_id)

def list_requests(filter):
    return Request.objects.filter(filter)
`;
    const ns = names(source);
    expect(ns).not.toContain("get_user");
    expect(ns).not.toContain("list_requests");
  });

  it("accepts type-annotated request param", () => {
    const source = `
def index(request: HttpRequest):
    return render(request, 'index.html')
`;
    expect(names(source)).toContain("index");
  });

  it("accepts request param with default value", () => {
    const source = `
def index(request=None):
    pass
`;
    expect(names(source)).toContain("index");
  });

  it("rejects functions with no parameters", () => {
    const source = `
def helper():
    return 42
`;
    expect(names(source)).not.toContain("helper");
  });
});

// ---- Class-based views (CBVs) --------------------------------------------

describe("parseDjango: class-based views", () => {
  const SOURCE = `
from django.views import View
from django.views.generic import ListView, DetailView

class UserListView(ListView):
    model = User
    template_name = 'users/list.html'

    def get(self, request):
        users = User.objects.all()
        return render(request, self.template_name, {'users': users})

    def post(self, request):
        pass

class UserDetailView(DetailView):
    model = User

    def get(self, request, pk):
        user = User.objects.get(pk=pk)
        return render(request, 'detail.html', {'user': user})

    def _internal(self):
        pass

class NotAView:
    def get(self, request):
        pass
`;

  it("surfaces HTTP verb methods on known view bases", () => {
    const ns = names(SOURCE);
    expect(ns).toContain("UserListView#get");
    expect(ns).toContain("UserListView#post");
    expect(ns).toContain("UserDetailView#get");
  });

  it("does NOT surface methods from non-view classes", () => {
    const ns = names(SOURCE);
    expect(ns).not.toContain("NotAView#get");
  });

  it("does NOT surface private methods inside view classes", () => {
    const ns = names(SOURCE);
    expect(ns).not.toContain("UserDetailView#_internal");
  });

  it("adds HTTP route hints to CBV verb methods", () => {
    const cs = candidates(SOURCE);
    const get = cs.find((c) => c.name === "UserListView#get")!;
    expect(get.hints.httpRoute?.method).toBe("GET");
    const post = cs.find((c) => c.name === "UserListView#post")!;
    expect(post.hints.httpRoute?.method).toBe("POST");
  });

  it("assigns kind='django-view' to CBV methods", () => {
    const cs = candidates(SOURCE);
    for (const c of cs) {
      expect(c.kind).toBe("django-view");
    }
  });

  it("handles classes inheriting from qualified names (views.View)", () => {
    const source = `
class MyView(views.View):
    def get(self, request):
        return render(request, 'my.html')
`;
    const ns = names(source);
    expect(ns).toContain("MyView#get");
  });

  it("handles project-local base classes ending in 'View'", () => {
    const source = `
class OrderView(BaseView):
    def post(self, request):
        pass
`;
    const ns = names(source);
    expect(ns).toContain("OrderView#post");
  });

  it("handles multiple inheritance with at least one view base", () => {
    const source = `
class AdminUserView(LoginRequiredMixin, View):
    def get(self, request):
        pass
    def delete(self, request, pk):
        pass
`;
    const ns = names(source);
    expect(ns).toContain("AdminUserView#get");
    expect(ns).toContain("AdminUserView#delete");
  });
});

// ---- DRF ViewSets --------------------------------------------------------

describe("parseDjango: DRF ViewSet actions", () => {
  const SOURCE = `
from rest_framework.viewsets import ModelViewSet

class UserViewSet(ModelViewSet):
    queryset = User.objects.all()
    serializer_class = UserSerializer

    def list(self, request):
        return super().list(request)

    def retrieve(self, request, pk=None):
        return super().retrieve(request, pk=pk)

    def create(self, request):
        return super().create(request)

    def update(self, request, pk=None):
        return super().update(request, pk=pk)

    def partial_update(self, request, pk=None):
        return super().partial_update(request, pk=pk)

    def destroy(self, request, pk=None):
        return super().destroy(request, pk=pk)

    def custom_action(self, request):
        pass
`;

  it("surfaces all 6 DRF standard actions", () => {
    const ns = names(SOURCE);
    expect(ns).toContain("UserViewSet#list");
    expect(ns).toContain("UserViewSet#retrieve");
    expect(ns).toContain("UserViewSet#create");
    expect(ns).toContain("UserViewSet#update");
    expect(ns).toContain("UserViewSet#partial_update");
    expect(ns).toContain("UserViewSet#destroy");
  });

  it("does NOT surface non-standard actions (not in DRF action list)", () => {
    const ns = names(SOURCE);
    expect(ns).not.toContain("UserViewSet#custom_action");
  });

  it("adds correct HTTP route hints to DRF actions", () => {
    const cs = candidates(SOURCE);

    const list = cs.find((c) => c.name === "UserViewSet#list")!;
    expect(list.hints.httpRoute?.method).toBe("GET");
    expect(list.hints.httpRoute?.path).not.toContain(":id");

    const retrieve = cs.find((c) => c.name === "UserViewSet#retrieve")!;
    expect(retrieve.hints.httpRoute?.method).toBe("GET");
    expect(retrieve.hints.httpRoute?.path).toContain(":id");

    const create = cs.find((c) => c.name === "UserViewSet#create")!;
    expect(create.hints.httpRoute?.method).toBe("POST");

    const destroy = cs.find((c) => c.name === "UserViewSet#destroy")!;
    expect(destroy.hints.httpRoute?.method).toBe("DELETE");
    expect(destroy.hints.httpRoute?.path).toContain(":id");
  });

  it("derives resource name from class name in DRF hints", () => {
    const cs = candidates(SOURCE);
    const list = cs.find((c) => c.name === "UserViewSet#list")!;
    expect(list.hints.httpRoute?.path).toContain("user");
  });

  it("inflects multi-word ViewSet class names to snake_case resources", () => {
    // OrderLineItemViewSet must produce /order_line_item, not /orderlineitem.
    const source = `
class OrderLineItemViewSet(ModelViewSet):
    def list(self, request):
        pass
`;
    const cs = candidates(source);
    expect(cs[0]!.hints.httpRoute?.path).toBe("/order_line_item");
  });

  it("keeps consecutive uppercase acronyms together (APIKey -> api_key)", () => {
    // Acronym-boundary pass: APIKey -> API_Key, then standard pass leaves
    // api_key. Without it the single-letter regex produces a_p_i_key.
    const source = `
class APIKeyViewSet(ModelViewSet):
    def list(self, request):
        pass

    def retrieve(self, request, pk=None):
        pass
`;
    const cs = candidates(source);
    const list = cs.find((c) => c.name === "APIKeyViewSet#list")!;
    expect(list.hints.httpRoute?.path).toBe("/api_key");
    const retrieve = cs.find((c) => c.name === "APIKeyViewSet#retrieve")!;
    expect(retrieve.hints.httpRoute?.path).toBe("/api_key/:id");
  });

  it("handles leading-acronym + camel ViewSet (XMLPost -> xml_post)", () => {
    const source = `
class XMLPostViewSet(ModelViewSet):
    def list(self, request):
        pass
`;
    const cs = candidates(source);
    expect(cs[0]!.hints.httpRoute?.path).toBe("/xml_post");
  });

  it("leaves single-word ViewSet resource names unchanged", () => {
    // Regression guard: the snake_case fix must not over-split single-word
    // class names (UserViewSet must still be /user, not /u_ser).
    const cs = candidates(SOURCE);
    const list = cs.find((c) => c.name === "UserViewSet#list")!;
    expect(list.hints.httpRoute?.path).toBe("/user");
  });
});

// ---- DRF APIView ---------------------------------------------------------

describe("parseDjango: DRF APIView", () => {
  const SOURCE = `
from rest_framework.views import APIView

class ArticleAPIView(APIView):
    def get(self, request, pk):
        article = Article.objects.get(pk=pk)
        return Response(ArticleSerializer(article).data)

    def put(self, request, pk):
        article = Article.objects.get(pk=pk)
        serializer = ArticleSerializer(article, data=request.data)
        if serializer.is_valid():
            serializer.save()
        return Response(serializer.data)

    def delete(self, request, pk):
        Article.objects.get(pk=pk).delete()
        return Response(status=204)
`;

  it("surfaces GET/PUT/DELETE on APIView subclass", () => {
    const ns = names(SOURCE);
    expect(ns).toContain("ArticleAPIView#get");
    expect(ns).toContain("ArticleAPIView#put");
    expect(ns).toContain("ArticleAPIView#delete");
  });

  it("sets correct HTTP methods on APIView methods", () => {
    const cs = candidates(SOURCE);
    expect(cs.find((c) => c.name === "ArticleAPIView#get")!.hints.httpRoute?.method).toBe("GET");
    expect(cs.find((c) => c.name === "ArticleAPIView#put")!.hints.httpRoute?.method).toBe("PUT");
    expect(cs.find((c) => c.name === "ArticleAPIView#delete")!.hints.httpRoute?.method).toBe("DELETE");
  });
});

// ---- Multiple classes in one file ----------------------------------------

describe("parseDjango: multiple view classes", () => {
  it("surfaces methods from all view classes in a file", () => {
    const source = `
class PostListView(ListView):
    def get(self, request):
        pass

class PostDetailView(DetailView):
    def get(self, request, pk):
        pass

    def post(self, request, pk):
        pass
`;
    const ns = names(source);
    expect(ns).toContain("PostListView#get");
    expect(ns).toContain("PostDetailView#get");
    expect(ns).toContain("PostDetailView#post");
    expect(ns).toHaveLength(3);
  });

  it("FBVs and CBVs coexist in the same file", () => {
    const source = `
def health_check(request):
    return JsonResponse({'ok': True})

class UserView(View):
    def get(self, request):
        pass
`;
    const ns = names(source);
    expect(ns).toContain("health_check");
    expect(ns).toContain("UserView#get");
  });
});

// ---- Line numbers ---------------------------------------------------------

describe("parseDjango: line numbers", () => {
  it("reports correct 1-indexed lineStart for FBVs and CBV methods", () => {
    const source = [
      "def index(request):",           // line 1
      "    return render(request, 'i')", // line 2
      "",
      "class UserView(View):",          // line 4
      "    def get(self, request):",    // line 5
      "        pass",                   // line 6
    ].join("\n");
    const cs = candidates(source);
    const index = cs.find((c) => c.name === "index")!;
    const get = cs.find((c) => c.name === "UserView#get")!;
    expect(index.lineStart).toBe(1);
    expect(get.lineStart).toBe(5);
  });

  it("lineStart includes decorator lines for FBVs", () => {
    const source = [
      "@login_required",     // line 1
      "def secure(request):", // line 2
      "    pass",             // line 3
    ].join("\n");
    const cs = candidates(source);
    expect(cs[0]!.lineStart).toBe(1);
  });
});

// ---- Multi-line decorators ------------------------------------------------

describe("parseDjango: multi-line decorator capture", () => {
  it("includes a multi-line decorator's source and lineStart for FBVs", () => {
    // method_decorator with name= kwarg is the canonical Django pattern that
    // pushes the closing ')' to a separate line.
    const source = [
      "@method_decorator(",          // line 1
      "    cache_page(60 * 15),",     // line 2
      "    name='dispatch',",         // line 3
      ")",                            // line 4
      "def view(request):",           // line 5
      "    return render(request, 'x.html')", // line 6
    ].join("\n");
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.lineStart).toBe(1);
    expect(cs[0]!.source).toContain("@method_decorator(");
    expect(cs[0]!.source).toContain("cache_page(60 * 15)");
    expect(cs[0]!.source).toContain("name='dispatch'");
    expect(cs[0]!.source).toContain("def view");
  });

  it("includes a multi-line decorator stacked above a single-line decorator", () => {
    const source = [
      "@login_required",              // line 1
      "@method_decorator(",          // line 2
      "    cache_page(60),",          // line 3
      "    name='dispatch',",         // line 4
      ")",                            // line 5
      "def view(request):",           // line 6
      "    pass",                     // line 7
    ].join("\n");
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.lineStart).toBe(1);
    expect(cs[0]!.source).toContain("@login_required");
    expect(cs[0]!.source).toContain("@method_decorator(");
  });

  it("includes a multi-line decorator for CBV methods", () => {
    const source = [
      "class UserView(View):",            // line 1
      "    @method_decorator(",           // line 2
      "        login_required,",          // line 3
      "        name='dispatch',",         // line 4
      "    )",                             // line 5
      "    def get(self, request):",      // line 6
      "        pass",                     // line 7
    ].join("\n");
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.name).toBe("UserView#get");
    expect(cs[0]!.lineStart).toBe(2);
    expect(cs[0]!.source).toContain("@method_decorator(");
    expect(cs[0]!.source).toContain("login_required");
    expect(cs[0]!.source).toContain("name='dispatch'");
    expect(cs[0]!.source).toContain("def get");
  });

  it("includes stacked single-line decorators above CBV methods", () => {
    // @method_decorator(login_required) is a canonical Django CBV pattern; the
    // LLM needs to see the decoration to generate accurate "this endpoint
    // requires auth" use-case copy.
    const source = [
      "class UserView(View):",                            // line 1
      "    @method_decorator(login_required)",            // line 2
      "    @method_decorator(cache_page(60 * 15))",       // line 3
      "    def get(self, request):",                      // line 4
      "        pass",                                     // line 5
    ].join("\n");
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.lineStart).toBe(2);
    expect(cs[0]!.source).toContain("@method_decorator(login_required)");
    expect(cs[0]!.source).toContain("@method_decorator(cache_page(60 * 15))");
    expect(cs[0]!.source).toContain("def get");
  });

  it("does NOT pull a sibling method's body into a CBV method's source", () => {
    // Walking back from `def post` must stop at the previous method's last
    // body line, not include any of it. Regression guard for the CBV branch
    // calling findDecoratorStart; if the walker ever drifted past a sibling
    // method's body, source would balloon and a decorator would falsely begin
    // at an earlier line.
    const source = [
      "class UserView(View):",            // line 1
      "    def get(self, request):",      // line 2
      "        return render('g.html')",  // line 3
      "",
      "    def post(self, request):",     // line 5
      "        return render('p.html')",  // line 6
    ].join("\n");
    const cs = candidates(source);
    const post = cs.find((c) => c.name === "UserView#post")!;
    expect(post.lineStart).toBe(5);
    expect(post.source.startsWith("    def post")).toBe(true);
    expect(post.source).not.toContain("def get");
  });

  it("does NOT swallow an unrelated multi-line call above a function", () => {
    // A naked multi-line call above a function (no '@' anywhere in the span)
    // must not be picked up as a decorator. lineStart stays on `def`.
    const source = [
      "some_setup_call(",       // line 1
      "    arg1,",               // line 2
      "    arg2,",               // line 3
      ")",                       // line 4
      "def view(request):",      // line 5
      "    pass",                // line 6
    ].join("\n");
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.lineStart).toBe(5);
    expect(cs[0]!.source.startsWith("def view")).toBe(true);
  });

  it("handles a multi-line decorator with nested brackets (lists, dicts)", () => {
    const source = [
      "@require_http_methods(",       // line 1
      "    ['GET', 'POST'],",          // line 2
      ")",                             // line 3
      "def view(request):",            // line 4
      "    pass",                      // line 5
    ].join("\n");
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.lineStart).toBe(1);
    expect(cs[0]!.source).toContain("@require_http_methods(");
    expect(cs[0]!.source).toContain("['GET', 'POST']");
  });

  it("preserves single-line decorator behavior (regression guard)", () => {
    // The multi-line fix must not break the simple stacked single-line case.
    const source = [
      "@login_required",                  // line 1
      "@permission_required('app.view')", // line 2
      "def view(request):",               // line 3
      "    pass",                         // line 4
    ].join("\n");
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.lineStart).toBe(1);
    expect(cs[0]!.source).toContain("@login_required");
    expect(cs[0]!.source).toContain("@permission_required");
  });
});

// ---- Parameters ----------------------------------------------------------

describe("parseDjango: parameter hints", () => {
  it("extracts URL path params from FBV signature (minus 'request')", () => {
    const source = `
def user_detail(request, pk, slug=None):
    pass
`;
    const cs = candidates(source);
    const params = cs[0]!.hints.parameters!;
    const names_ = params.map((p) => p.name);
    expect(names_).toContain("request");
    expect(names_).toContain("pk");
    expect(names_).toContain("slug");
  });

  it("strips 'self' and 'request' from CBV method parameter hints", () => {
    const source = `
class OrderView(View):
    def get(self, request, order_id):
        pass
`;
    const cs = candidates(source);
    const params = cs[0]!.hints.parameters!;
    const names_ = params.map((p) => p.name);
    expect(names_).toContain("order_id");
    expect(names_).not.toContain("self");
    expect(names_).not.toContain("request");
  });

  it("omits parameters hint when only self+request remain", () => {
    const source = `
class SimpleView(View):
    def get(self, request):
        pass
`;
    const cs = candidates(source);
    expect(cs[0]!.hints.parameters).toBeUndefined();
  });

  it("skips Python keyword-only marker '*' in FBV parameter hints", () => {
    const source = `
def my_view(request, *, format="json"):
    pass
`;
    const cs = candidates(source);
    const names_ = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names_).toEqual(["request", "format"]);
    expect(names_).not.toContain("");
  });

  it("skips Python positional-only marker '/' and keyword-only marker '*'", () => {
    const source = `
def my_view(request, pk, /, slug, *, format="json"):
    pass
`;
    const cs = candidates(source);
    const names_ = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names_).toEqual(["request", "pk", "slug", "format"]);
    expect(names_).not.toContain("/");
    expect(names_).not.toContain("");
  });

  it("skips keyword-only marker '*' in CBV method parameter hints", () => {
    const source = `
class ReportView(View):
    def get(self, request, *, format="json"):
        pass
`;
    const cs = candidates(source);
    const names_ = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names_).toEqual(["format"]);
    expect(names_).not.toContain("");
  });

  it("preserves *args / **kwargs splat params (regression guard)", () => {
    const source = `
def my_view(request, *args, **kwargs):
    pass
`;
    const cs = candidates(source);
    const names_ = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names_).toEqual(["request", "args", "kwargs"]);
  });

  it("treats a generic type annotation with internal commas as one param", () => {
    const source = `
def my_view(request, filters: Dict[str, int] = None):
    pass
`;
    const cs = candidates(source);
    const names_ = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names_).toEqual(["request", "filters"]);
    expect(names_).not.toContain("int]");
    expect(names_).not.toContain("int");
  });

  it("handles nested generic annotations (List[Tuple[str, int]])", () => {
    const source = `
def my_view(request, items: List[Tuple[str, int]] = None):
    pass
`;
    const cs = candidates(source);
    const names_ = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names_).toEqual(["request", "items"]);
    expect(names_).not.toContain("int]]");
  });

  it("handles generic annotations in CBV methods (Optional[Dict[str, Any]])", () => {
    const source = `
class UserView(View):
    def get(self, request, filters: Optional[Dict[str, Any]] = None):
        pass
`;
    const cs = candidates(source);
    const names_ = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names_).toEqual(["filters"]);
    expect(names_).not.toContain("Any]]");
  });

  it("treats a dict default with internal commas as one param", () => {
    const source = `
def my_view(request, opts={"a": 1, "b": 2}):
    pass
`;
    const cs = candidates(source);
    const names_ = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names_).toEqual(["request", "opts"]);
  });

  // --- Type annotation extraction ---

  it("extracts type from a simple annotated FBV param", () => {
    const source = `
def order_detail(request, pk: int):
    pass
`;
    const cs = candidates(source);
    const params = cs[0]!.hints.parameters!;
    const pk = params.find((p) => p.name === "pk")!;
    expect(pk.type).toBe("int");
    expect(params.find((p) => p.name === "request")!.type).toBeUndefined();
  });

  it("strips the default value from an annotated param with a default", () => {
    const source = `
def search(request, status: str = "active", limit: int = 20):
    pass
`;
    const cs = candidates(source);
    const params = cs[0]!.hints.parameters!;
    expect(params.find((p) => p.name === "status")!.type).toBe("str");
    expect(params.find((p) => p.name === "limit")!.type).toBe("int");
  });

  it("extracts type from a generic annotation with a default (depth-aware = search)", () => {
    // The `=` inside `[]` must not be mistaken for the default-value separator.
    const source = `
def my_view(request, filters: Dict[str, int] = None):
    pass
`;
    const cs = candidates(source);
    const params = cs[0]!.hints.parameters!;
    expect(params.find((p) => p.name === "filters")!.type).toBe("Dict[str, int]");
  });

  it("extracts type from a nested generic annotation", () => {
    const source = `
def my_view(request, items: List[Tuple[str, int]]):
    pass
`;
    const cs = candidates(source);
    expect(cs[0]!.hints.parameters!.find((p) => p.name === "items")!.type)
      .toBe("List[Tuple[str, int]]");
  });

  it("extracts type from CBV method params (filters self and request)", () => {
    const source = `
class OrderView(APIView):
    def post(self, request, user_id: int, status: str = "open"):
        pass
`;
    const cs = candidates(source);
    const params = cs[0]!.hints.parameters!;
    // self and request are filtered by buildCbvHints
    expect(params.find((p) => p.name === "user_id")!.type).toBe("int");
    expect(params.find((p) => p.name === "status")!.type).toBe("str");
    expect(params.every((p) => p.name !== "self" && p.name !== "request")).toBe(true);
  });

  it("leaves type undefined when param has no annotation", () => {
    const source = `
def my_view(request, pk, slug="hello"):
    pass
`;
    const cs = candidates(source);
    const params = cs[0]!.hints.parameters!;
    expect(params.find((p) => p.name === "pk")!.type).toBeUndefined();
    expect(params.find((p) => p.name === "slug")!.type).toBeUndefined();
  });
});

// ---- Source extraction ---------------------------------------------------

describe("parseDjango: source extraction", () => {
  it("includes def line and body in extracted source", () => {
    const source = `
def index(request):
    items = Item.objects.all()
    return render(request, 'index.html', {'items': items})
`;
    const cs = candidates(source);
    expect(cs[0]!.source).toContain("def index");
    expect(cs[0]!.source).toContain("Item.objects.all()");
    expect(cs[0]!.source).toContain("return render");
  });

  it("correctly closes FBV body when followed by another definition", () => {
    const source = `
def first(request):
    return render(request, 'first.html')

def second(request):
    return render(request, 'second.html')
`;
    const cs = candidates(source);
    expect(cs).toHaveLength(2);
    expect(cs[0]!.source).not.toContain("def second");
  });
});

// ---- Nested blocks inside actions ----------------------------------------

describe("parseDjango: nested blocks inside action bodies", () => {
  it("correctly closes CBV methods containing if/else blocks", () => {
    const source = `
class ItemView(View):
    def post(self, request):
        if form.is_valid():
            form.save()
            return redirect('success')
        else:
            return render(request, 'form.html', {'form': form})

    def delete(self, request, pk):
        Item.objects.get(pk=pk).delete()
        return redirect('list')
`;
    const ns = names(source);
    expect(ns).toEqual(["ItemView#post", "ItemView#delete"]);
  });

  it("correctly handles try/except inside action bodies", () => {
    const source = `
class WebhookView(View):
    def post(self, request):
        try:
            process(request.body)
        except ValueError:
            return HttpResponse(status=400)
        return HttpResponse(status=200)

    def get(self, request):
        return HttpResponse('ok')
`;
    const ns = names(source);
    expect(ns).toEqual(["WebhookView#post", "WebhookView#get"]);
  });
});

// ---- Multi-line def signature capture ------------------------------------

describe("parseDjango: multi-line def signature capture", () => {
  it("captures parameters from a wrapped FBV signature", () => {
    const source = `
def my_view(
    request,
    pk,
    slug=None,
):
    return render(request, 'detail.html')
`;
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.name).toBe("my_view");
    const names_ = (cs[0]!.hints.parameters ?? []).map((p) => p.name);
    expect(names_).toEqual(["request", "pk", "slug"]);
  });

  it("captures a wrapped FBV's full source including closing ): line and body", () => {
    const source = `
def my_view(
    request,
    pk,
):
    """Show item."""
    return HttpResponse("ok")
`;
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.source).toContain("def my_view(");
    expect(cs[0]!.source).toContain("pk,");
    expect(cs[0]!.source).toContain("):");
    expect(cs[0]!.source).toContain('"""Show item."""');
    expect(cs[0]!.source).toContain("return HttpResponse");
  });

  it("captures a wrapped CBV method signature (decorators + params + body)", () => {
    const source = `
class UserView(View):
    def get(
        self,
        request,
        pk,
    ):
        return HttpResponse("ok")

    def post(self, request):
        return HttpResponse("ok")
`;
    const cs = candidates(source);
    const ns = cs.map((c) => c.name);
    expect(ns).toEqual(["UserView#get", "UserView#post"]);

    const getCandidate = cs[0]!;
    expect(getCandidate.source).toContain("def get(");
    expect(getCandidate.source).toContain("pk,");
    expect(getCandidate.source).toContain("):");
    expect(getCandidate.source).toContain('return HttpResponse("ok")');
    expect(getCandidate.source).not.toContain("def post");

    const params = (getCandidate.hints.parameters ?? []).map((p) => p.name);
    expect(params).toEqual(["pk"]);
  });

  it("regression guard: single-line FBV signature still parses correctly", () => {
    const source = `
def index(request, pk):
    return render(request, 'index.html')
`;
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.name).toBe("index");
    expect(cs[0]!.lineEnd).toBeGreaterThanOrEqual(cs[0]!.lineStart);
  });
});

// ---- Multi-line class declaration capture --------------------------------

describe("parseDjango: multi-line class signature capture", () => {
  it("surfaces methods on a CBV with a wrapped base list", () => {
    const source = `
class UserView(
    LoginRequiredMixin,
    View,
):
    def get(self, request):
        return HttpResponse("ok")

    def post(self, request):
        return HttpResponse("ok")
`;
    const ns = names(source);
    expect(ns).toEqual(["UserView#get", "UserView#post"]);
  });

  it("surfaces ViewSet actions on a wrapped DRF base list", () => {
    const source = `
class OrderViewSet(
    LoginRequiredMixin,
    ModelViewSet,
):
    def list(self, request):
        return HttpResponse("ok")

    def retrieve(self, request, pk=None):
        return HttpResponse("ok")
`;
    const cs = candidates(source);
    expect(cs.map((c) => c.name)).toEqual([
      "OrderViewSet#list",
      "OrderViewSet#retrieve",
    ]);
    expect(cs[0]!.hints.httpRoute).toEqual({ method: "GET", path: "/order" });
    expect(cs[1]!.hints.httpRoute).toEqual({ method: "GET", path: "/order/:id" });
  });

  it("does NOT enter a wrapped non-view class (regression guard)", () => {
    // Wrapped multi-base classes that don't inherit from a view base must be
    // skipped exactly like their single-line counterpart, not silently treated
    // as a view class because the multi-line fix permits broader matching.
    const source = `
class NotAView(
    SomeMixin,
    SomeOtherBase,
):
    def get(self, request):
        return HttpResponse("ok")
`;
    expect(names(source)).toEqual([]);
  });

  it("regression guard: single-line class declaration still parses correctly", () => {
    const source = `
class UserView(View):
    def get(self, request):
        return HttpResponse("ok")
`;
    expect(names(source)).toEqual(["UserView#get"]);
  });

  // --- Auth decorator / permission notes ---

  it("surfaces @login_required on FBV as hints.notes", () => {
    const source = `
@login_required
def dashboard(request):
    return render(request, 'dashboard.html')
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.notes).toEqual(["auth: login_required"]);
  });

  it("surfaces @permission_required with arg on FBV", () => {
    const source = `
@permission_required('myapp.can_edit')
def edit_item(request, pk):
    pass
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.notes).toEqual(["auth: permission_required('myapp.can_edit')"]);
  });

  it("surfaces @staff_member_required on FBV", () => {
    const source = `
@staff_member_required
def admin_panel(request):
    pass
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.notes).toEqual(["auth: staff_member_required"]);
  });

  it("accumulates multiple auth decorators on FBV in declaration order", () => {
    const source = `
@login_required
@permission_required('myapp.can_view')
def secure_view(request):
    pass
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.notes).toEqual([
      "auth: login_required",
      "auth: permission_required('myapp.can_view')",
    ]);
  });

  it("does not add notes when FBV has no auth decorators", () => {
    const source = `
def public_view(request):
    return render(request, 'public.html')
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.notes).toBeUndefined();
  });

  it("surfaces DRF class-level permission_classes on every CBV method", () => {
    const source = `
class OrderViewSet(ModelViewSet):
    permission_classes = [IsAuthenticated]

    def list(self, request):
        return Response([])

    def retrieve(self, request, pk=None):
        return Response({})
`;
    const cs = candidates(source);
    expect(cs).toHaveLength(2);
    for (const c of cs) {
      expect(c.hints.notes).toEqual(["permission_classes: IsAuthenticated"]);
    }
  });

  it("surfaces multiple DRF permission classes joined by comma", () => {
    const source = `
class AdminViewSet(ModelViewSet):
    permission_classes = [IsAuthenticated, IsAdminUser]

    def list(self, request):
        return Response([])
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.notes).toEqual(["permission_classes: IsAuthenticated, IsAdminUser"]);
  });

  it("resets permission_classes when a new class is entered", () => {
    const source = `
class SecureView(ModelViewSet):
    permission_classes = [IsAuthenticated]

    def list(self, request):
        return Response([])

class OpenView(APIView):
    def get(self, request):
        return Response({})
`;
    const cs = candidates(source);
    const byName = Object.fromEntries(cs.map((c) => [c.name, c]));
    expect(byName["SecureView#list"]?.hints.notes).toEqual(["permission_classes: IsAuthenticated"]);
    expect(byName["OpenView#get"]?.hints.notes).toBeUndefined();
  });

  // Real DRF code routinely formats permission_classes across multiple lines;
  // the original single-line-only regex (`[^\]]*\]`) silently dropped any list
  // whose closing `]` was on a different line, so every CBV method in that
  // class would lose the permission_classes note. Pin the multi-line accumulator.
  it("surfaces permission_classes when the list spans multiple lines", () => {
    const source = `
class ReportViewSet(ModelViewSet):
    permission_classes = [
        IsAuthenticated,
        IsAdminUser,
    ]

    def list(self, request):
        return Response([])

    def retrieve(self, request, pk=None):
        return Response({})
`;
    const cs = candidates(source);
    expect(cs).toHaveLength(2);
    for (const c of cs) {
      expect(c.hints.notes).toEqual(["permission_classes: IsAuthenticated, IsAdminUser"]);
    }
  });

  it("surfaces permission_classes spanning two lines without a trailing comma", () => {
    const source = `
class WideView(ModelViewSet):
    permission_classes = [IsAuthenticated,
                          IsAdminUser]

    def list(self, request):
        return Response([])
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.notes).toEqual(["permission_classes: IsAuthenticated, IsAdminUser"]);
  });
});

// ---- ORM model extraction -----------------------------------------------

describe("parseDjango: ORM model extraction (databaseTables)", () => {
  it("extracts a single model from .objects. call in an FBV", () => {
    const source = `
def list_articles(request):
    articles = Article.objects.filter(published=True)
    return render(request, 'articles.html', {'articles': articles})
`;
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]?.hints.databaseTables).toEqual(["Article"]);
  });

  it("extracts multiple distinct models from an FBV body", () => {
    const source = `
def dashboard(request):
    users = User.objects.all()
    posts = Post.objects.filter(active=True)
    tags = Tag.objects.order_by('name')
    return render(request, 'dashboard.html', {})
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toEqual(expect.arrayContaining(["User", "Post", "Tag"]));
    expect(cs[0]?.hints.databaseTables).toHaveLength(3);
  });

  it("deduplicates repeated .objects. calls to the same model", () => {
    const source = `
def article_detail(request, pk):
    article = Article.objects.get(pk=pk)
    related = Article.objects.filter(category=article.category)[:5]
    return render(request, 'detail.html', {})
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toEqual(["Article"]);
  });

  it("does not surface lowercase identifiers (not models)", () => {
    const source = `
def my_view(request):
    result = manager.objects.all()
    return render(request, 'tmpl.html', {})
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toBeUndefined();
  });

  it("extracts models from a CBV method body", () => {
    const source = `
class ArticleListView(View):
    def get(self, request):
        qs = Article.objects.filter(published=True)
        return render(request, 'list.html', {'articles': qs})
`;
    const cs = candidates(source);
    expect(cs).toHaveLength(1);
    expect(cs[0]?.hints.databaseTables).toEqual(["Article"]);
  });

  it("leaves databaseTables undefined when no .objects. call is present", () => {
    const source = `
def ping(request):
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toBeUndefined();
  });
});

// ---- CBV class-level queryset / model attribute extraction ---------------

describe("parseDjango: CBV class-level model hints", () => {
  it("extracts model from queryset class attribute", () => {
    const source = `
class UserListView(ListAPIView):
    queryset = User.objects.all()
    def get(self, request):
        return Response(self.get_queryset())
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toEqual(expect.arrayContaining(["User"]));
  });

  it("extracts model from model class attribute", () => {
    const source = `
class PostDetailView(RetrieveAPIView):
    model = Post
    def get(self, request):
        return Response({})
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toEqual(expect.arrayContaining(["Post"]));
  });

  it("merges class-level and method-body model refs without duplicates", () => {
    const source = `
class OrderListView(ListAPIView):
    queryset = Order.objects.all()
    def get(self, request):
        items = LineItem.objects.filter(order__in=self.get_queryset())
        return Response({})
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toEqual(
      expect.arrayContaining(["Order", "LineItem"]),
    );
    expect(cs[0]?.hints.databaseTables).toHaveLength(2);
  });

  it("class-level model does not appear twice when also referenced in body", () => {
    const source = `
class ArticleView(RetrieveAPIView):
    queryset = Article.objects.all()
    def get(self, request):
        obj = Article.objects.get(pk=request.GET['id'])
        return Response({})
`;
    const cs = candidates(source);
    const tables = cs[0]?.hints.databaseTables ?? [];
    expect(tables.filter((t) => t === "Article")).toHaveLength(1);
  });
});

// ---- Function callee extraction (callees) --------------------------------

describe("parseDjango: callee extraction", () => {
  it("surfaces helper function calls from an FBV body", () => {
    const source = `
def create_order(request):
    validate_order(request.POST)
    order = build_order(request.POST)
    send_confirmation(order)
    return JsonResponse({'id': order.id})
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.callees).toEqual(
      expect.arrayContaining(["validate_order", "build_order", "send_confirmation"]),
    );
  });

  it("surfaces helper calls from a CBV method body", () => {
    const source = `
class OrderCreateView(View):
    def post(self, request):
        validated = validate_payload(request.POST)
        order = create_order(validated)
        notify_warehouse(order)
        return JsonResponse({'id': order.id})
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.callees).toEqual(
      expect.arrayContaining(["validate_payload", "create_order", "notify_warehouse"]),
    );
  });

  it("excludes Python keywords from callees", () => {
    const source = `
def index(request):
    items = list(range(10))
    return JsonResponse({'items': items})
`;
    const cs = candidates(source);
    const callees = cs[0]?.hints.callees ?? [];
    expect(callees).not.toContain("list");
    expect(callees).not.toContain("range");
    expect(callees).not.toContain("return");
  });

  it("leaves callees undefined when FBV body has no qualifying calls", () => {
    const source = `
def ping(request):
    ok = True
    return ok
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.callees).toBeUndefined();
  });
});

// ---- Email and HTTP side-effect notes ------------------------------------

describe("parseDjango: side-effect notes (email and HTTP)", () => {
  it("surfaces email note when send_mail is present in FBV", () => {
    const source = `
def register(request):
    user = User.objects.create(email=request.POST['email'])
    send_mail('Welcome', 'Hi!', 'noreply@example.com', [user.email])
    return JsonResponse({'id': user.id})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Sends email (Django mail)")).toBe(true);
  });

  it("surfaces email note for EmailMessage instantiation", () => {
    const source = `
def notify(request):
    msg = EmailMessage(subject='Hi', body='Hello', to=['user@example.com'])
    msg.send()
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Sends email (Django mail)")).toBe(true);
  });

  it("surfaces HTTP note when requests.post is called in CBV", () => {
    const source = `
class WebhookView(View):
    def post(self, request):
        payload = request.body
        requests.post('https://hooks.example.com/notify', json={'data': payload})
        return JsonResponse({'received': True})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Makes outbound HTTP request")).toBe(true);
  });

  it("surfaces HTTP note when httpx.get is called", () => {
    const source = `
def fetch_profile(request):
    resp = httpx.get('https://api.example.com/profile')
    return JsonResponse(resp.json())
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Makes outbound HTTP request")).toBe(true);
  });

  it("does not add side-effect notes when neither email nor HTTP is present", () => {
    const source = `
def ping(request):
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n.includes("email") || n.includes("HTTP"))).toBe(false);
  });

  // The two side-effect regexes have multiple alternatives. A single-entry
  // deletion would silently degrade hint coverage with no test failure. These
  // loops pin every alternative so a future refactor that drops one trips a
  // named failure. Mirrors the Java / Ruby / C# per-alternative pattern.

  it("email regex covers all 6 alternatives", () => {
    const probes = [
      { body: "send_mail('Hi', 'Body', 'noreply@x.com', ['user@x.com'])", label: "send_mail" },
      { body: "send_mass_mail([('Hi', 'B', 'from@x', ['a@x'])])", label: "send_mass_mail" },
      { body: "mail_admins('Subject', 'message')", label: "mail_admins" },
      { body: "mail_managers('Subject', 'message')", label: "mail_managers" },
      { body: "msg = EmailMessage('Hi', 'Body', 'from@x', ['to@x'])", label: "EmailMessage" },
      { body: "msg = EmailMultiAlternatives('Hi', 'Body', 'from@x', ['to@x'])", label: "EmailMultiAlternatives" },
    ];
    for (const { body, label } of probes) {
      const source = `
def view(request):
    ${body}
    return JsonResponse({'ok': True})
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${label} should emit Django mail note`).toContain("Sends email (Django mail)");
    }
  });

  it("HTTP regex covers all 3 client libraries", () => {
    const probes = [
      { body: "r = requests.post('https://x.com', json={})", label: "requests" },
      { body: "r = httpx.get('https://x.com')", label: "httpx" },
      { body: "r = urllib.request.urlopen('https://x.com')", label: "urllib.request.urlopen" },
    ];
    for (const { body, label } of probes) {
      const source = `
def view(request):
    ${body}
    return JsonResponse({'ok': True})
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${label} should emit HTTP note`).toContain("Makes outbound HTTP request");
    }
  });

  it("requests HTTP regex covers all 8 verb methods", () => {
    const verbs = ["get", "post", "put", "patch", "delete", "head", "options", "request"];
    for (const verb of verbs) {
      const source = `
def view(request):
    r = requests.${verb}('https://x.com')
    return JsonResponse({'ok': True})
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `requests.${verb} should emit HTTP note`).toContain("Makes outbound HTTP request");
    }
  });

  it("surfaces 'Writes to file system' for built-in open() with write mode", () => {
    const source = `
def export_csv(request):
    with open('/tmp/users.csv', 'w') as f:
        f.write(build_csv())
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Writes to file system");
  });

  it("surfaces filesystem note for os / shutil / pathlib / default_storage mutators", () => {
    const source = `
def process(request):
    os.makedirs('/tmp/uploads', exist_ok=True)
    shutil.move('/tmp/in.dat', '/tmp/processed/in.dat')
    Path('/tmp/log.txt').write_text(request.POST['line'])
    default_storage.save('avatars/x.png', request.FILES['avatar'])
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Writes to file system");
  });

  it("does NOT surface filesystem note for read-only file operations", () => {
    const source = `
def load(request):
    with open('/tmp/in.csv') as f:
        contents = f.read()
    other = open('/tmp/other.csv', 'r').read()
    exists = os.path.exists('/tmp/x.csv')
    listed = os.listdir('/tmp')
    text = Path('/tmp/y.txt').read_text()
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Writes to file system")).toBe(false);
  });

  it("os mutator regex covers all 11 alternatives", () => {
    const mutators = [
      "remove", "unlink", "rename", "rmdir", "makedirs", "mkdir",
      "replace", "symlink", "link", "chmod", "chown",
    ];
    for (const m of mutators) {
      const source = `
def view(request):
    os.${m}('/tmp/x', '/tmp/y')
    return JsonResponse({'ok': True})
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `os.${m} should emit filesystem note`).toContain("Writes to file system");
    }
  });

  it("shutil mutator regex covers all 7 alternatives", () => {
    const mutators = ["copy", "copyfile", "copytree", "copy2", "copymode", "move", "rmtree"];
    for (const m of mutators) {
      const source = `
def view(request):
    shutil.${m}('/tmp/a', '/tmp/b')
    return JsonResponse({'ok': True})
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `shutil.${m} should emit filesystem note`).toContain("Writes to file system");
    }
  });

  it("open() mode regex covers w / a / x and b / + suffixes", () => {
    const modes = ["w", "a", "x", "w+", "a+", "wb", "ab", "wb+"];
    for (const mode of modes) {
      const source = `
def view(request):
    f = open('/tmp/x', '${mode}')
    return JsonResponse({'ok': True})
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `open(_, "${mode}") should emit filesystem note`).toContain("Writes to file system");
    }
  });

  it("transaction note fires for with transaction.atomic() context manager", () => {
    const source = `
def transfer(request):
    with transaction.atomic():
        sender.debit(request.POST['amount'])
        receiver.credit(request.POST['amount'])
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes within a database transaction");
  });

  it("transaction note fires for @transaction.atomic decorator", () => {
    const source = `
@transaction.atomic
def checkout(request):
    cart = Cart.objects.get(id=request.POST['cart_id'])
    cart.checkout()
    return JsonResponse({'id': cart.id})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes within a database transaction");
  });

  it("transaction note fires for @transaction.atomic() called form", () => {
    const source = `
@transaction.atomic()
def refund(request):
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes within a database transaction");
  });

  it("transaction note does NOT fire for transaction_id or unrelated attribute access", () => {
    // Defensive: \b...\b boundaries prevent transaction_id / atomic_block /
    // similar attribute names from tripping the detector.
    const source = `
def show(request):
    txn_id = request.POST['transaction_id']
    return JsonResponse({'id': txn_id})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n.includes("database transaction"))).toBe(false);
  });

  it("cache-mutation note fires for cache.set / .delete / .clear (default cache)", () => {
    const source = `
def refresh(request):
    cache.set('feed:' + request.user.id, build_feed())
    cache.delete('stale:' + request.user.id)
    return JsonResponse({'ok': True})

def flush_all(request):
    cache.clear()
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    const refreshNotes = cs[0]?.hints.notes ?? [];
    const flushNotes = cs[1]?.hints.notes ?? [];
    expect(refreshNotes).toContain("Mutates application cache");
    expect(flushNotes).toContain("Mutates application cache");
  });

  it("cache-mutation note fires for caches['named'].set indexer form", () => {
    const source = `
def write_session(request):
    caches['sessions'].set('sid:' + request.session.session_key, request.user.id)
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Mutates application cache");
  });

  it("cache-mutation note fires for high-blast-radius variants (delete_pattern, delete_many, clear)", () => {
    const source = `
def reindex(request):
    cache.delete_pattern('category:*')
    return JsonResponse({'ok': True})

def bulk_clear(request):
    cache.delete_many(['k1', 'k2', 'k3'])
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.notes ?? []).toContain("Mutates application cache");
    expect(cs[1]?.hints.notes ?? []).toContain("Mutates application cache");
  });

  it("cache-mutation note does NOT fire for cache.get / .get_many / .has_key (read-only)", () => {
    // Read-only access (and get_or_set, which is read-on-miss) is
    // intentionally NOT flagged. No blast radius beyond a cache miss.
    const source = `
def show(request):
    feed = cache.get('feed:' + request.user.id)
    bulk = cache.get_many(['k1', 'k2'])
    exists = cache.has_key('check:1')
    return JsonResponse({'feed': feed, 'bulk': bulk, 'exists': exists})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n.includes("cache"))).toBe(false);
  });

  it("process-execution note fires for subprocess.run / Popen / call / check_output", () => {
    const probes = [
      { body: "subprocess.run(['wkhtmltopdf', '-', '-'], capture_output=True)", label: "subprocess.run" },
      { body: "p = subprocess.Popen(['ffmpeg', '-i', 'in.mp4', 'out.mp3'])", label: "subprocess.Popen" },
      { body: "subprocess.call(['ls', '-la'])", label: "subprocess.call" },
      { body: "out = subprocess.check_output(['git', 'status'])", label: "subprocess.check_output" },
      { body: "subprocess.check_call(['rsync', src, dest])", label: "subprocess.check_call" },
      { body: "out = subprocess.getoutput('uname -a')", label: "subprocess.getoutput" },
      { body: "status, out = subprocess.getstatusoutput('echo hi')", label: "subprocess.getstatusoutput" },
    ];
    for (const { body, label } of probes) {
      const source = `
def view(request):
    ${body}
    return JsonResponse({'ok': True})
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${label} should emit process-execution note`).toContain("Executes external process");
    }
  });

  it("process-execution note fires for os.system / os.popen / os.exec* / os.spawn*", () => {
    const probes = [
      { body: "os.system('ls -la')", label: "os.system" },
      { body: "f = os.popen('uname -a')", label: "os.popen" },
      { body: "os.execl('/bin/sh', 'sh', '-c', 'echo hi')", label: "os.execl" },
      { body: "os.execv('/bin/echo', ['echo', 'hi'])", label: "os.execv" },
      { body: "os.execlp('echo', 'echo', 'hi')", label: "os.execlp" },
      { body: "os.spawnl(os.P_WAIT, '/bin/echo', 'echo', 'hi')", label: "os.spawnl" },
      { body: "os.spawnv(os.P_WAIT, '/bin/echo', ['echo', 'hi'])", label: "os.spawnv" },
    ];
    for (const { body, label } of probes) {
      const source = `
def view(request):
    ${body}
    return JsonResponse({'ok': True})
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${label} should emit process-execution note`).toContain("Executes external process");
    }
  });

  it("process-execution note does NOT fire for subprocess.list2cmdline (helper, no spawn)", () => {
    // subprocess.list2cmdline is a string-formatting utility that builds a
    // Windows-shell-quoted command line. It spawns nothing. Should stay
    // out of the side-effect list.
    const source = `
def view(request):
    line = subprocess.list2cmdline(['ffmpeg', '-i', 'in.mp4', 'out.mp3'])
    return JsonResponse({'cmd': line})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Executes external process")).toBe(false);
  });
});

describe("parseDjango: Celery background-job notes", () => {
  // Celery is the dominant async task library in Django; views that dispatch
  // tasks are high-blast-radius because the real work (DB writes, email, file
  // creation) happens later in a worker process, out of band with the request.
  // Mirrors C# Hangfire (BackgroundJob.Enqueue) and Ruby ActiveJob
  // (perform_later / perform_async) background-job notes.

  it("surfaces 'Enqueues background job' for task.delay() dispatch (FBV)", () => {
    const source = `
def register(request):
    user = User.objects.create(email=request.POST['email'])
    send_welcome_email.delay(user.id)
    return JsonResponse({'id': user.id})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Enqueues background job");
  });

  it("surfaces 'Enqueues background job' for task.apply_async() dispatch (CBV)", () => {
    const source = `
class CheckoutView(View):
    def post(self, request):
        order = Order.objects.create(user=request.user)
        process_payment.apply_async(args=[order.id], countdown=5)
        return JsonResponse({'order': order.id})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Enqueues background job");
  });

  it("pins both dispatch forms in isolation so a future regex narrowing trips a named failure", () => {
    const probes = [
      { body: "generate_report.delay(request.user.id)", label: ".delay(" },
      { body: "export_data.apply_async(args=[pk], eta=eta)", label: ".apply_async(" },
    ];
    for (const { body, label } of probes) {
      const source = `
def view(request):
    ${body}
    return JsonResponse({'ok': True})
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${label} should emit background-job note`).toContain("Enqueues background job");
    }
  });

  it("does NOT surface background-job note when neither .delay nor .apply_async is present", () => {
    const source = `
def index(request):
    items = Item.objects.filter(active=True)
    return JsonResponse({'count': items.count()})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Enqueues background job")).toBe(false);
  });
});

describe("parseDjango: stored procedure notes (cursor.callproc)", () => {
  // Python DB-API 2.0 defines cursor.callproc(procname, parameters) as the
  // canonical API for invoking a stored procedure. Django views that drop to
  // raw SQL via `with connection.cursor() as cursor: cursor.callproc(...)` are
  // audit-critical: the proc may contain triggers, cross-table writes, and
  // side effects invisible in the calling view. Mirrors C# CommandType.StoredProcedure,
  // Java prepareCall / createStoredProcedureQuery / SimpleJdbcCall, and
  // CFML <cfstoredproc> detection.

  it("surfaces 'Calls stored procedure' for cursor.callproc in FBV", () => {
    const source = `
def run_report(request):
    with connection.cursor() as cursor:
        cursor.callproc('sp_generate_report', [request.GET.get('year')])
        results = cursor.fetchall()
    return JsonResponse({'rows': results})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Calls stored procedure");
  });

  it("surfaces 'Calls stored procedure' for cursor.callproc in CBV", () => {
    const source = `
class InvoiceView(View):
    def post(self, request):
        with connection.cursor() as cur:
            cur.callproc('sp_create_invoice', [request.user.id])
        return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Calls stored procedure");
  });

  it("does NOT surface stored-procedure note for plain cursor.execute with SQL", () => {
    const source = `
def list_orders(request):
    with connection.cursor() as cursor:
        cursor.execute('SELECT id, total FROM orders WHERE status = %s', ['open'])
        rows = cursor.fetchall()
    return JsonResponse({'orders': rows})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Calls stored procedure")).toBe(false);
  });
});

describe("parseDjango: message broker notes (Kombu / Pika)", () => {
  // Four Python broker libraries cover the dominant Django patterns.
  // All are audit-critical: published messages trigger downstream consumers
  // whose side effects are invisible in the calling view.
  //   - Pika (pure RabbitMQ Python client): channel.basic_publish(...)
  //   - Kombu (AMQP abstraction): producer.publish(...)
  //   - kafka-python: KafkaProducer(...) instantiation
  //   - confluent-kafka: producer.produce(...)
  // Mirrors Java JMS/AMQP/Kafka and C# MassTransit/Azure Service Bus notes.

  it("surfaces 'Sends message to broker (Kombu / Pika)' for channel.basic_publish (Pika)", () => {
    const source = `
def create_order(request):
    order = Order.objects.create(**request.POST)
    connection = pika.BlockingConnection(pika.ConnectionParameters(host='rabbitmq'))
    channel = connection.channel()
    channel.basic_publish(exchange='', routing_key='orders', body=order.to_json())
    connection.close()
    return JsonResponse({'id': order.id}, status=201)
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Sends message to broker (Kombu / Pika)");
  });

  it("surfaces 'Sends message to broker (Kombu / Pika)' for producer.publish (Kombu)", () => {
    const source = `
def notify_subscribers(request):
    with Connection(settings.BROKER_URL) as conn:
        producer = conn.Producer()
        producer.publish({'event': 'user_signup', 'id': request.user.id},
                         exchange='events', routing_key='signup')
    return JsonResponse({'ok': True})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Sends message to broker (Kombu / Pika)");
  });

  it("surfaces 'Sends message to broker (Kombu / Pika)' for KafkaProducer instantiation", () => {
    const source = `
def emit_event(request):
    producer = KafkaProducer(bootstrap_servers=settings.KAFKA_BROKERS)
    producer.send('user-events', key=b'signup', value=request.body)
    producer.flush()
    return HttpResponse(status=202)
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Sends message to broker (Kombu / Pika)");
  });

  it("surfaces 'Sends message to broker (Kombu / Pika)' for producer.produce (confluent-kafka)", () => {
    const source = `
def ship_order(request, pk):
    order = get_object_or_404(Order, pk=pk)
    order.status = 'shipped'
    order.save()
    producer = Producer({'bootstrap.servers': settings.KAFKA_BROKERS})
    producer.produce('shipments', key=str(order.id), value=order.to_json())
    producer.flush()
    return JsonResponse({'status': 'shipped'})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Sends message to broker (Kombu / Pika)");
  });

  it("does NOT surface broker note for plain view with no broker calls", () => {
    const source = `
def list_orders(request):
    orders = Order.objects.filter(user=request.user)
    return JsonResponse({'orders': list(orders.values())})
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n.startsWith("Sends message to broker"))).toBe(false);
  });
});
