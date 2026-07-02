# Source: Django blog views -- publish, edit, delete

**Fixture type:** Synthetic (hand-written representative fixture, not an upstream open-source repo)
**File:** `examples/django-blog-post-publish/views.py`
**Lines analysed:** 1-67 (full file; three class-based views + one function-based view)

## Why this fixture

A minimal Django blog module covering the most common class-based-view patterns (Create / Update / Delete) plus the function-based pattern used for state-transition endpoints. Together they exercise every feature the Django parser (ADR-037) is designed to detect:

- `@login_required` and `@require_POST` decorators (auth + HTTP-method enforcement)
- `get_queryset()` override scoping results to the signed-in user (implicit access control)
- `messages.success` / `messages.error` (user-facing feedback side-effects)
- `get_object_or_404` (not-found handling)
- `HttpResponseRedirect` (explicit redirect)
- `update_fields` partial save (targeted write -- important for audit-aware docs)
- Status-transition guard (`post.status != Post.Status.DRAFT`) -- a non-obvious business rule

## Specific code under analysis

### publish_post (function-based view, lines 57-67)

```python
@login_required
@require_POST
def publish_post(request, pk):
    post = get_object_or_404(Post, pk=pk, author=request.user)
    if post.status != Post.Status.DRAFT:
        messages.error(request, "Only draft posts can be published.")
        return HttpResponseRedirect(post.get_absolute_url())
    post.status = Post.Status.PUBLISHED
    post.published_at = timezone.now()
    post.save(update_fields=["status", "published_at"])
    messages.success(request, f'"{post.title}" is now live.')
    return HttpResponseRedirect(post.get_absolute_url())
```

### PostUpdateView (class-based, lines 29-38)

```python
class PostUpdateView(UpdateView):
    model = Post
    fields = ["title", "body", "category"]
    template_name = "blog/post_form.html"

    def get_queryset(self):
        return Post.objects.filter(author=self.request.user)

    def form_valid(self, form):
        messages.success(self.request, "Post updated.")
        return super().form_valid(form)
```

### PostDeleteView (class-based, lines 41-53)

```python
class PostDeleteView(DeleteView):
    model = Post
    template_name = "blog/post_confirm_delete.html"
    success_url = reverse_lazy("blog:post-list")

    def get_queryset(self):
        return Post.objects.filter(author=self.request.user)

    def form_valid(self, form):
        messages.success(self.request, "Post deleted.")
        return super().form_valid(form)
```
