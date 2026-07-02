# examples/django-blog-post-publish/

Regression fixture and gold-standard output for the Django parser (ADR-037).

## What this tests

A synthetic Django view module (`views.py`) covering the two dominant Django view styles:

- **Class-based views:** `PostCreateView`, `PostUpdateView`, `PostDeleteView` (Django generic CBVs with `get_queryset()` author-scoping)
- **Function-based view:** `publish_post` (state-transition endpoint with `@login_required`, `@require_POST`, `get_object_or_404`, `messages`, `HttpResponseRedirect`, and a status-guard business rule)

## Files

| File | Purpose |
|---|---|
| `views.py` | The source the parser runs against (~67 lines) |
| `source.md` | Source pointer and annotated code excerpts |
| `expected.md` | Gold-standard output: **Publish a Blog Post** (primary, picked up by snapshot test) |
| `expected-edit-post.md` | Gold-standard output: **Edit a Blog Post** |
| `expected-delete-post.md` | Gold-standard output: **Delete a Blog Post** |
| `notes.md` | Edge cases, anti-patterns, and confidence rating |
| `baseline.snapshot.json` | Structural fingerprint of `expected.md` (generated, do not edit) |

## Running the snapshot test

The regression test in `src/core/feedback/examples.test.ts` picks up `expected.md` automatically. After any intentional edit to `expected.md`, regenerate the baseline:

```sh
npx tsx scripts/gen-baseline-snapshots.mjs
```

Commit both `expected.md` and `baseline.snapshot.json` together.

## Key business rules exercised

1. Only the post's author can publish, edit, or delete (queryset-scoped ownership).
2. Only DRAFT posts can be published (status-transition guard in view body -- not a decorator or model constraint).
3. Publish stamps `published_at` via `save(update_fields=[...])` -- partial write, not a full-row overwrite.
4. 404 is returned for both "not found" and "wrong owner" -- intentional information-disclosure prevention.
