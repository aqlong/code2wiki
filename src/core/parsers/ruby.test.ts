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

  it("matches the basename case-insensitively (parity with the dispatcher)", () => {
    // parsers/index.ts dispatches on path.extname(...).toLowerCase(), so a
    // Windows-origin file like Users_Controller.RB routes through to parseRuby.
    // The basename gate must accept the same set or the file silently drops.
    const source = "class UsersController < ApplicationController\n  def index\n  end\nend\n";
    expect(
      parseRuby(
        "/app/controllers/Users_Controller.RB",
        "app/controllers/Users_Controller.RB",
        source,
      ),
    ).toHaveLength(1);
    expect(
      parseRuby(
        "/app/controllers/users_controller.RB",
        "app/controllers/users_controller.RB",
        source,
      ),
    ).toHaveLength(1);
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

  // --- before_action / auth notes ---

  it("surfaces a global before_action in notes for every action", () => {
    const source = `
class ArticlesController < ApplicationController
  before_action :authenticate_user!

  def index
    @articles = Article.all
  end
  def show
    @article = Article.find(params[:id])
  end
  def create
    @article = Article.new(article_params)
  end
end
`;
    const cs = candidates(source);
    expect(cs).toHaveLength(3);
    for (const c of cs) {
      expect(c.hints.notes).toEqual(["before_action: :authenticate_user!"]);
    }
  });

  it("scopes before_action with only: to the listed actions", () => {
    const source = `
class PostsController < ApplicationController
  before_action :authenticate_user!, only: [:create, :update, :destroy]

  def index
    @posts = Post.all
  end
  def create
    @post = Post.new(post_params)
  end
  def update
    @post = Post.find(params[:id])
  end
  def destroy
    Post.find(params[:id]).destroy
  end
end
`;
    const cs = candidates(source);
    const byName = Object.fromEntries(cs.map((c) => [c.name.split("#")[1], c]));
    expect(byName["index"]?.hints.notes).toBeUndefined();
    expect(byName["create"]?.hints.notes).toEqual(["before_action: :authenticate_user!"]);
    expect(byName["update"]?.hints.notes).toEqual(["before_action: :authenticate_user!"]);
    expect(byName["destroy"]?.hints.notes).toEqual(["before_action: :authenticate_user!"]);
  });

  it("scopes before_action with except: to all actions not in the list", () => {
    const source = `
class OrdersController < ApplicationController
  before_action :require_login, except: [:index, :show]

  def index
    @orders = Order.all
  end
  def show
    @order = Order.find(params[:id])
  end
  def create
    @order = Order.new(order_params)
  end
end
`;
    const cs = candidates(source);
    const byName = Object.fromEntries(cs.map((c) => [c.name.split("#")[1], c]));
    expect(byName["index"]?.hints.notes).toBeUndefined();
    expect(byName["show"]?.hints.notes).toBeUndefined();
    expect(byName["create"]?.hints.notes).toEqual(["before_action: :require_login"]);
  });

  it("accumulates multiple before_action callbacks in order", () => {
    const source = `
class AdminController < ApplicationController
  before_action :authenticate_user!
  before_action :require_admin

  def dashboard
    render :dashboard
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.notes).toEqual([
      "before_action: :authenticate_user!, :require_admin",
    ]);
  });

  it("handles before_action with %i[] symbol-array syntax", () => {
    const source = `
class ItemsController < ApplicationController
  before_action :verify_token, only: %i[create destroy]

  def index
    @items = Item.all
  end
  def create
    @item = Item.new(item_params)
  end
  def destroy
    Item.find(params[:id]).destroy
  end
end
`;
    const cs = candidates(source);
    const byName = Object.fromEntries(cs.map((c) => [c.name.split("#")[1], c]));
    expect(byName["index"]?.hints.notes).toBeUndefined();
    expect(byName["create"]?.hints.notes).toEqual(["before_action: :verify_token"]);
    expect(byName["destroy"]?.hints.notes).toEqual(["before_action: :verify_token"]);
  });

  it("accepts before_filter as a synonym for before_action", () => {
    const source = `
class LegacyController < ApplicationController
  before_filter :login_required

  def index
    @records = Record.all
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.notes).toEqual(["before_action: :login_required"]);
  });
});

// ---- ActiveRecord model extraction (databaseTables) ---------------------

describe("parseRuby: ActiveRecord model extraction", () => {
  it("extracts a single model from Model.where in index action", () => {
    const source = `
class ArticlesController < ApplicationController
  def index
    @articles = Article.where(published: true)
    render :index
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toEqual(["Article"]);
  });

  it("extracts multiple distinct models from a single action", () => {
    const source = `
class DashboardController < ApplicationController
  def show
    @user = User.find(params[:id])
    @posts = Post.where(author: @user)
    @tags = Tag.all
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toEqual(
      expect.arrayContaining(["User", "Post", "Tag"]),
    );
    expect(cs[0]?.hints.databaseTables).toHaveLength(3);
  });

  it("deduplicates repeated calls to the same model", () => {
    const source = `
class ArticlesController < ApplicationController
  def show
    @article = Article.find(params[:id])
    @related = Article.where(category_id: @article.category_id).limit(5)
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toEqual(["Article"]);
  });

  it("does not record Ruby stdlib classes called with AR-like methods", () => {
    const source = `
class WidgetsController < ApplicationController
  def new
    @items = Array.new
    @widget = Widget.new
  end
end
`;
    const cs = candidates(source);
    // Array is excluded; Widget is an AR model
    expect(cs[0]?.hints.databaseTables).toEqual(["Widget"]);
  });

  it("leaves databaseTables undefined when no AR model call is present", () => {
    const source = `
class PingsController < ApplicationController
  def index
    render json: { ok: true }
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toBeUndefined();
  });

  it("extracts models from create! and update_all patterns", () => {
    const source = `
class OrdersController < ApplicationController
  def create
    Order.create!(order_params)
    LineItem.update_all(status: :pending)
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.databaseTables).toEqual(
      expect.arrayContaining(["Order", "LineItem"]),
    );
  });

  // AR_CLASS_METHODS at ruby.ts:92-99 has 30 entries; only 6 (where, find, all,
  // create!, update_all, new) were directly pinned before this test. A
  // single-entry deletion would silently degrade hints.databaseTables for real
  // Rails apps using that AR pattern. This per-entry loop pin defends every
  // entry at once: if a future refactor drops one, the `expect(..., msg)`
  // failure names which method regressed.
  it("extracts Widget for every AR_CLASS_METHODS entry (defends array-deletion drift)", () => {
    const methods = [
      "all", "find", "find_by", "find_by!", "find_or_create_by", "find_or_initialize_by",
      "where", "first", "last", "count", "sum", "average", "minimum", "maximum",
      "ids", "pluck", "exists?", "any?", "many?",
      "create", "create!", "update_all", "destroy_all", "delete_all",
      "insert", "upsert", "insert_all", "upsert_all",
      "new", "build",
    ];
    for (const m of methods) {
      const source = `
class WidgetsController < ApplicationController
  def index
    Widget.${m}
  end
end
`;
      const cs = candidates(source);
      expect(
        cs[0]?.hints.databaseTables,
        `Widget.${m} should mark Widget as AR model`,
      ).toEqual(["Widget"]);
    }
  });
});

// ---- Function callee extraction (callees) --------------------------------

describe("parseRuby: callee extraction", () => {
  it("surfaces helper method calls from the action body", () => {
    const source = `
class OrdersController < ApplicationController
  def create
    validate_order(params)
    order = build_order(params)
    send_confirmation(order)
    render json: order
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.callees).toEqual(
      expect.arrayContaining(["validate_order", "build_order", "send_confirmation"]),
    );
  });

  it("excludes Ruby keywords from callees", () => {
    const source = `
class ItemsController < ApplicationController
  def index
    @items = Item.all
    render json: @items
  end
end
`;
    const cs = candidates(source);
    const callees = cs[0]?.hints.callees ?? [];
    expect(callees).not.toContain("if");
    expect(callees).not.toContain("return");
    expect(callees).not.toContain("include");
  });

  it("leaves callees undefined when action body has no qualifying calls", () => {
    const source = `
class PingsController < ApplicationController
  def ping
    ok
  end
end
`;
    const cs = candidates(source);
    expect(cs[0]?.hints.callees).toBeUndefined();
  });
});

// ---- Side-effect notes (email, background jobs, HTTP) --------------------

describe("parseRuby: side-effect notes", () => {
  it("surfaces 'Sends email (ActionMailer)' when deliver_later is called", () => {
    const source = `
class RegistrationsController < ApplicationController
  def create
    @user = User.create!(user_params)
    WelcomeMailer.welcome(@user).deliver_later
    redirect_to root_path
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Sends email (ActionMailer)")).toBe(true);
  });

  it("surfaces 'Sends email (ActionMailer)' for deliver_now", () => {
    const source = `
class PasswordsController < ApplicationController
  def reset
    PasswordMailer.reset(@user).deliver_now
    head :ok
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Sends email (ActionMailer)")).toBe(true);
  });

  it("surfaces 'Enqueues background job' when perform_later is called", () => {
    const source = `
class UploadsController < ApplicationController
  def create
    @upload = Upload.create!(file: params[:file])
    ProcessUploadJob.perform_later(@upload.id)
    render json: @upload
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Enqueues background job")).toBe(true);
  });

  it("surfaces 'Makes outbound HTTP request' when HTTParty is used", () => {
    const source = `
class WebhooksController < ApplicationController
  def create
    HTTParty.post('https://hooks.example.com', body: request.body.read)
    head :ok
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Makes outbound HTTP request")).toBe(true);
  });

  it("does not add side-effect notes for plain controller actions", () => {
    const source = `
class ArticlesController < ApplicationController
  def index
    @articles = Article.all
    render json: @articles
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.every((n) => !n.includes("email") && !n.includes("job") && !n.includes("HTTP"))).toBe(true);
  });

  // The three side-effect regexes have multiple alternatives. A single-entry
  // deletion would silently degrade hint coverage. These loops pin every
  // alternative so a future refactor that drops one trips a named failure.

  it("ActionMailer regex covers all 4 deliver_* variants", () => {
    const variants = ["deliver_later", "deliver_now", "deliver_later!", "deliver_now!"];
    for (const v of variants) {
      const source = `
class M < ApplicationController
  def send_it
    SomeMailer.welcome(@user).${v}
    head :ok
  end
end
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${v} should emit ActionMailer note`).toContain("Sends email (ActionMailer)");
    }
  });

  it("background-job regex covers all 4 perform_* variants", () => {
    const variants = ["perform_later", "perform_async", "perform_in", "perform_at"];
    for (const v of variants) {
      // perform_in / perform_at typically take a time as the first arg; use a
      // placeholder identifier so the source parses as valid Ruby.
      const args = (v === "perform_in" || v === "perform_at") ? "(1.hour, 42)" : "(42)";
      const source = `
class M < ApplicationController
  def enqueue
    SomeJob.${v}${args}
    head :ok
  end
end
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${v} should emit background-job note`).toContain("Enqueues background job");
    }
  });

  it("HTTP regex covers all 4 client patterns", () => {
    const probes = [
      { token: "HTTParty.get('https://x.com')", label: "HTTParty" },
      { token: "Faraday.get('https://x.com')", label: "Faraday" },
      { token: "RestClient.get('https://x.com')", label: "RestClient" },
      { token: "Net::HTTP.get(URI('https://x.com'))", label: "Net::HTTP" },
    ];
    for (const { token, label } of probes) {
      const source = `
class M < ApplicationController
  def fetch
    ${token}
    head :ok
  end
end
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${label} should emit HTTP note`).toContain("Makes outbound HTTP request");
    }
  });

  it("surfaces 'Writes to file system' for File.write / FileUtils.cp / Dir.mkdir", () => {
    const source = `
class ExportsController < ApplicationController
  def csv
    Dir.mkdir(Rails.root.join("tmp", "exports")) unless Dir.exist?(path)
    File.write(Rails.root.join("tmp", "exports", "users.csv"), build_csv)
    FileUtils.cp(src, dest)
    head :ok
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Writes to file system");
  });

  it("surfaces 'Writes to file system' for File.open with write or append mode", () => {
    const source = `
class LogController < ApplicationController
  def append
    File.open("/var/log/app.log", "a") do |f|
      f.write(params[:entry])
    end
    head :ok
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Writes to file system");
  });

  it("does NOT surface filesystem note for read-only file operations", () => {
    const source = `
class ImportController < ApplicationController
  def load
    contents = File.read("/tmp/in.csv")
    lines = File.readlines("/tmp/other.csv")
    exists = File.exist?("/tmp/x.csv")
    head :ok
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Writes to file system")).toBe(false);
  });

  it("File mutator regex covers all 7 alternatives", () => {
    const mutators = ["write", "delete", "rename", "truncate", "unlink", "chmod", "chown"];
    for (const m of mutators) {
      const source = `
class T < ApplicationController
  def run
    File.${m}("/tmp/x", arg)
    head :ok
  end
end
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `File.${m} should emit filesystem note`).toContain("Writes to file system");
    }
  });

  it("FileUtils mutator regex covers all 14 alternatives", () => {
    const mutators = [
      "cp", "cp_r", "mv", "rm", "rm_f", "rm_rf",
      "mkdir", "mkdir_p", "touch", "chmod", "chown",
      "ln", "ln_s", "remove",
    ];
    for (const m of mutators) {
      const source = `
class T < ApplicationController
  def run
    FileUtils.${m}("/tmp/x")
    head :ok
  end
end
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `FileUtils.${m} should emit filesystem note`).toContain("Writes to file system");
    }
  });

  it("Dir mutator regex covers all 4 alternatives", () => {
    const mutators = ["mkdir", "rmdir", "delete", "unlink"];
    for (const m of mutators) {
      const source = `
class T < ApplicationController
  def run
    Dir.${m}("/tmp/x")
    head :ok
  end
end
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `Dir.${m} should emit filesystem note`).toContain("Writes to file system");
    }
  });

  it("transaction note fires for Model.transaction do ... end", () => {
    const source = `
class TransfersController < ApplicationController
  def create
    Account.transaction do
      sender.debit!(params[:amount])
      receiver.credit!(params[:amount])
    end
    head :ok
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes within a database transaction");
  });

  it("transaction note fires for ActiveRecord::Base.transaction { ... } curly form", () => {
    const source = `
class OrdersController < ApplicationController
  def cancel
    ActiveRecord::Base.transaction { @order.cancel!; @order.refund! }
    head :ok
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes within a database transaction");
  });

  it("transaction note fires for Model.transaction(args) do form", () => {
    const source = `
class CheckoutsController < ApplicationController
  def submit
    ApplicationRecord.transaction(requires_new: true) do
      @cart.checkout!
    end
    head :ok
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes within a database transaction");
  });

  it("transaction note does NOT fire for transaction_id / transactions accessors", () => {
    // Defensive: the field-access patterns common in finance apps should NOT
    // trip the transaction-block detector. The regex requires a do/curly/paren
    // immediately after `.transaction`, which these accessors don't have.
    const source = `
class StatementsController < ApplicationController
  def show
    id = @record.transaction_id
    history = @account.transactions
    render json: { id: id, history: history }
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n.includes("database transaction"))).toBe(false);
  });

  it("cache-mutation note fires for Rails.cache.write / .delete / .clear", () => {
    const source = `
class FeedController < ApplicationController
  def refresh
    Rails.cache.write("feed:#{current_user.id}", build_feed)
    Rails.cache.delete("stale:#{current_user.id}")
    head :ok
  end

  def flush_all
    Rails.cache.clear
    head :ok
  end
end
`;
    const cs = candidates(source);
    const refreshNotes = cs[0]?.hints.notes ?? [];
    const flushNotes = cs[1]?.hints.notes ?? [];
    expect(refreshNotes).toContain("Mutates application cache");
    expect(flushNotes).toContain("Mutates application cache");
  });

  it("cache-mutation note fires for delete_matched (pattern invalidation, high blast radius)", () => {
    const source = `
class CategoriesController < ApplicationController
  def reindex
    Rails.cache.delete_matched("category/*")
    head :ok
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Mutates application cache");
  });

  // The Rails.cache regex at ruby.ts enumerates 6 mutating method alternatives
  // (write, write_multi, delete, delete_matched, delete_multi, clear). The
  // bundled "write / .delete / .clear" test above co-locates 3 alternatives
  // across 2 actions, so it only individually defends `write` (refresh action
  // uses only write). The "delete_matched" test isolates the high-blast-radius
  // pattern variant. That leaves `write_multi` and `delete_multi` (the bulk
  // batch-job variants) undefended -- a refactor that drops either silently
  // degrades the Notes signal for any Rails shop using bulk writes / deletes.
  // Per-alt loop mirrors the JAVA_CACHE_MUTATION_ANNOTATIONS pin in
  // java.test.ts (commit 2fe3678) so each of the 6 alternatives has its own
  // isolated fixture + named failure assertion.
  it("Rails.cache mutation regex covers all 6 method alternatives", () => {
    const variants = [
      "write",
      "write_multi",
      "delete",
      "delete_matched",
      "delete_multi",
      "clear",
    ];
    for (const v of variants) {
      const call = v === "clear" ? "Rails.cache.clear" : `Rails.cache.${v}("k")`;
      const source = `
class T${v.replace(/_/g, "")}Controller < ApplicationController
  def op
    ${call}
    head :ok
  end
end
`;
      const cs = candidates(source, `t${v.replace(/_/g, "")}_controller.rb`);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `Rails.cache.${v} should emit cache-mutation note`).toContain(
        "Mutates application cache",
      );
    }
  });

  it("cache-mutation note does NOT fire for Rails.cache.read / .fetch / .exist?", () => {
    // Read-only access (.read and .fetch read-through) is intentionally NOT
    // flagged. No blast radius beyond cache miss.
    const source = `
class CachedController < ApplicationController
  def show
    @data = Rails.cache.fetch("feed:#{id}") { build_feed }
    @other = Rails.cache.read("other_key")
    @exists = Rails.cache.exist?("yet_another")
    render json: @data
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n.includes("cache"))).toBe(false);
  });

  it("process-execution note fires for system(...) and parenless system 'cmd'", () => {
    const source = `
class JobsController < ApplicationController
  def run_paren
    system("ls -la #{params[:dir]}")
    head :ok
  end

  def run_string
    system 'echo hi'
    head :ok
  end

  def run_single_quote
    system('mkdir -p /tmp/uploads')
    head :ok
  end
end
`;
    const cs = candidates(source);
    expect(cs).toHaveLength(3);
    for (const candidate of cs) {
      const notes = candidate.hints.notes ?? [];
      expect(notes, `${candidate.name} should emit process-execution note`).toContain("Executes external process");
    }
  });

  it("process-execution note fires for backtick command literal", () => {
    const source = `
class StatsController < ApplicationController
  def show
    output = \`uname -a\`
    render plain: output
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Executes external process");
  });

  it("process-execution note fires for IO.popen / Process.spawn / Open3 variants", () => {
    const probes = [
      { body: "io = IO.popen('git log')", label: "IO.popen" },
      { body: "Process.spawn('rake task')", label: "Process.spawn" },
      { body: "Process.exec('echo hi')", label: "Process.exec" },
      { body: "Open3.popen3('ffmpeg -i in.mp4 out.mp3')", label: "Open3.popen3" },
      { body: "stdout, stderr, status = Open3.capture3('git status')", label: "Open3.capture3" },
      { body: "stdout, status = Open3.capture2('ls')", label: "Open3.capture2" },
      { body: "stdout, status = Open3.capture2e('uname -a')", label: "Open3.capture2e" },
    ];
    for (const { body, label } of probes) {
      const source = `
class T < ApplicationController
  def op
    ${body}
    head :ok
  end
end
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${label} should emit process-execution note`).toContain("Executes external process");
    }
  });

  it("process-execution note does NOT fire for incidental 'system' attribute access or constants", () => {
    // Defensive: the `system\s*[("']` matcher requires the next token to be
    // an opening paren or quote so it doesn't trip on attribute reads or
    // class constants that happen to use the word "system".
    const source = `
class StatusController < ApplicationController
  def show
    name = @record.system_name
    role = User::SYSTEM_USER
    render json: { name: name, role: role.to_s }
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Executes external process")).toBe(false);
  });

  // The transaction regex `/\.transaction\s*(?:do\b|\{|\()/` has two
  // structural safety boundaries beyond the block-delimiter requirement
  // already pinned above:
  //   1. The literal `\.` prefix filters out bare-receiver calls and any
  //      identifier that ends in `transaction` (e.g. a custom DSL method).
  //   2. The exact identifier `transaction` (no trailing word chars) filters
  //      out token-prefix matches like `.transactional` because the next
  //      required char after `transaction` is `do`/`{`/`(`/whitespace, not
  //      a continuation letter.
  // Each negative below catches a distinct hypothetical widening of the
  // regex, so the loop's named-failure form ties each scenario to the
  // specific guard it defends:
  //   - dropping `\.`           -> bare-form false-positive
  //   - relaxing the alternation -> .transactional false-positive
  it("transaction note does NOT fire for bare-receiver or token-prefix forms", () => {
    const negatives: { label: string; body: string }[] = [
      {
        label: "bare `transaction do` (no `.` prefix)",
        body: "transaction do\n      perform_transfer(params[:amount])\n    end",
      },
      {
        label: "`.transactional do` (token-prefix, not `.transaction`)",
        body: "service.transactional do\n      service.commit\n    end",
      },
    ];
    for (const { label, body } of negatives) {
      const source = `
class TransfersController < ApplicationController
  def create
    ${body}
    head :ok
  end
end
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(
        notes.some((n) => n.includes("database transaction")),
        `${label} should NOT emit transaction note`,
      ).toBe(false);
    }
  });
});

// ---- Callee noise filter (RUBY_STDLIB_METHODS) ---------------------------

describe("parseRuby: stdlib callee noise filter", () => {
  it("filters constructor / Enumerable / format / logger noise from callees", () => {
    const source = `
class OrdersController < ApplicationController
  def index
    @orders = Order.where(user_id: current_user.id).inject([]) do |acc, o|
      acc << build_summary(o)
    end
    Rails.logger.info("computed #{@orders.size} orders")
    respond_with(@orders.group_by { |o| o.status })
  end

  def create
    @order = Order.new(build_order_params(params))
    sprintf("ORD-%05d", @order.id)
  end
end
`;
    const cs = candidates(source);
    // index action: business signal stays, stdlib filtered.
    const indexCallees = cs[0]?.hints.callees ?? [];
    expect(indexCallees).toContain("build_summary");
    expect(indexCallees).toContain("respond_with");
    expect(indexCallees).not.toContain("inject");
    expect(indexCallees).not.toContain("info");
    expect(indexCallees).not.toContain("group_by");
    // create action: constructor and sprintf filtered, business helper stays.
    const createCallees = cs[1]?.hints.callees ?? [];
    expect(createCallees).not.toContain("new");
    expect(createCallees).not.toContain("sprintf");
    expect(createCallees).toContain("build_order_params");
  });

  it("RUBY_STDLIB_METHODS covers every documented alternative (defends set-deletion drift)", () => {
    // Each entry in the RUBY_STDLIB_METHODS set is filtered. A single-entry
    // deletion would silently let that noise back into the callees hint.
    const stdlibMethods = [
      "new",
      "to_a", "to_h", "to_sym", "to_str", "to_f", "to_r", "to_c", "to_proc",
      "each_with_index", "each_with_object", "inject", "flat_map",
      "group_by", "partition", "tally", "min_by", "max_by", "sort_by",
      "take_while", "drop_while", "chunk_while", "slice_when",
      "printf", "sprintf",
      "debug", "info", "warn", "error", "fatal",
    ];
    for (const m of stdlibMethods) {
      const source = `
class TController < ApplicationController
  def index
    obj.${m}(arg)
    do_business_thing
    perform_other_action(42)
  end
end
`;
      const cs = candidates(source);
      const callees = cs[0]?.hints.callees ?? [];
      expect(callees, `${m} should be filtered from callees`).not.toContain(m);
      // Sanity: the business call still surfaces.
      expect(callees, `${m} fixture should still surface perform_other_action`).toContain("perform_other_action");
    }
  });
});

describe("parseRuby: stored procedure notes", () => {
  // Stored procedures appear in Rails controllers that drop to raw SQL via
  // the SQL Server adapter's exec_stored_procedure or via connection.execute
  // with CALL (MySQL) or EXEC (SQL Server) as the first SQL keyword.
  // Audit-critical: the proc may contain triggers, cross-table writes, and
  // logic invisible in the calling controller. Mirrors Django cursor.callproc,
  // C# CommandType.StoredProcedure, Java prepareCall / SimpleJdbcCall, and
  // CFML <cfstoredproc> detection.

  it("surfaces 'Calls stored procedure' for SQL Server adapter exec_stored_procedure", () => {
    const source = `
class ReportsController < ApplicationController
  def annual
    results = connection.exec_stored_procedure('usp_AnnualReport', year: params[:year])
    render json: results
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Calls stored procedure");
  });

  it("surfaces 'Calls stored procedure' for connection.execute with CALL (MySQL)", () => {
    const source = `
class InvoicesController < ApplicationController
  def recalculate
    conn = ActiveRecord::Base.connection
    conn.execute("CALL sp_recalculate_totals(#{params[:invoice_id]})")
    render json: { ok: true }
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Calls stored procedure");
  });

  it("surfaces 'Calls stored procedure' for connection.execute with EXEC (SQL Server)", () => {
    const source = `
class UsersController < ApplicationController
  def sync
    ActiveRecord::Base.connection.execute("EXEC usp_SyncUsers @org_id = #{current_org.id}")
    head :no_content
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Calls stored procedure");
  });

  it("pins both dispatch forms in isolation so a future regex narrowing trips a named failure", () => {
    const probes = [
      { body: "connection.exec_stored_procedure('usp_Foo', id: 1)", label: "exec_stored_procedure" },
      { body: 'ActiveRecord::Base.connection.execute("CALL sp_bar(#{id})")', label: 'execute("CALL ...")' },
      { body: 'conn.execute("EXEC usp_baz @id = #{id}")', label: 'execute("EXEC ...")' },
    ];
    for (const { body, label } of probes) {
      const source = `
class OrdersController < ApplicationController
  def run
    ${body}
    render json: { ok: true }
  end
end
`;
      const cs = candidates(source);
      const notes = cs[0]?.hints.notes ?? [];
      expect(notes, `${label} should emit stored-procedure note`).toContain("Calls stored procedure");
    }
  });

  it("does NOT surface stored-procedure note for plain connection.execute with SELECT", () => {
    const source = `
class SearchController < ApplicationController
  def index
    rows = ActiveRecord::Base.connection.execute("SELECT id, name FROM products WHERE active = 1")
    render json: rows
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n === "Calls stored procedure")).toBe(false);
  });
});

describe("parseRuby: message broker notes (Bunny / Karafka)", () => {
  // Ruby has three dominant broker client libraries. All are audit-critical:
  // the published message leaves the process and may trigger downstream
  // consumers with side effects invisible in the calling code.
  //   - Bunny (RabbitMQ): `Bunny.new(...)` opens the connection; its
  //     presence in a method body is the canonical signal.
  //   - Karafka 2.x (Kafka): `Karafka.producer.produce_sync(...)` and
  //     `Karafka.producer.produce_async(...)` are the two publish paths.
  //   - ruby-kafka: `kafka.deliver_message(...)` is the one-call API.
  // Mirrors Java JMS/AMQP/Kafka and C# MassTransit/Azure Service Bus notes.

  it("surfaces 'Sends message to broker (Bunny / Karafka)' for Bunny.new connection", () => {
    const source = `
class OrdersController < ApplicationController
  def create
    order = Order.create!(order_params)
    conn = Bunny.new(ENV['RABBITMQ_URL'])
    conn.start
    channel = conn.create_channel
    channel.default_exchange.publish(order.to_json, routing_key: 'orders.created')
    conn.close
    render json: order, status: :created
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Sends message to broker (Bunny / Karafka)");
  });

  it("surfaces 'Sends message to broker (Bunny / Karafka)' for Karafka produce_sync", () => {
    const source = `
class ShipmentsController < ApplicationController
  def create
    shipment = Shipment.create!(shipment_params)
    Karafka.producer.produce_sync(
      topic: 'shipments',
      payload: shipment.to_json
    )
    render json: shipment, status: :created
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Sends message to broker (Bunny / Karafka)");
  });

  it("surfaces 'Sends message to broker (Bunny / Karafka)' for Karafka produce_async", () => {
    const source = `
class EventsController < ApplicationController
  def create
    Karafka.producer.produce_async(topic: 'events', payload: params.to_json)
    head :accepted
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Sends message to broker (Bunny / Karafka)");
  });

  it("surfaces 'Sends message to broker (Bunny / Karafka)' for ruby-kafka deliver_message", () => {
    const source = `
class NotificationsController < ApplicationController
  def deliver
    kafka = Kafka.new(seed_brokers: ENV['KAFKA_BROKERS'])
    kafka.deliver_message(params[:payload], topic: 'notifications')
    head :ok
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes).toContain("Sends message to broker (Bunny / Karafka)");
  });

  it("does NOT surface broker note for plain controller with no broker calls", () => {
    const source = `
class ArticlesController < ApplicationController
  def create
    @article = Article.create!(article_params)
    render json: @article, status: :created
  end
end
`;
    const cs = candidates(source);
    const notes = cs[0]?.hints.notes ?? [];
    expect(notes.some((n) => n.startsWith("Sends message to broker"))).toBe(false);
  });
});
