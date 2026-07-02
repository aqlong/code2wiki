# Notes: Django blog post views

## Why this is a good first Django example

- **Pattern coverage:** Django's class-based views (CreateView / UpdateView / DeleteView) plus a function-based state-transition view cover the two dominant Django view styles in production. Most Django apps have dozens of each.
- **Auth surface:** `@login_required`, `@require_POST`, and queryset scoping via `get_queryset()` each enforce access control in different ways. A good doc generator must surface all three, not just the decorator the reader can see at the top of the function.
- **State-transition guard:** The `publish_post` view's `if post.status != Post.Status.DRAFT` check is a non-obvious business rule. It is not captured in any decorator or model constraint -- it lives only in the view body. This is the class of hidden rule the Django parser is specifically designed to detect (ADR-037).
- **Partial save:** `save(update_fields=["status", "published_at"])` is easy to miss and important for auditors: it means a concurrent edit to `body` is not overwritten. A naive doc generator omits this invariant.
- **Compact:** 67 lines of Python, three use-case pages.

## Edge cases the gold standards exercise

- **Implicit 404 as access control:** `get_object_or_404(Post, pk=pk, author=request.user)` conflates "not found" and "wrong owner" into a single 404 response. The gold standard documents this explicitly as a deliberate design choice (no information disclosure).
- **`get_queryset()` as the sole ownership gate on CBVs:** The class-based views have no `@login_required` decorator (Django's `LoginRequiredMixin` would be added in a real app, but is omitted here to test whether the parser catches the queryset-scoping pattern without the obvious decorator signal).
- **`update_fields` partial save:** The gold standard notes that the publish operation modifies only two columns, not the full row. Auditors care about the scope of each write.
- **messages side-effect on failure:** The error-path in `publish_post` calls `messages.error()` and then redirects. A doc generator that only reads the happy path would miss this user-facing feedback on the failure branch.

## What a wrong/bad output would look like (anti-patterns to avoid)

- Describing `get_queryset()` as "a database query" rather than an access-control rule.
- Omitting the "only DRAFT posts can be published" rule (it requires reading the conditional, not just the decorators).
- Treating `update_fields` as an implementation detail rather than a documented postcondition.
- Merging the 404-for-wrong-owner and 404-for-not-found into a single "Post not found" alternate flow without noting the intentional conflation.
- Writing test scenarios that only cover the happy path of `publish_post` and ignore the already-published and wrong-author branches.

## Confidence rating: high

All business rules are explicit in the view code; none require cross-file inference (the `Post.Status` enum and `get_absolute_url()` are standard Django patterns). The parser should produce high-confidence output without needing to inspect `models.py`.
