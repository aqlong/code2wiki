# Source pointer: Spring PetClinic — Find Pet Owners by Last Name

**Upstream repository:** [spring-projects/spring-petclinic](https://github.com/spring-projects/spring-petclinic)
**License:** Apache 2.0
**File:** `src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java`
**Use case region:** Lines 94–119 (`processFindForm`) and 121–134 (helpers)
**Local clone path:** `references/spring-petclinic/src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java`

## Why this use case

Tests the extractor on **rich branching logic** with three distinct end states:
- 0 matches → re-show search form with error
- exactly 1 match → silent redirect to that owner's profile
- many matches → paginate and show a list

This is the most common shape of "search and act" in a CRUD app and is harder to document than a linear flow because:
- The redirect-on-1-match behavior is non-obvious to a non-developer reader
- Empty `lastName` is silently treated as "match all"
- Pagination size (5) is hard-coded and worth surfacing

## Specific code under analysis

```java
@GetMapping("/owners")
public String processFindForm(@RequestParam(defaultValue = "1") int page, Owner owner, BindingResult result, Model model) {
    String lastName = owner.getLastName();
    if (lastName == null) {
        lastName = "";
    }
    Page<Owner> ownersResults = findPaginatedForOwnersLastName(page, lastName);
    if (ownersResults.isEmpty()) {
        result.rejectValue("lastName", "notFound", "not found");
        return "owners/findOwners";
    }
    if (ownersResults.getTotalElements() == 1) {
        owner = ownersResults.iterator().next();
        return "redirect:/owners/" + owner.getId();
    }
    return addPaginationModel(page, model, ownersResults);
}

private Page<Owner> findPaginatedForOwnersLastName(int page, String lastname) {
    int pageSize = 5;
    Pageable pageable = PageRequest.of(page - 1, pageSize);
    return owners.findByLastNameStartingWith(lastname, pageable);
}
```
