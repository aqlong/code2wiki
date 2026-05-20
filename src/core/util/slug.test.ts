import { describe, it, expect } from "vitest";
import { slugify, stableId } from "./slug.js";

describe("slugify", () => {
  it("lowercases and replaces spaces with dashes", () => {
    expect(slugify("Register a New Pet Owner")).toBe(
      "register-a-new-pet-owner",
    );
  });

  it("strips quotes and punctuation", () => {
    expect(slugify("It's a 'test' (really)!")).toBe("its-a-test-really");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  it("caps length at 80 characters", () => {
    const long = "x".repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });

  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });
});

describe("stableId", () => {
  it("is deterministic for the same inputs", () => {
    const a = stableId("java", "src/Foo.java", "Foo.bar");
    const b = stableId("java", "src/Foo.java", "Foo.bar");
    expect(a).toBe(b);
  });

  it("differs when language differs", () => {
    const java = stableId("java", "src/Foo", "bar");
    const cfml = stableId("cfml", "src/Foo", "bar");
    expect(java).not.toBe(cfml);
  });

  it("strips file extensions from the path component", () => {
    const id = stableId("java", "src/main/Foo.java", "doIt");
    expect(id).not.toMatch(/\.java/);
  });

  it("ends with -v1", () => {
    expect(stableId("cfml", "x.cfc", "y")).toMatch(/-v1$/);
  });

  // Pin the exact byte value for the canonical Java ClassName.method case.
  // stableId is the publisher upsert key: a silent format change rotates
  // every existing page's code2wiki_id, causing publishers to create
  // duplicates instead of updating the claimed page. The previous tests
  // only checked determinism / suffix / extension-strip -- none pinned
  // the full output string, so a slugify refactor that changed how dots
  // inside the name are handled would compile clean and pass them all.
  it("produces the exact canonical id for a Java ClassName.method candidate", () => {
    // path:  "src/Foo.java" → strip ext → "src/Foo" → non-alnum→dash →
    //        "src-Foo" → lowercase → "src-foo"
    // name:  slugify("Foo.bar") → lowercase "foo.bar" → non-alnum→dash
    //        "foo-bar" (the dot collapses into the surrounding dashes,
    //        then the leading/trailing dash trim fires on any run)
    // full:  "java-src-foo-foo-bar-v1"
    expect(stableId("java", "src/Foo.java", "Foo.bar")).toBe(
      "java-src-foo-foo-bar-v1",
    );
  });

  it("produces the exact canonical id for a CFML .cfc candidate", () => {
    // Exercises the CFML extension (.cfc) and an underscore_case name,
    // confirming the path sanitizer and the slug for underscored names
    // produce the expected form. slugify does NOT split camelCase --
    // it only lowercases and replaces non-alnum runs (incl. underscores)
    // with dashes. Using register_pet here exercises that underscore→dash
    // path, which is the meaningful invariant for CFML snake_case names.
    expect(stableId("cfml", "app/controllers/Pet.cfc", "register_pet")).toBe(
      "cfml-app-controllers-pet-register-pet-v1",
    );
  });
});
