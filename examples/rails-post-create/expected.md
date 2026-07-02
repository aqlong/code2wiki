---
code2wiki_id: ruby-rails-post-create-v1
title: Create a New Blog Post
slug: create-a-new-blog-post
actor: Signed-in user creating a post under their own account
status: active
last_generated: 2026-05-28T00:00:00Z
last_commit: 0000000
confidence: high
source_files:
  - path: examples/rails-post-create/posts_controller.rb
    lines: 7-16
tags:
  - blog
  - post
  - create
  - author-only
notes:
  - "before_action: authenticate_user!"
  - Sends email (ActionMailer)
---

## Summary

A signed-in user fills out the new-post form and submits it. The system validates the inputs, saves the post record under the current user's account, sends a notification email asynchronously, and redirects the author to the newly created post.

## Actor and triggers

- **Actor:** Signed-in user (must be authenticated via Devise).
- **Trigger:** The user submits the new-post form (`POST /posts`).

## Preconditions

- The user is signed in (the request carries a valid session).
- The user has previously navigated to the new-post page (`GET /posts/new`) and filled in the form.

## Main flow

1. The user submits the new-post form.
2. The system verifies the user is signed in.[^auth]
3. The system builds a new post record scoped to the current user, populating only the permitted fields.[^strong-params]
4. The system validates the post and saves it to the database.
5. The system enqueues an email notification to be sent asynchronously.[^mailer]
6. The system sets a success flash message ("Post was successfully created.") and redirects the user to the new post's page.

[^auth]: Enforced by `before_action :authenticate_user!` declared at the top of `PostsController` with no `only:` qualifier. Every action in the controller requires a signed-in session; unauthenticated requests are redirected to the sign-in page before the action runs.
[^strong-params]: `post_params` permits only `:title`, `:body`, `:category_id`, and `:published`. Any other submitted field (such as a spoofed `user_id`) is silently stripped before the record is built.
[^mailer]: `PostMailer.with(post: @post).creation_notice.deliver_later` places the notification on the background job queue. The email is not sent inline and will be delivered after the request completes. A job-queue failure does not affect post creation.

## Alternate and exception flows

- **Validation failure:** If the post fails model validation (e.g., blank title), the system re-renders the new-post form with HTTP 422 and displays the validation errors. No record is saved and no email is enqueued.
- **Unauthenticated request:** The system redirects the user to the sign-in page before the action runs. The original destination is preserved so the user can return after signing in.

## Postconditions

- A new post record exists in the database with `user_id` set to the current user's ID.
- A background email notification job is queued for delivery.
- The user is on the new post's show page.
- A one-time success flash message ("Post was successfully created.") is visible on the next page load.

## Business rules

- **Posts are always owned by the submitting user.** `current_user.posts.build(...)` scopes the new record to the signed-in user at construction time. It is not possible to create a post attributed to a different user through this endpoint.
- **Only permitted fields are accepted.** Strong parameters (`post_params`) explicitly list the four fields the user may supply. Any extra field in the form submission is stripped before the record is built.
- **The user must be signed in to create a post.** The `authenticate_user!` before_action applies to every action in the controller with no exceptions. Anonymous requests cannot reach this action.
- **The notification email is asynchronous and non-transactional.** `deliver_later` places the job in the background queue. A failure in the mail queue does not roll back the post record or prevent the redirect to the new post.

## Suggested test scenarios

- **Happy path** -- Given a signed-in user with valid post params, when they POST to `/posts`, then a post record is created with the correct `user_id`, a mail job is enqueued, and the response redirects to the new post.
- **Blank title** -- Given a signed-in user submitting a post with an empty title, when they POST, then no record is saved, no mail job is enqueued, and the response is HTTP 422 with the form re-rendered and validation errors visible.
- **Unauthenticated** -- Given a signed-out user, when they POST to `/posts`, then the system redirects to the sign-in page and no post is created.
- **Spoofed user_id** -- Given a signed-in user submitting a form with a `user_id` field pointing to a different account, when they POST, then the submitted `user_id` is stripped by strong params and the post is attributed to the current user.
- **Unpermitted extra fields** -- Given a submission that includes a field not in `post_params` (e.g., `admin: true`), when they POST, then the extra field is silently stripped and the record is saved without it.
- **Mail queue failure** -- Given the background queue is unavailable when a valid post is submitted, then the post record is still created and the redirect still occurs; the email failure is handled asynchronously and does not block the response.

## Related use cases

- [Edit a Blog Post](edit-a-blog-post) -- update an existing post's content and metadata
- [Delete a Blog Post](delete-a-blog-post) -- permanently remove a post the user owns
- [View All Posts](view-all-posts) -- the index page the author can return to after creating

## Source links

<details>
<summary>Implementation files (for developers and auditors)</summary>

- [`posts_controller.rb` lines 7-16](posts_controller.rb) -- `create` action
- [`posts_controller.rb` lines 1-5](posts_controller.rb) -- `before_action` declarations
- [`posts_controller.rb` lines 24-26](posts_controller.rb) -- `post_params` strong-parameter filter
- `app/models/post.rb` -- `Post` model with validation rules
- `app/mailers/post_mailer.rb` -- `PostMailer#creation_notice` mail template
- URL conf: `resources :posts` in `config/routes.rb` (maps `POST /posts` to `PostsController#create`)

</details>

---

<!-- code2wiki:managed:start id=ruby-rails-post-create-v1 -->
*Generated by [code2wiki](https://github.com/craftandship/code2wiki) from commit `0000000` on 2026-05-28.*
*Confidence: **high** -- single-action controller with explicit Devise auth guard and clear ownership scope.*
<!-- code2wiki:managed:end -->
