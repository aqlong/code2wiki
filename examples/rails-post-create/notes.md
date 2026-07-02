# Notes: Ruby on Rails -- Create a Blog Post

## Why this is a good first Ruby/Rails example

- **Pattern coverage:** `PostsController#create` is the single most common Rails controller action pattern (RESTful CRUD creation). Every Rails app with user-owned content has this shape.
- **Auth surface:** `before_action :authenticate_user!` is the Devise idiom. It applies class-wide with no `only:` qualifier, so it fires before every action in the controller -- a meaningful difference from per-function decorators like Python's `@login_required` or Java's method-level `@PreAuthorize`.
- **Ownership via association scope:** `current_user.posts.build(post_params)` enforces ownership at the ActiveRecord association level rather than via an explicit permission check or `user_id` assignment. A doc generator must surface this invariant; it is not visible as a guard clause or annotation.
- **ActionMailer side effect:** `deliver_later` is asynchronous background email dispatch -- observable in production (mail queue, delivery logs) but invisible to the user in the HTTP response. Important for QA and ops.
- **Strong params as access-control boundary:** `post_params` is both input validation and an explicit whitelist of writable fields. A spoofed `user_id` in the form body is stripped here, not caught downstream.
- **Turbo-compatible 422:** `render :new, status: :unprocessable_entity` is the Rails 7 / Hotwire convention for form validation failures. The 422 status code matters for Turbo Streams; a naive `render :new` returning HTTP 200 breaks Turbo-driven form-error handling.

## Edge cases the gold standard exercises

- **`before_action` class-wide vs. action-scoped:** `authenticate_user!` has no `only:` or `except:` qualifier, so it applies unconditionally to every action. The doc makes this explicit rather than implying it only guards `create`.
- **Scoped build vs. explicit assign:** `current_user.posts.build` is meaningfully different from `Post.new(user: current_user)`: it also constrains subsequent queries through the association (`.find`, `.where`) to the owner's records. The notes surface the ownership implication without diving into ActiveRecord internals.
- **`deliver_later` is non-blocking and non-transactional:** If the job queue is unavailable, the post is still created and the redirect still fires. The email failure is deferred silently. Audit-aware docs and test scenarios must note this decoupling.
- **`status: :unprocessable_entity` is the correct Rails 7 convention:** The gold standard's test scenario for the validation-failure path asserts on HTTP 422, not 200. This is load-bearing for teams using Hotwire/Turbo.

## What a wrong/bad output would look like (anti-patterns to avoid)

- Describing `before_action :authenticate_user!` as "added for security" without noting that it applies to every action in the controller, not just `create`.
- Treating `deliver_later` as an implementation detail rather than documenting it as an asynchronous email side-effect that is observable independently of the web request.
- Describing `current_user.posts.build` as "builds a new post" without noting that the current user becomes the owner automatically and cannot be overridden by the form submission.
- Omitting the strong-params whitelist as a business rule (only the four listed fields can be set by the submitting user).
- Writing test scenarios that cover only success + blank-title and miss the unauthenticated, spoofed-user_id, and mail-queue-failure cases.
- Asserting HTTP 200 for the validation-failure path (should be 422).

## Confidence rating: high

All business rules are explicit in the controller code. No cross-file inference is needed to understand ownership or auth behavior; both use well-known Rails/Devise idioms. The ActionMailer call is explicit and unambiguous.
