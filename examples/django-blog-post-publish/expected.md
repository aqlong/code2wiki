---
code2wiki_id: python-django-blog-post-publish-v1
title: Publish a Blog Post
slug: publish-a-blog-post
actor: Signed-in author who owns the draft post
status: active
last_generated: 2026-05-28T00:00:00Z
last_commit: 0000000
confidence: high
source_files:
  - path: examples/django-blog-post-publish/views.py
    lines: 57-67
tags:
  - blog
  - publish
  - author-only
  - state-transition
---

## Summary

A signed-in author clicks "Publish" on one of their draft posts. The system validates that the post is still a draft, stamps the current time as `published_at`, transitions the status to PUBLISHED, and redirects the author back to the now-live post.

## Actor and triggers

- **Actor:** Signed-in author who owns the draft post.
- **Trigger:** The author submits the publish form for a specific post (`POST /blog/posts/{pk}/publish/`).

## Preconditions

- The author is authenticated (the request carries a valid session).
- The post identified by `pk` exists and belongs to the signed-in author.
- The post's current status is `DRAFT`.

## Main flow

1. The author submits the publish form for the selected draft post.
2. The system verifies the author is signed in and that the request is a POST.[^decorators]
3. The system fetches the post, confirming both that it exists and that the signed-in user is its author.[^404]
4. The system checks that the post is currently in DRAFT status.
5. The system sets `status` to PUBLISHED and records the exact time of publication in `published_at`.
6. The system saves only the two changed fields to the database.[^update-fields]
7. The system shows the author a success message ("{title} is now live.") and redirects them to the post's public URL.

[^decorators]: Enforced by `@login_required` (redirects to the login page if unauthenticated) and `@require_POST` (returns HTTP 405 for any non-POST request).
[^404]: `get_object_or_404(Post, pk=pk, author=request.user)` returns a 404 response if the post does not exist or belongs to a different user -- these two failure modes are intentionally indistinguishable to the caller.
[^update-fields]: `post.save(update_fields=["status", "published_at"])` updates only those two columns. Any concurrent edit to other fields (e.g. `body`) on the same row is not overwritten.

## Alternate and exception flows

- **Post is not a draft:** If the post's status is already PUBLISHED (or any non-DRAFT state), the system shows an error message ("Only draft posts can be published.") and redirects back to the post's URL without modifying any data.
- **Post not found or wrong author:** The system returns a 404 response. No distinction is made between "post does not exist" and "post belongs to someone else."
- **Unauthenticated request:** The system redirects the author to the login page. The original destination is preserved in the `next` parameter so they can return after signing in.
- **Non-POST request:** The system returns HTTP 405 Method Not Allowed and does not execute any business logic.

## Postconditions

- The post row has `status = PUBLISHED` and `published_at` set to the timestamp of the request.
- The author is on the post's public URL.
- A one-time success message is visible on the next page load.
- No other fields on the post row are modified.

## Business rules

- **Only the post's author can publish it.** The queryset is scoped to `author=request.user`; a different signed-in user cannot publish another author's post, even with a valid post `pk`.
- **Only DRAFT posts can be published.** A post that is already PUBLISHED cannot be re-published. The system shows an error and takes no action.
- **`published_at` is set at publish time, not at creation.** The timestamp records when the content became visible to readers, not when the draft was first saved.
- **The publish endpoint accepts POST only.** A GET to the publish URL returns 405 rather than triggering the transition.

## Suggested test scenarios

- **Happy path** -- Given a signed-in author with a DRAFT post, when they POST to the publish endpoint, then `status` is PUBLISHED, `published_at` is set, a success message is shown, and the response redirects to the post URL.
- **Already published** -- Given a PUBLISHED post, when the author POSTs to publish it again, then no data changes, an error message is shown, and the response redirects to the post URL.
- **Wrong author** -- Given user B's DRAFT post, when user A (signed in) POSTs to publish it, then the system returns 404 and the post remains DRAFT.
- **Unauthenticated** -- Given a signed-out user, when they POST to the publish endpoint, then the system redirects to the login page with `?next=` set to the original URL.
- **GET request** -- Given a signed-in author, when they send a GET to the publish URL, then the system returns HTTP 405 and the post is unchanged.
- **Non-existent post** -- Given a `pk` that does not exist in the database, when a signed-in user POSTs, then the system returns 404.
- **Partial save integrity** -- Given concurrent edits to `body` and a simultaneous publish, when the publish completes, then only `status` and `published_at` change; the `body` edit is not overwritten.

## Related use cases

- [Edit a Blog Post](edit-a-blog-post) -- update the content of a post before or after publishing
- [Delete a Blog Post](delete-a-blog-post) -- permanently remove a post the author owns
- [Create a Draft Post](create-a-draft-post) -- the upstream step that creates the post in DRAFT status

## Source links

<details>
<summary>Implementation files (for developers and auditors)</summary>

- [`views.py` lines 57-67](views.py) -- `publish_post` function-based view
- [`views.py` lines 1-9](views.py) -- decorator and import declarations
- `models.py` -- `Post` model with `Status` enum, `published_at` field, `get_absolute_url()`
- URL conf: `path("posts/<int:pk>/publish/", publish_post, name="post-publish")`

</details>

---

<!-- code2wiki:managed:start id=python-django-blog-post-publish-v1 -->
*Generated by [code2wiki](https://github.com/craftandship/code2wiki) from commit `0000000` on 2026-05-28.*
*Confidence: **high** -- function-based view with explicit decorator guards and a clear status-transition guard.*
<!-- code2wiki:managed:end -->
