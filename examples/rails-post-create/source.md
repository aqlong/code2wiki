# Source pointer: Rails blog -- Create a New Post

**Upstream pattern:** Rails RESTful controller with Devise authentication (standard MVC)
**License:** synthetic fixture, no upstream license required
**File:** `app/controllers/posts_controller.rb`
**Use case region:** `create` action (lines 7-16 in the listing below)
**Reference codebase:** No public upstream; this fixture is intentionally synthetic to stand alone without a `references/` clone.

## Why this use case

The canonical Rails CRUD creation pattern: form POST, validate, save, redirect -- with Devise authentication and an ActionMailer side-effect. This combination appears in virtually every Rails app that has user-owned content.

The `deliver_later` call exercises the parser's ActionMailer detection path, and `current_user.posts.build` tests the scoped-ownership pattern that is the Rails idiom for "the authenticated user can only create records attributed to themselves."

## Specific code under analysis

```ruby
class PostsController < ApplicationController
  before_action :authenticate_user!
  before_action :set_post, only: [:show, :edit, :update, :destroy]

  def create
    @post = current_user.posts.build(post_params)
    if @post.save
      PostMailer.with(post: @post).creation_notice.deliver_later
      redirect_to @post, notice: "Post was successfully created."
    else
      render :new, status: :unprocessable_entity
    end
  end

  private

  def set_post
    @post = current_user.posts.find(params[:id])
  end

  def post_params
    params.require(:post).permit(:title, :body, :category_id, :published)
  end
end
```
