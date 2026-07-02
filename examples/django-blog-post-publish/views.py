from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import HttpResponseRedirect
from django.shortcuts import get_object_or_404
from django.urls import reverse_lazy
from django.utils import timezone
from django.views.decorators.http import require_POST
from django.views.generic import CreateView, DeleteView, UpdateView

from .models import Post


class PostCreateView(CreateView):
    """Create a new blog post as a draft."""

    model = Post
    fields = ["title", "body", "category"]
    template_name = "blog/post_form.html"
    success_url = reverse_lazy("blog:post-list")

    def form_valid(self, form):
        form.instance.author = self.request.user
        form.instance.status = Post.Status.DRAFT
        return super().form_valid(form)


class PostUpdateView(UpdateView):
    """Edit an existing post. Only the author can edit their own posts."""

    model = Post
    fields = ["title", "body", "category"]
    template_name = "blog/post_form.html"

    def get_queryset(self):
        return Post.objects.filter(author=self.request.user)

    def form_valid(self, form):
        messages.success(self.request, "Post updated.")
        return super().form_valid(form)


class PostDeleteView(DeleteView):
    """Delete a post. Only the author can delete their own posts."""

    model = Post
    template_name = "blog/post_confirm_delete.html"
    success_url = reverse_lazy("blog:post-list")

    def get_queryset(self):
        return Post.objects.filter(author=self.request.user)

    def form_valid(self, form):
        messages.success(self.request, "Post deleted.")
        return super().form_valid(form)


@login_required
@require_POST
def publish_post(request, pk):
    """Transition a draft post to PUBLISHED and stamp published_at."""
    post = get_object_or_404(Post, pk=pk, author=request.user)
    if post.status != Post.Status.DRAFT:
        messages.error(request, "Only draft posts can be published.")
        return HttpResponseRedirect(post.get_absolute_url())
    post.status = Post.Status.PUBLISHED
    post.published_at = timezone.now()
    post.save(update_fields=["status", "published_at"])
    messages.success(request, f'"{post.title}" is now live.')
    return HttpResponseRedirect(post.get_absolute_url())
