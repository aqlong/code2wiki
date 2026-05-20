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
});
