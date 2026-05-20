# Source pointer: Spring PetClinic — Register a New Pet Owner

**Upstream repository:** [spring-projects/spring-petclinic](https://github.com/spring-projects/spring-petclinic)
**License:** Apache 2.0
**File:** `src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java`
**Use case region:** Lines 64–87 (`findOwner`, `initCreationForm`, `processCreationForm`)
**Local clone path:** `references/spring-petclinic/src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java`

## Why this use case

A textbook Spring MVC controller pair: GET to render a form, POST to validate and persist. Every Spring app has dozens of these. If code2wiki produces good output for this, it produces good output for the most common Java pattern in production today.

## Specific code under analysis

```java
@ModelAttribute("owner")
public Owner findOwner(@PathVariable(name = "ownerId", required = false) Integer ownerId) {
    return ownerId == null ? new Owner()
            : this.owners.findById(ownerId)
                .orElseThrow(() -> new IllegalArgumentException("Owner not found with id: " + ownerId
                        + ". Please ensure the ID is correct " + "and the owner exists in the database."));
}

@GetMapping("/owners/new")
public String initCreationForm() {
    return VIEWS_OWNER_CREATE_OR_UPDATE_FORM;
}

@PostMapping("/owners/new")
public String processCreationForm(@Valid Owner owner, BindingResult result, RedirectAttributes redirectAttributes) {
    if (result.hasErrors()) {
        redirectAttributes.addFlashAttribute("error", "There was an error in creating the owner.");
        return VIEWS_OWNER_CREATE_OR_UPDATE_FORM;
    }

    this.owners.save(owner);
    redirectAttributes.addFlashAttribute("message", "New Owner Created");
    return "redirect:/owners/" + owner.getId();
}
```
