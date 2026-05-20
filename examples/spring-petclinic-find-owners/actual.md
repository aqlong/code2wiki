---
code2wiki_id: java-src-main-java-org-springframework-samples-petclinic-owner-ownercontroller-ownercontroller-processfindform-v1
title: Search for Owners by Last Name
slug: search-for-owners-by-last-name
actor: Any visitor or unauthenticated user (no access restrictions are applied to this endpoint)
status: active
last_generated: '2026-05-07T18:21:12.508Z'
last_commit: c7ee170
confidence: high
source_files:
  - path: src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java
    lines: 94-119
tags:
  - owner
  - search
  - pagination
  - last-name
  - read-only
  - unauthenticated
---

## Summary

A user searches for pet owners by entering a last name (or nothing at all). The system returns all matching owners, paged in groups of five. If exactly one owner is found, the user is taken directly to that owner's detail page.

## Actor and triggers

- **Actor:** Any visitor or unauthenticated user (no access restrictions are applied to this endpoint)

- **Trigger:** A user navigates to the owner search results page, either by submitting the search form or by visiting the owners list URL directly (with or without a last name filter).

## Preconditions

- The owner records are available in the database.
- The user may optionally provide a last name to narrow results; if none is provided, all owners are returned.
- The requested page number defaults to 1 if not specified.

## Main flow

1. The user visits the owner search results page, optionally supplying a last name and/or a page number. [^step1]
2. If no last name is provided, the system treats the search as a request to see all owners. [^step2]
3. The system searches for all owners whose last name begins with the supplied text. Results are returned in pages of five owners at a time. [^step3]
4. If more than one owner matches, the system displays the paginated list of matching owners along with pagination controls (current page, total pages, total count). [^step4]

[^step1]: Line 94: GET /owners; page defaults to 1
[^step2]: Lines 97-100: null last name converted to empty string
[^step3]: Lines 102, 127-130: findPaginatedForOwnersLastName; page size hardcoded to 5
[^step4]: Lines 116-118, 121-127: addPaginationModel

## Alternate and exception flows

- **No owners found:** If the search returns no results, the system marks the last name field as invalid with the message 'not found' and redisplays the search form so the user can try a different name.
- **Exactly one owner found:** If the search returns exactly one owner, the system skips the list view entirely and redirects the user directly to that owner's detail page.

## Postconditions

- If multiple owners match: a paginated list of matching owners is shown.
- If exactly one owner matches: the user is redirected to that owner's detail page.
- If no owners match: the search form is redisplayed with a validation error on the last name field.

## Business rules

- Search matches owners whose last name STARTS WITH the supplied text — it is a prefix search, not an exact or full-text match. [^rule1]
- If no last name is supplied, the search returns all owners in the system (broadest possible search). [^rule2]
- Results are always paginated in fixed groups of five owners per page. [^rule3]
- The 'id' field and any nested 'id' fields on the owner form are always ignored — users cannot submit or manipulate owner IDs through this or any other owner form. [^rule4]
- When exactly one result is found, the system skips the list entirely and sends the user straight to the owner detail view — the list page is never shown for a single match. [^rule5]

[^rule1]: Line 130: findByLastNameStartingWith
[^rule2]: Lines 97-100
[^rule3]: Line 128: pageSize = 5 (hardcoded)
[^rule4]: Lines 58-60: @InitBinder disallows 'id' and '*.id'
[^rule5]: Lines 110-113

## Suggested test scenarios

- **Happy path — multiple owners found** — Given at least two owners with last names starting with 'Smith' exist in the system, when a user searches for 'Smith', then a paginated list of all matching owners is displayed.
- **Happy path — single owner found** — Given exactly one owner with the last name 'Johnson' exists, when a user searches for 'Johnson', then the user is redirected directly to that owner's detail page.
- **No results found** — Given no owners with a last name starting with 'Xyz' exist, when a user searches for 'Xyz', then the search form is redisplayed with an error indicating no owners were found.
- **Empty search returns all owners** — Given multiple owners exist in the system, when a user visits the owners list page without entering a last name, then all owners are returned and displayed in a paginated list.
- **Pagination navigates to correct page** — Given more than five owners exist whose last names start with 'B', when a user requests page 2 of the search results for 'B', then the second page of five matching owners is displayed.
- **ID field cannot be submitted** — Given a user attempts to include an owner ID in the search form submission, when the request is processed, then the ID field is silently ignored and does not affect the search or any owner record.

## Related use cases

- [View Owner Details](view-owner-details)
- [Register a New Owner](register-new-owner)
- [Display Owner Search Form](find-owners-search-form)

## Source links

<details>

<summary>Implementation files (for developers and auditors)</summary>



- `src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java` lines 94-119



</details>

---

<!-- code2wiki:managed:start id=java-src-main-java-org-springframework-samples-petclinic-owner-ownercontroller-ownercontroller-processfindform-v1 -->
*Generated by [code2wiki](https://github.com/aqlong/code2wiki) from commit `c7ee170` on 2026-05-07T18:21:12.508Z.*
*Confidence: **high** — The focus region is short, self-contained, and its branching logic is explicit. The page size, prefix-search behaviour, and InitBinder disallow rules are all directly visible in the same file.*
<!-- code2wiki:managed:end -->
