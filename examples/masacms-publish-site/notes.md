# Notes: MasaCMS site publish to production

## Why this is a good first CFML example

- **Tag-based CFML** — uses `<cffunction>`, `<cfargument>`, `<cfquery>`, `<cfloop>`, `<cfif>`. This is the variant of CFML that AI tools fail on most consistently because they treat it as HTML.
- **Multi-step workflow with side effects** — DB writes, file copies, plugin events. A use-case page is genuinely useful here in a way that a function summary is not.
- **Real legacy** — Mura/Masa lineage goes back to 2003. This is the kind of code our buyer actually has.
- **Implicit business rules** — the difference between "Full" and "Changes Only" is encoded in a `<cfif arguments.pushMode neq "changesOnly">` check that has non-obvious consequences (a typo in the argument silently does a Full deploy). The gold standard surfaces this as a business rule.
- **Hidden global side effect** — `update tglobals set appreload` reloads ALL sites on production, not just the one being deployed. A non-developer reader will not get this from reading the code; the gold standard names it explicitly.

## Edge cases the gold standard exercises

- **Tag syntax extraction** — the extractor must understand `<cffunction>` blocks, `<cfargument>` declarations, `<cfif>` conditions, and `<cfloop>` iteration. Pattern-match-heavy.
- **Cross-file business rules** — references to `application.configBean.getProductionDatasource()` etc. require the extractor to chase configuration sources. The gold standard cites these without unrolling them.
- **Implicit fallthrough behavior** — "any non-matching pushMode does a Full deploy" is inferred from the negation, not stated. The gold standard surfaces the inference.
- **Plugin event hooks** — three plugin events are fired (`onSiteDeploy`, `onBeforeSiteDeploy`, `onAfterSiteDeploy`). The gold standard explains what plugins can do at each point.
- **Multiple production datasources via `<cfloop list=...>`** — comma-separated lists are a CFML idiom; the gold standard names this rule explicitly.

## What a wrong/bad output would look like (anti-patterns to avoid)

- ❌ "The publish function takes a siteid and pushMode..." — that's a function-signature paraphrase, not a use case.
- ❌ Listing each `<cfloop>` as a separate step ("the system loops over the production datasource list") — collapse them to business meaning ("for each configured production database").
- ❌ Treating `<cfquery>` updates as data details — they're business postconditions ("the deployment timestamp is recorded").
- ❌ Missing the `appreload` global side effect — it's the most surprising rule in the function and the most important for an admin to know.
- ❌ Suggested test scenarios that just mirror the happy path. Half the test scenarios should hit the alternate flows and business rules.

## Confidence rating: high

Despite being tag-based legacy CFML, this function has clear argument names, a single entry point, and well-named helper calls (`getSitePlugins`, `getLastDeployment`, `announceEvent`). The structural hooks are obvious enough that an LLM with good context can extract the use case faithfully. Smaller, less-named CFML functions will rate medium or low.

## Open questions for the prompt template

- Should the gold standard include the `<cfquery>` SQL inline? Decision: no — collapse to business intent. The SQL goes in the Source links section if anywhere.
- Should plugin event hooks be a separate section? Decision: keep them inline in the main flow with the names called out, but put detailed listener semantics in business rules + footnotes.
- How to handle the deprecated commented-out block (lines 3475–3479)? Decision: ignore — commented-out code is not behavior. The extractor should strip CFML comments before LLM input.
