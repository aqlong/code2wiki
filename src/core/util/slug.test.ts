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

  it("does not leave a trailing dash when the 80-char cap lands on a dash boundary", () => {
    // Regression guard: if the trim-dashes step ran BEFORE the slice (the
    // original order), an input that slugifies to "a-a-a-...-a-a" of 81+
    // chars would cap at 80 and leave the boundary char as a dash. That
    // trailing dash bleeds into stableId's
    // `${language}-${path}-${fn}-v1` template, producing a visible
    // "...-a--v1" double dash on the upsert key, which means a publisher
    // either fails the upsert or creates a duplicate page.
    //
    // 41 single-letter words separated by spaces -> 81-char slug
    // ("a-a-..-a", 41 a's + 40 dashes) -> slice(0,80) ends at index 79,
    // which is a dash. The post-slice trim MUST remove it.
    const input = "a ".repeat(41).trim();
    const slug = slugify(input);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).not.toMatch(/-$/);
    // Sanity: the bug-fix preserves the slug content (just drops the
    // dangling boundary dash). A 79-char "a-a-..-a" with 40 a's and 39
    // dashes is the correct truncation.
    expect(slug).toBe("a-".repeat(40).replace(/-$/, ""));
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

  // Regression guards for the OTHER two paths to the "--v1"/"--" double
  // dash the slugify 80-char fix only half-closed. slugify trimmed the fn's
  // own trailing dash, but an empty fn (name with no ASCII-alphanumerics) or
  // an empty path (a file whose stem sanitizes away, e.g. ".cfc") still left
  // an empty component at a join boundary -> a double dash on the upsert key,
  // which a publisher either fails to upsert or duplicates a page on.
  it("collapses the double dash when the name slugifies to empty", () => {
    const id = stableId("cfml", "src/Foo.cfc", "!!!");
    expect(id).not.toMatch(/--/);
    expect(id).toBe("cfml-src-foo-v1");
  });

  it("collapses the double dash when the path stem sanitizes to empty", () => {
    const id = stableId("cfml", ".cfc", "doThing");
    expect(id).not.toMatch(/--/);
    expect(id).toBe("cfml-dothing-v1");
  });

  it("collapses triple dashes when both path stem and name slugify to empty", () => {
    const id = stableId("cfml", ".cfc", "!!!");
    expect(id).not.toMatch(/--/);
    expect(id).toBe("cfml-v1");
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
