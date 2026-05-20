import { describe, it, expect } from "vitest";
import { parseRuby } from "./ruby.js";

// Minimal helpers so tests read cleanly.
function names(source: string, file = "users_controller.rb"): string[] {
  return parseRuby(`/app/controllers/${file}`, `app/controllers/${file}`, source).map(
    (c) => c.name,
  );
}

function candidates(source: string, file = "users_controller.rb") {
  return parseRuby(`/app/controllers/${file}`, `app/controllers/${file}`, source);
}

// ---- File-gate -----------------------------------------------------------

describe("parseRuby: file gate", () => {
  it("returns empty for files that do not end in _controller.rb", () => {
    const source = "class User < ApplicationRecord\n  def save\n  end\nend\n";
    expect(parseRuby("/app/models/user.rb", "app/models/user.rb", source)).toEqual([]);
    expect(parseRuby("/lib/tasks/deploy.rb", "lib/tasks/deploy.rb", source)).toEqual([]);
    expect(parseRuby("/config/routes.rb", "config/routes.rb", source)).toEqual([]);
  });

  it("parses a file that ends in _controller.rb", () => {
    const source = "class UsersController < ApplicationController\n  def index\n  end\nend\n";
    expect(candidates(source)).toHaveLength(1);
  });
});

// ---- REST action surfacing -----------------------------------------------

describe("parseRuby: REST actions", () => {
  const RESTFUL = `
class PostsController < ApplicationController
  def index
    @posts = Post.all
  end

  def show
    @post = Post.find(params[:id])
  end

  def new
    @post = Post.new
  end

  def create
    @post = Post.new(post_params)
    @post.save
    redirect_to @post
  end

  def edit
    @post = Post.find(params[:id])
  end

  def update
    @post = Post.find(params[:id])
    @post.update(post_params)
    redirect_to @post
  end

  def destroy
    @post = Post.find(params[:id])
    @post.destroy
    redirect_to posts_path
  end

  private

  def post_params
    params.require(:post).permit(:title, :body)
  end
end
`;

  it("surfaces all 7 REST actions", () => {
    const ns = names(RESTFUL, "posts_controller.rb");
    expect(ns).toEqual([
      "PostsController#index",
      "PostsController#show",
      "PostsController#new",
      "PostsController#create",
      "PostsController#edit",
      "PostsController#update",
      "PostsController#destroy",
    ]);
  });

  it("does NOT surface private methods", () => {
    const ns = names(RESTFUL, "posts_controller.rb");
    expect(ns).not.toContain("PostsController#post_params");
  });

  it("assigns kind='rails-action' to REST actions", () => {
    const cs = candidates(RESTFUL, "posts_controller.rb");
    for (const c of cs) {
      expect(c.kind).toBe("rails-action");
    }
  });

  it("adds HTTP route hints to REST actions", () => {
    const cs = candidates(RESTFUL, "posts_controller.rb");
    const index = cs.find((c) => c.name.endsWith("#index"))!;
    expect(index.hints.httpRoute?.method).toBe("GET");
    expect(index.hints.httpRoute?.path).toContain("posts");

    const create = cs.find((c) => c.name.endsWith("#create"))!;
    expect(create.hints.httpRoute?.method).toBe("POST");

    const destroy = cs.find((c) => c.name.endsWith("#destroy"))!;
    expect(destroy.hints.httpRoute?.method).toBe("DELETE");
  });

  it("inflects multi-word controllers to snake_case routes", () => {
    // Rails convention: LineItemsController serves /line_items, not /lineitems.
    const source = `
class LineItemsController < ApplicationController
  def index
    @items = LineItem.all
  end

  def show
    @item = LineItem.find(params[:id])
  end
end
`;
    const cs = candidates(source, "line_items_controller.rb");
    const index = cs.find((c) => c.name.endsWith("#index"))!;
    expect(index.hints.httpRoute?.path).toBe("/line_items");
    const show = cs.find((c) => c.name.endsWith("#show"))!;
    expect(show.hints.httpRoute?.path).toBe("/line_items/:id");
  });

  it("inflects three-word controllers to snake_case routes", () => {
    const source = `
class BlogPostCommentsController < ApplicationController
  def index
    @comments = BlogPostComment.all
  end
end
`;
    const cs = candidates(source, "blog_post_comments_controller.rb");
    expect(cs[0]?.hints.httpRoute?.path).toBe("/blog_post_comments");
  });

  it("leaves single-word controller routes unchanged", () => {
    // Regression guard: the snake_case fix must not over-split single-word
    // controllers (e.g. PostsController must still be /posts, not /p_osts).
    const cs = candidates(RESTFUL, "posts_controller.rb");
    const index = cs.find((c) => c.name.endsWith("#index"))!;
    expect(index.hints.httpRoute?.path).toBe("/posts");
  });

  it("keeps consecutive uppercase acronyms together (APIKeys -> api_keys)", () => {
    // Acronym-boundary pass: API_Keys then standard pass leaves api_keys.
    // Documented imperfect cases (OAuth -> o_auth) are out of scope; this
    // pins the common acronym shape we DO handle correctly.
    const source = `
class APIKeysController < ApplicationController
  def index
    @keys = APIKey.all
  end
end
`;
    const cs = candidates(source, "api_keys_controller.rb");
    expect(cs[0]?.hints.httpRoute?.path).toBe("/api_keys");
  });

  it("sets language='ruby' on all candidates", () => {
    const cs = candidates(RESTFUL, "posts_controller.rb");
    for (const c of cs) {
      expect(c.language).toBe("ruby");
    }
  });
});

// ---- Custom (non-REST) actions --------------------------------------------

describe("parseRuby: custom actions", () => {
  const SOURCE = `
class OrdersController < ApplicationController
  def index
    @orders = current_user.orders
  end

  def search
    @orders = Order.search(params[:q])
  end

  def export_csv
    send_data Order.to_csv, filename: 'orders.csv'
  end
end
`;

  it("surfaces custom actions alongside REST actions", () => {
    const ns = names(SOURCE, "orders_controller.rb");
    expect(ns).toContain("OrdersController#index");
    expect(ns).toContain("OrdersController#search");
    expect(ns).toContain("OrdersController#export_csv");
  });

  it("assigns kind='function' to non-REST actions", () => {
    const cs = candidates(SOURCE, "orders_controller.rb");
    const search = cs.find((c) => c.name.endsWith("#search"))!;
    expect(search.kind).toBe("function");
    const exp = cs.find((c) => c.name.endsWith("#export_csv"))!;
    expect(exp.kind).toBe("function");
  });

  it("does not add HTTP route hints to custom actions", () => {
    const cs = candidates(SOURCE, "orders_controller.rb");
    const search = cs.find((c) => c.name.endsWith("#search"))!;
    expect(search.hints.httpRoute).toBeUndefined();
  });
});

// ---- Private / protected section gate ------------------------------------

describe("parseRuby: visibility", () => {
  it("excludes everything after a standalone `private` keyword", () => {
    const source = `
class ArticlesController < ApplicationController
  def show
    @article = Article.find(params[:id])
  end

  private

  def set_article
    @article = Article.find(params[:id])
  end

  def article_params
    params.require(:article).permit(:title)
  end
end
`;
    const ns = names(source, "articles_controller.rb");
    expect(ns).toEqual(["ArticlesController#show"]);
    expect(ns).not.toContain("ArticlesController#set_article");
    expect(ns).not.toContain("ArticlesController#article_params");
  });

  it("excludes everything after a standalone `protected` keyword", () => {
    const source = `
class BaseController < ApplicationController
  def index
  end

  protected

  def authorize!
  end
end
`;
    const ns = names(source, "base_controller.rb");
    expect(ns).toEqual(["BaseController#index"]);
  });

  it("skips class methods (def self.foo)", () => {
    const source = `
class UsersController < ApplicationController
  def self.policy_class
    UserPolicy
  end

  def index
    @users = User.all
  end
end
`;
    const ns = names(source);
    expect(ns).toEqual(["UsersController#index"]);
    expect(ns).not.toContain("UsersController#policy_class");
  });
});

// ---- Nested structures inside action bodies ------------------------------

describe("parseRuby: nested block depth", () => {
  it("correctly closes actions that contain if/else/end", () => {
    const source = `
class ItemsController < ApplicationController
  def create
    if @item.save
      redirect_to @item
    else
      render :new
    end
  end

  def destroy
    @item.destroy
    redirect_to items_path
  end
end
`;
    const ns = names(source, "items_controller.rb");
    expect(ns).toEqual(["ItemsController#create", "ItemsController#destroy"]);
  });

  it("correctly closes actions that contain case/when/end", () => {
    const source = `
class PaymentsController < ApplicationController
  def create
    case params[:method]
    when "card"
      charge_card
    when "paypal"
      charge_paypal
    end
  end

  def show
    @payment = Payment.find(params[:id])
  end
end
`;
    const ns = names(source, "payments_controller.rb");
    expect(ns).toEqual(["PaymentsController#create", "PaymentsController#show"]);
  });

  it("correctly handles do...end blocks inside action bodies", () => {
    const source = `
class ReportsController < ApplicationController
  def index
    @reports = Report.all.tap do |r|
      r.map { |x| x.sanitize! }
    end
  end

  def show
    @report = Report.find(params[:id])
  end
end
`;
    const ns = names(source, "reports_controller.rb");
    expect(ns).toEqual(["ReportsController#index", "ReportsController#show"]);
  });

  it("handles begin/rescue/end inside actions without breaking the chain", () => {
    const source = `
class WebhooksController < ApplicationController
  def receive
    begin
      process_payload(request.body.read)
    rescue JSON::ParserError
      head :bad_request
    end
  end

  def status
    render json: { ok: true }
  end
end
`;
    const ns = names(source, "webhooks_controller.rb");
    expect(ns).toEqual([
      "WebhooksController#receive",
      "WebhooksController#status",
    ]);
  });
});

// ---- Class name / filename derivation ------------------------------------

describe("parseRuby: class and name derivation", () => {
  it("derives class name from source over filename", () => {
    const source = `
class Admin::UsersController < ApplicationController
  def index
    @users = User.all
  end
end
`;
    const cs = candidates(source, "users_controller.rb");
    expect(cs[0]?.name).toBe("Admin::UsersController#index");
  });

  it("falls back to CamelCase from filename when class declaration is absent", () => {
    // Edge case: no class keyword in the file (unusual but shouldn't crash).
    const source = "def index\n  render :index\nend\n";
    // parseRuby returns empty because there is no `class` block.
    expect(candidates(source)).toHaveLength(0);
  });

  it("derives filename class name: snake_case -> CamelCase + Controller suffix", () => {
    const source = `
class LineItemsController < ApplicationController
  def index
  end
end
`;
    const cs = candidates(source, "line_items_controller.rb");
    expect(cs[0]?.name).toBe("LineItemsController#index");
  });
});

// ---- Line number accuracy ------------------------------------------------

describe("parseRuby: line numbers", () => {
  it("reports the correct 1-indexed lineStart for each action", () => {
    const source = [
      "class UsersController < ApplicationController", // line 1
      "  def index",                                    // line 2
      "    @users = User.all",                          // line 3
      "  end",                                          // line 4
      "",
      "  def show",                                     // line 6
      "    @user = User.find(params[:id])",              // line 7
      "  end",                                          // line 8
      "end",                                            // line 9
    ].join("\n");
    const cs = candidates(source);
    const index = cs.find((c) => c.name.endsWith("#index"))!;
    const show = cs.find((c) => c.name.endsWith("#show"))!;
    expect(index.lineStart).toBe(2);
    expect(show.lineStart).toBe(6);
  });
});

// ---- Parameters ----------------------------------------------------------

describe("parseRuby: parameter hints", () => {
  it("extracts parameters from the method signature", () => {
    const source = `
class UsersController < ApplicationController
  def create(format = :json)
    @user = User.new(user_params)
  end
end
`;
    const cs = candidates(source);
    const create = cs[0]!;
    expect(create.hints.parameters).toBeDefined();
    expect(create.hints.parameters!.map((p) => p.name)).toContain("format");
  });

  it("strips the trailing colon from required keyword args", () => {
    // Required kwarg syntax: `def foo(name:)`. Before the fix, the
    // identifier kept its trailing colon ("name:"), defeating any
    // downstream lookup that compares hint names to call-site params.
    const source = `
class UsersController < ApplicationController
  def create(name:, email:)
    @user = User.new(name: name, email: email)
  end
end
`;
    const cs = candidates(source);
    const names = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names).toEqual(["name", "email"]);
  });

  it("strips the default value from optional keyword args", () => {
    // Kwarg with default: `def foo(age: 18)`. Before the fix, the
    // identifier captured the colon AND the literal default
    // ("age: 18"), conflating two separate fields.
    const source = `
class UsersController < ApplicationController
  def create(age: 18, role: :member)
    @user = User.create(age: age, role: role)
  end
end
`;
    const cs = candidates(source);
    const names = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names).toEqual(["age", "role"]);
  });

  it("strips splat / double-splat / block prefixes", () => {
    const source = `
class UsersController < ApplicationController
  def create(*positional, **opts, &block)
    yield(*positional, **opts) if block
  end
end
`;
    const cs = candidates(source);
    const names = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names).toEqual(["positional", "opts", "block"]);
  });

  it("captures parameters when the signature wraps across multiple lines", () => {
    // Real-world Rails: long parameter lists wrap. Before the fix the
    // single-line regex stopped at `def create(`, saw no closing `)`, and
    // dropped hints.parameters entirely.
    const source = `
class UsersController < ApplicationController
  def create(
    name:,
    email:,
    age: 18
  )
    @user = User.new(name: name, email: email, age: age)
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.parameters).toBeDefined();
    const names = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names).toEqual(["name", "email", "age"]);
  });

  it("captures a mixed multi-line signature: positional + kwarg + splat + block", () => {
    // Same Rails-shape `link_to` as the single-line case below, but wrapped.
    const source = `
class UsersController < ApplicationController
  def link_to(
    text,
    url:,
    **options,
    &block
  )
    tag.a(text, href: url, **options)
  end
end
`;
    const cs = candidates(source);
    const names = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names).toEqual(["text", "url", "options", "block"]);
  });

  it("includes multi-line signature lines in the extracted source", () => {
    // Regression guard: the body extractor must not stop early or skip
    // the param-block lines when the signature wraps. The full def +
    // body + end should land in `source`.
    const source = `
class UsersController < ApplicationController
  def create(
    name:,
    email:
  )
    @user = User.new(name: name, email: email)
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.source).toContain("def create(");
    expect(cs[0]?.source).toContain("name:");
    expect(cs[0]?.source).toContain("@user = User.new");
    expect(cs[0]?.source).toMatch(/\bend\b/);
  });

  it("handles a mixed signature: positional + kwarg + double-splat + block", () => {
    // Real-Rails shape: `def link_to(text, url:, **options, &block)`.
    const source = `
class UsersController < ApplicationController
  def link_to(text, url:, **options, &block)
    tag.a(text, href: url, **options)
  end
end
`;
    const cs = candidates(source);
    const names = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names).toEqual(["text", "url", "options", "block"]);
  });

  it("does not leak phantom params from an array default", () => {
    // Pre-fix `paramStr.split(",")` chopped `[1, 2, 3]` into separate
    // fragments and the `\w+` extractor produced phantom params
    // `{name: "2"}` and `{name: "3"}`. The LLM would document those as
    // real arguments. Mirror of the Django generic-type fix (5329157).
    const source = `
class PostsController < ApplicationController
  def show(slug, items = [1, 2, 3])
    head :ok
  end
end
`;
    const cs = candidates(source);
    const names = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names).toEqual(["slug", "items"]);
  });

  it("does not leak phantom params from a hash default", () => {
    // Same bug class as the array case but via `{` / `}`. Pre-fix
    // `opts = {a: 1, b: 2}` produced a phantom `{name: "b"}` because the
    // top-level split chopped at the comma inside the hash literal and the
    // `\w+` extractor grabbed `b` from the `b: 2` fragment.
    const source = `
class PostsController < ApplicationController
  def show(slug, opts = {a: 1, b: 2})
    head :ok
  end
end
`;
    const cs = candidates(source);
    const names = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names).toEqual(["slug", "opts"]);
  });

  it("does not leak phantom params from a nested array + hash default", () => {
    // Combined shape: both `[` and `{` defaults in one signature. Pre-fix
    // produced 5 phantom entries (`2`, `3`, `b`) alongside the 3 real
    // params. Single-line all-shapes regression.
    const source = `
class PostsController < ApplicationController
  def show(slug, items = [1, 2, 3], opts = {a: 1, b: 2})
    head :ok
  end
end
`;
    const cs = candidates(source);
    const names = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names).toEqual(["slug", "items", "opts"]);
  });

  it("does not leak phantom params from a nested array inside a hash default", () => {
    // Hash whose value is an array. Both bracket depths nested. Pre-fix
    // the commas inside `[1, 2]` AND between hash keys both broke the
    // split, producing multiple phantom entries.
    const source = `
class PostsController < ApplicationController
  def show(slug, config = {tags: [1, 2], mode: :strict})
    head :ok
  end
end
`;
    const cs = candidates(source);
    const names = cs[0]!.hints.parameters!.map((p) => p.name);
    expect(names).toEqual(["slug", "config"]);
  });
});

// ---- Source extraction ---------------------------------------------------

describe("parseRuby: source extraction", () => {
  it("includes the def line and the matching end in the extracted source", () => {
    const source = `
class UsersController < ApplicationController
  def index
    @users = User.all
    render :index
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.source).toContain("def index");
    expect(cs[0]?.source).toContain("render :index");
    expect(cs[0]?.source).toMatch(/\bend\b/);
  });
});
