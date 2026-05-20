# Notes: Spring PetClinic owner registration

## Why this is a good first Java example

- **Pattern coverage:** GET-form / POST-handler is the most common Spring MVC pattern. Get this right and you cover 80% of Spring controllers in the wild.
- **Validation surface:** Demonstrates `@Valid`, `BindingResult`, `@InitBinder` field disallowing — three Spring patterns that combine to define non-obvious business rules ("ID can't be set by user").
- **Compact:** ~24 lines of Java to document, but the result is a full use case page that a BA could act on.
- **Real, not synthetic:** Apache 2.0 licensed, maintained by the Spring team, used as the canonical Spring reference app since 2013.

## Edge cases the gold standard exercises

- **Hidden business rule from `@InitBinder`** — the disallowed-fields configuration prevents tampering. A naïve doc generator would miss this entirely. Our gold standard surfaces it as an explicit business rule with citation.
- **Validation rules live on the domain class, not the controller** — the gold standard correctly cites `Owner.java` for "telephone must be numeric" rather than the controller. This is the kind of cross-file reasoning the LLM needs to do.
- **Flash attributes are one-shot** — the gold standard mentions "shown once and not repeated on refresh" because that's a real UX behavior the test scenarios should cover.

## What a wrong/bad output would look like (anti-patterns to avoid)

- ❌ Listing the method signatures verbatim ("Controller has `processCreationForm(Owner, BindingResult, RedirectAttributes)`")
- ❌ Architecture-speak ("MVC pattern with @PostMapping annotation")
- ❌ Code blocks in the body of the use case (we collapse these in the Source links section)
- ❌ Missing the `@InitBinder` rule (it's a hidden invariant; missing it is the most common LLM failure mode)
- ❌ Suggested test scenarios that just restate the happy path

## Confidence rating: high

This is a well-documented reference app with explicit annotations. We can extract the rules with high confidence. Real-world legacy CFML or untyped Java will rate medium or low.
