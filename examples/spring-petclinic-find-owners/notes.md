# Notes: Spring PetClinic owner search

## Why this is a good third Java example

- **Three-branch conditional logic** — empty / single / many results — tests whether the extractor can articulate alternate flows beyond a binary happy/sad case.
- **Hidden redirect-on-1** — the most surprising business behavior; a documentation tool that misses this is producing dev docs, not user-facing docs.
- **Hard-coded page size** — exposes a limit (5 per page) that is not visible from the form. Ops and QA need to know it.
- **Empty-string-as-match-all** — silent fallback that changes user expectations; the gold standard surfaces it.
- **No `@PreAuthorize` or filter** — this is the third example confirming the actor framing rule (broadest possible caller, default to visitor).

## Edge cases the gold standard exercises

- Three distinct alternate flows from the same trigger
- Page-parameter default behavior
- Out-of-range page handling (degrades to "no results" branch)
- Distinction between prefix match and contains match (subtle but real)

## What a wrong/bad output would look like (anti-patterns to avoid)

- ❌ Treating "exactly one match → redirect" as merely an implementation detail. It is THE most user-visible behavior in this flow.
- ❌ Listing the helper method `findPaginatedForOwnersLastName` as a separate "step" — it's an implementation detail, not a business action.
- ❌ Saying "the system queries the database" — collapse to "the system retrieves matching owners".
- ❌ Missing the "5 per page" rule. It will absolutely come up in a "why am I only seeing 5?" support ticket.
- ❌ Suggested test scenarios that only cover the happy path. We need at least 5 — one per branch + the prefix-match clarification.

## Confidence rating: high

Linear, explicit branching with no hidden state. The extractor has access to the full file (so it can see the parent class's `@InitBinder`, even though that doesn't apply here), and the helper method is in the same file. No cross-file reasoning required.
