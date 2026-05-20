import { describe, it, expect } from "vitest";
import { promptVersionLte } from "./prompt-version.js";

describe("promptVersionLte", () => {
  it("returns true when versions are equal", () => {
    expect(promptVersionLte("v1", "v1")).toBe(true);
    expect(promptVersionLte("v0", "v0")).toBe(true);
    expect(promptVersionLte("v42", "v42")).toBe(true);
  });

  it("returns true when a is strictly less than b", () => {
    expect(promptVersionLte("v0", "v1")).toBe(true);
    expect(promptVersionLte("v1", "v2")).toBe(true);
    expect(promptVersionLte("v2", "v100")).toBe(true);
  });

  it("returns false when a is strictly greater than b", () => {
    expect(promptVersionLte("v2", "v1")).toBe(false);
    expect(promptVersionLte("v1", "v0")).toBe(false);
    expect(promptVersionLte("v100", "v2")).toBe(false);
  });

  it("compares numerically, NOT lexicographically (v10 > v9)", () => {
    // The whole reason this helper exists: lex order would say "v10" <= "v9"
    // because "1" < "9" character-wise.
    expect(promptVersionLte("v9", "v10")).toBe(true);
    expect(promptVersionLte("v10", "v9")).toBe(false);
    expect(promptVersionLte("v99", "v100")).toBe(true);
    expect(promptVersionLte("v100", "v99")).toBe(false);
    expect(promptVersionLte("v2", "v10")).toBe(true);
    expect(promptVersionLte("v10", "v2")).toBe(false);
  });

  it("handles large monotonic gaps without overflow", () => {
    expect(promptVersionLte("v1", "v999999")).toBe(true);
    expect(promptVersionLte("v999999", "v1")).toBe(false);
  });

  it("falls back to lex compare when one side is malformed", () => {
    // If a side doesn't match /^v\d+$/, we lex-compare both raw strings.
    // The behavior is "best-effort, don't throw", sane monotonic inputs
    // never hit this branch, so we just pin that the call doesn't throw
    // and returns a deterministic boolean.
    expect(promptVersionLte("v1", "vbeta")).toBe(true); // "v1" <= "vbeta" lex
    expect(promptVersionLte("vbeta", "v1")).toBe(false); // "vbeta" > "v1" lex
  });

  it("falls back to lex compare when both sides are malformed", () => {
    expect(promptVersionLte("alpha", "beta")).toBe(true);
    expect(promptVersionLte("beta", "alpha")).toBe(false);
    expect(promptVersionLte("v1.0", "v1.0")).toBe(true);
    // "v1.0" vs "v2.0", both malformed (have a dot), so lex-compared.
    // "v1.0" <= "v2.0" is true under lex too.
    expect(promptVersionLte("v1.0", "v2.0")).toBe(true);
  });

  it("falls back to lex compare on empty strings", () => {
    expect(promptVersionLte("", "")).toBe(true);
    expect(promptVersionLte("", "v1")).toBe(true);
    expect(promptVersionLte("v1", "")).toBe(false);
  });

  it("does not throw on whitespace or unusual inputs", () => {
    // The helper guarantees a boolean back, never an exception.
    expect(typeof promptVersionLte(" v1", "v1")).toBe("boolean");
    expect(typeof promptVersionLte("v1 ", "v1")).toBe("boolean");
    expect(typeof promptVersionLte("V1", "v1")).toBe("boolean"); // case-sensitive: "V" < "v" lex
  });

  it("treats v0 as the strictly-oldest version", () => {
    // The replay command's `--since-version v0` semantic relies on v0
    // being treated as older than every produced version (which currently
    // start at v1). Pin that explicitly.
    expect(promptVersionLte("v0", "v1")).toBe(true);
    expect(promptVersionLte("v1", "v0")).toBe(false);
    expect(promptVersionLte("v0", "v100")).toBe(true);
  });
});
