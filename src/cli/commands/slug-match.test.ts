import { describe, expect, it } from "vitest";
import { slugLooksLike } from "./slug-match.js";

describe("slugLooksLike, name normalization", () => {
  it("returns true on byte-equal candidate name and slug", () => {
    expect(slugLooksLike("foo", "foo")).toBe(true);
  });

  it("strips a leading qualified prefix up to and including the last dot", () => {
    // Java fully-qualified candidate.name like 'UserController.register'
    // must reduce to 'register' before the suffix check fires; a
    // regression dropping the `^.*\.` strip would fail to match
    // 'register' against a slug that contains only the unqualified name.
    expect(slugLooksLike("UserController.register", "registering-a-user")).toBe(
      true,
    );
  });

  it("strips back to the FINAL dot when multiple dots are present", () => {
    // Pin greediness: `^.*\.` is greedy so 'a.b.c.register' → 'register'.
    expect(slugLooksLike("a.b.c.register", "register")).toBe(true);
  });

  it("kebab-cases camelCase via the lower→Upper boundary regex", () => {
    // `registerNewPet` → `register-new-pet`. The slug 'register-new-pet'
    // contains the namePart verbatim.
    expect(slugLooksLike("registerNewPet", "register-new-pet")).toBe(true);
  });

  it("kebab-cases mixed digit→Upper boundaries (digit qualifies as [a-z0-9])", () => {
    // `register2Step` → `register2-step` per `[a-z0-9])([A-Z]`.
    expect(slugLooksLike("register2Step", "register2-step")).toBe(true);
  });

  it("does NOT kebab-case Upper→Upper transitions (acronym runs stay glued)", () => {
    // `XMLParser` lowercases to `xmlparser`; no boundary insertion happens
    // because both sides of every interior pair are uppercase. Slug
    // 'xmlparser' matches.
    expect(slugLooksLike("XMLParser", "xmlparser")).toBe(true);
  });

  it("replaces runs of non-[a-z0-9-] characters and collapses adjacent hyphens", () => {
    // `foo  bar__baz` → after toLowerCase → `foo  bar__baz` → the
    // non-alphanumeric run `  ` becomes `-`, the run `__` becomes `-`,
    // collapse leaves `foo-bar-baz`.
    expect(slugLooksLike("foo  bar__baz", "foo-bar-baz")).toBe(true);
  });

  it("trims leading and trailing hyphens before matching", () => {
    // `__foo__` → `-foo-` after non-alnum replace → `foo` after the
    // final ^-|-$ strip. A regression dropping the trim would leave
    // `-foo-` as namePart and break the contains check against `foo`.
    expect(slugLooksLike("__foo__", "foo")).toBe(true);
  });

  it("returns false when the normalized namePart is empty", () => {
    // All-symbol name like `___` reduces to '' after trim. The empty
    // namePart guard MUST fire, without it the function would fall
    // through to `slug.includes("")` which is always true and would
    // match every audit entry to a junk candidate.
    expect(slugLooksLike("___", "anything")).toBe(false);
  });

  it("returns false on completely empty candidate name", () => {
    expect(slugLooksLike("", "foo-bar")).toBe(false);
  });
});

describe("slugLooksLike, match semantics", () => {
  it("matches when slug CONTAINS the kebabed namePart anywhere", () => {
    // The renderer typically prepends a verb / object derived from
    // the LLM title, `publish` → `publishing-a-site`, so a
    // mid-string contains match is the production-canonical hit.
    expect(slugLooksLike("publish", "publishing-a-site")).toBe(true);
  });

  it("matches when the namePart contains the slug's first hyphen segment", () => {
    // Mirror branch: when the LLM omits a title, the renderer's fallback
    // produces a slug whose first segment IS the candidate name. The
    // function's namePart and the slug's first segment can be unequal
    // length (e.g. namePart='registerNewPet' vs slug.split('-')[0]='register'),
    // so the `namePart.includes(slug.split('-')[0])` half catches the
    // case where the slug got truncated by the renderer.
    expect(slugLooksLike("registerNewPet", "register")).toBe(true);
  });

  it("matches an empty slug because split('-')[0] is the empty string", () => {
    // `''.includes('')` is true. Edge case worth pinning so a future
    // refactor adding a `slug.length > 0` guard surfaces as deliberate.
    expect(slugLooksLike("foo", "")).toBe(true);
  });

  it("returns false when neither containment direction holds", () => {
    // namePart='foo', slug='bar-baz' → slug.includes('foo')=false,
    // 'foo'.includes('bar')=false → false.
    expect(slugLooksLike("foo", "bar-baz")).toBe(false);
  });

  it("matches when slug contains namePart even though the slug's first segment is unrelated", () => {
    // namePart='abc', slug='xyz-abc' → slug.includes('abc')=true,
    // 'abc'.includes('xyz')=false. The forward branch (slug.includes
    // namePart) carries the match; a regression flipping the `||` to
    // `&&` would break this because the reverse branch fails alone.
    expect(slugLooksLike("abc", "xyz-abc")).toBe(true);
  });

  it("matches case-insensitively in practice because namePart is lower-cased before compare", () => {
    // `REGISTER` → lowercased namePart = 'register', slug already lower
    // → contains match. Pins the `.toLowerCase()` step; a regression
    // dropping it would fail to match any all-caps Java constant-style
    // method names (rare but real) against the slugged form.
    expect(slugLooksLike("REGISTER", "register-a-user")).toBe(true);
  });

  it("matches when the slug.split('-')[0] is contained within a multi-word namePart", () => {
    // namePart='register-new-pet-owner' (from registerNewPetOwner),
    // slug='register-something-else' → split('-')[0]='register',
    // namePart.includes('register')=true → match. Pins the reverse-
    // containment branch with a realistic camelCase candidate.
    expect(slugLooksLike("registerNewPetOwner", "register-something-else")).toBe(
      true,
    );
  });
});
