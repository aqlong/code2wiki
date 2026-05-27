---
code2wiki_id: java-spring-petclinic-owner-create-v1
title: Register a New Pet Owner
slug: register-a-new-pet-owner
actor: Visitor or staff member who is not yet recorded as a pet owner in the clinic system
status: active
last_generated: 2026-05-07T00:00:00Z
last_commit: 0000000
confidence: high
source_files:
  - path: src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java
    lines: 64-87
tags:
  - owner
  - registration
  - public-form
---

## Summary

A new pet owner fills out a sign-up form (name, address, phone) and is added to the clinic's records. Once accepted, they are taken to their own profile page where they can register their pets.

## Actor and triggers

- **Actor:** Visitor or staff member who is not yet recorded as a pet owner.
- **Trigger:** Visitor opens the page at `/owners/new` and submits the registration form.

## Preconditions

- The visitor has navigated to the registration page (`GET /owners/new`).
- The clinic system is online and the owner database is reachable.

## Main flow

1. The visitor opens the registration form. The system shows an empty form with fields for first name, last name, address, city, and telephone.[^form]
2. The visitor fills the form in and submits it.
3. The system checks that every required field is present and valid (e.g., telephone is a number, all name fields are filled in).
4. If validation passes, the system saves the new owner record and assigns a new owner ID.
5. The system shows the visitor a success message ("New Owner Created") and redirects them to their newly created profile page at `/owners/{their new ID}`.

[^form]: The form view is rendered from the template at `owners/createOrUpdateOwnerForm`.

## Alternate and exception flows

- **Validation failure:** If any required field is missing or malformed, the system re-displays the form, keeps the visitor's entered values, and shows the error message "There was an error in creating the owner." No record is saved.
- **Database unavailable:** If the owner record cannot be saved (database down or constraint violation), the standard application error page is shown. The visitor is not given a partial record.

## Postconditions

- A new row exists in the owners table with a unique ID and the values the visitor entered.
- The visitor is on their new owner profile page, where they can register pets.
- A flash message ("New Owner Created") is shown once and not repeated on refresh.

## Business rules

- **Visitors cannot supply their own owner ID.** The system ignores any `id` field submitted by the visitor; the database assigns the ID. This prevents tampering with another owner's record.[^binder]
- **All standard owner fields are required.** First name, last name, address, city, and telephone must all be present.[^valid]
- **Telephone must be numeric.** Non-numeric telephone values are rejected at validation.[^valid]

[^binder]: Enforced by the `@InitBinder` configuration on `OwnerController`, which disallows binding of `id` and `*.id` fields from the request.
[^valid]: Enforced by Bean Validation annotations on the `Owner` domain class.

## Suggested test scenarios

- **Happy path** — Given a complete and valid form, when the visitor submits it, then a new owner record is created and the visitor is redirected to `/owners/{newId}` with the success message visible.
- **Missing required field** — Given a form with the last-name field empty, when the visitor submits it, then no record is saved and the form is re-shown with an error message and the other entered values preserved.
- **Non-numeric telephone** — Given a form with telephone `"call me"`, when the visitor submits it, then no record is saved and the form is re-shown with a validation error on the telephone field.
- **Tampered ID submission** — Given a form that includes a hidden `id=999` field, when the visitor submits it, then the submitted ID is ignored, a fresh ID is assigned by the database, and the new record does not overwrite owner 999.
- **Duplicate-allowed registration** — Given a registration with first/last name identical to an existing owner, when the visitor submits it, then a separate new owner record is created (the system does not deduplicate by name).
- **Empty form submission** — Given a form with all fields blank, when the visitor submits it, then no record is saved and the form re-displays with error messaging on every required field.
- **Database write failure** — Given the owner database is offline, when the visitor submits a valid form, then the request fails with the standard application error page and no record is created.

## Related use cases

- [Update an Existing Pet Owner](update-an-existing-pet-owner) — same form, same controller, but for editing an already-registered owner
- [Find Pet Owners by Last Name](find-pet-owners-by-last-name) — the search flow that surfaces the new record after registration
- [View an Owner Profile](view-an-owner-profile) — the page the visitor lands on immediately after registering

## Source links

<details>
<summary>Implementation files (for developers and auditors)</summary>

- [`OwnerController.java` lines 64–87](../../references/spring-petclinic/src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java) — controller methods `findOwner`, `initCreationForm`, `processCreationForm`
- [`OwnerController.java` line 60](../../references/spring-petclinic/src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java) — `@InitBinder` that disallows `id` field binding
- `Owner.java` — domain class with Bean Validation annotations
- `OwnerRepository.java` — Spring Data repository (`save`, `findById`)
- View template: `owners/createOrUpdateOwnerForm`

</details>

---

<!-- code2wiki:managed:start id=java-spring-petclinic-owner-create-v1 -->
*Generated by [code2wiki](https://github.com/craftandship/code2wiki) from commit `0000000` on 2026-05-07.*
*Confidence: **high** — single-method controller with explicit validation annotations and binder configuration.*
<!-- code2wiki:managed:end -->
