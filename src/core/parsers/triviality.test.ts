import { describe, it, expect } from "vitest";
import { isConstantReturnOnly, filterConstantReturns } from "./triviality.js";
import type { Candidate } from "../types.js";

// The helper recognizes the framework-stub pattern (Application.cfc
// lifecycle hooks that just return true/false, JAX-RS resource methods
// that return a constant id, etc.) without an AST.

describe("isConstantReturnOnly, CFML script-style", () => {
  const cases: Array<{ name: string; src: string; expected: boolean }> = [
    // --- positives (should drop) ---
    {
      name: "return true;",
      src: `function onRequestStart(targetPage) { return true; }`,
      expected: true,
    },
    {
      name: "return false;",
      src: `function check() { return false; }`,
      expected: true,
    },
    {
      name: "return null;",
      src: `function getThing() { return null; }`,
      expected: true,
    },
    {
      name: "return 0;",
      src: `function zero() { return 0; }`,
      expected: true,
    },
    {
      name: "return -1;",
      src: `function notFound() { return -1; }`,
      expected: true,
    },
    {
      name: 'return "id";',
      src: `function name() { return "id"; }`,
      expected: true,
    },
    {
      name: "return '';",
      src: `function empty() { return ''; }`,
      expected: true,
    },
    {
      name: "return {};",
      src: `function emptyStruct() { return {}; }`,
      expected: true,
    },
    {
      name: "return [];",
      src: `function emptyArray() { return []; }`,
      expected: true,
    },
    {
      name: "void return",
      src: `function noop() { return; }`,
      expected: true,
    },
    {
      name: "with whitespace / newlines",
      src: `function onRequestStart() {\n    return true;\n  }`,
      expected: true,
    },
    {
      name: "with a leading JSDoc comment",
      src: `function check() {\n  /** legacy hook */\n  return true;\n}`,
      expected: true,
    },
    {
      name: "with a leading // line comment",
      src: `function check() {\n  // legacy hook\n  return true;\n}`,
      expected: true,
    },

    // --- negatives (should keep) ---
    {
      name: "computed return (arguments expression)",
      src: `function dbl(x) { return arguments.x * 2; }`,
      expected: false,
    },
    {
      name: "variable return",
      src: `function get() { return variables.cached; }`,
      expected: false,
    },
    {
      name: "method call return (delegation)",
      src: `function wrap() { return mockBox.create(arguments); }`,
      expected: false,
    },
    {
      name: "non-empty struct",
      src: `function defaults() { return { user: "anon" }; }`,
      expected: false,
    },
    {
      name: "two statements",
      src: `function log() {\n  writeLog("hit");\n  return true;\n}`,
      expected: false,
    },
    {
      name: "string with embedded quote (likely meaningful copy)",
      src: `function err() { return "he said \\"hi\\""; }`,
      expected: false,
    },
  ];
  for (const c of cases) {
    it(`${c.expected ? "drops" : "keeps"}: ${c.name}`, () => {
      expect(isConstantReturnOnly(c.src)).toBe(c.expected);
    });
  }
});

describe("isConstantReturnOnly, CFML tag-style", () => {
  it("drops <cfreturn true/>", () => {
    const src =
      `<cffunction name="onRequestStart" returntype="boolean">\n` +
      `  <cfargument name="targetPage" type="string">\n` +
      `  <cfreturn true>\n` +
      `</cffunction>`;
    expect(isConstantReturnOnly(src)).toBe(true);
  });
  it("drops <cfreturn> (void)", () => {
    const src =
      `<cffunction name="noop">\n` +
      `  <cfreturn>\n` +
      `</cffunction>`;
    expect(isConstantReturnOnly(src)).toBe(true);
  });
  it("keeps <cfreturn> with a method call", () => {
    const src =
      `<cffunction name="wrap">\n` +
      `  <cfreturn other.method(argumentCollection=arguments)>\n` +
      `</cffunction>`;
    expect(isConstantReturnOnly(src)).toBe(false);
  });
  it("keeps a tag-style function with real logic", () => {
    const src =
      `<cffunction name="check">\n` +
      `  <cfset var ok = something()>\n` +
      `  <cfreturn ok>\n` +
      `</cffunction>`;
    expect(isConstantReturnOnly(src)).toBe(false);
  });
});

describe("isConstantReturnOnly, Java", () => {
  it("drops a Java method returning true", () => {
    const src = `public boolean onRequest(String p) { return true; }`;
    expect(isConstantReturnOnly(src)).toBe(true);
  });
  it("drops a JMH stub returning a constant string id", () => {
    const src = `public String id() { return "asset_by_id"; }`;
    expect(isConstantReturnOnly(src)).toBe(true);
  });
  it("keeps a real Java method with a body", () => {
    const src =
      `public int compute(int x) {\n` +
      `  int y = x * 2;\n` +
      `  return y;\n` +
      `}`;
    expect(isConstantReturnOnly(src)).toBe(false);
  });
});

describe("isConstantReturnOnly, regex-flag + alias coverage", () => {
  // Pins three load-bearing branches that all other tests exercise only
  // incidentally: the case-insensitive `/i` flag on both return regexes,
  // the `yes`/`no` aliases in LITERAL_RE, and the CFML tag-comment
  // <!---...---> path in stripComments. A refactor dropping any of
  // these (e.g. the `/i` flag from cfReturnRe or `yes|no` from
  // LITERAL_RE) would compile + pass every other test in this file.

  it("drops `return yes;` (CFML yes alias in LITERAL_RE)", () => {
    expect(isConstantReturnOnly(`function f() { return yes; }`)).toBe(true);
  });

  it("drops `<cfreturn no>` (CFML no alias in LITERAL_RE)", () => {
    const src =
      `<cffunction name="f">\n` +
      `  <cfreturn no>\n` +
      `</cffunction>`;
    expect(isConstantReturnOnly(src)).toBe(true);
  });

  it("drops `RETURN TRUE;` (case-insensitive scriptReturnRe)", () => {
    expect(isConstantReturnOnly(`function f() { RETURN TRUE; }`)).toBe(true);
  });

  it("drops `<CFRETURN TRUE>` (case-insensitive cfReturnRe)", () => {
    const src =
      `<cffunction name="f">\n` +
      `  <CFRETURN TRUE>\n` +
      `</cffunction>`;
    expect(isConstantReturnOnly(src)).toBe(true);
  });

  it("strips <!--- ---> CFML tag comments before matching cfreturn", () => {
    const src =
      `<cffunction name="f">\n` +
      `  <!--- legacy hook --->\n` +
      `  <cfreturn true>\n` +
      `</cffunction>`;
    expect(isConstantReturnOnly(src)).toBe(true);
  });

  it("drops `<CFFUNCTION>` uppercase wrapper (extractBody /i flag)", () => {
    // Pins the `"i"` flag on extractBody's <cffunction> regex at
    // triviality.ts:85. A regression dropping `"i"` would fail to
    // recognize SHOUTING-tag wrappers (legacy ColdFusion code commonly
    // uses all-caps tags), the function would return null from
    // extractBody, and the candidate would be wrongly kept as
    // non-constant.
    const src =
      `<CFFUNCTION name="f">\n` +
      `  <CFRETURN TRUE>\n` +
      `</CFFUNCTION>`;
    expect(isConstantReturnOnly(src)).toBe(true);
  });

  it("keeps `return +1;` (LITERAL_RE only allows `-?`, not `[+-]?`)", () => {
    // Pins the deliberate-narrow LITERAL_RE integer alternation `-?\d+`
    // at triviality.ts:36. Explicit `+` sign on a return literal is
    // stylistically unusual; today the candidate is KEPT (not dropped).
    // A refactor widening to `[+-]?\d+` would silently start dropping
    // these as trivial. This test pins the current contract; flipping
    // it requires a deliberate edit + a comment-update on this test.
    expect(isConstantReturnOnly(`function f() { return +1; }`)).toBe(false);
  });

  it("keeps body with code between two block comments (lazy `*?`)", () => {
    // Pins the lazy `[\s\S]*?` in the block-comment strip at
    // triviality.ts:109. A regression dropping the lazy `?` (greedy
    // `[\s\S]*`) would swallow everything between the FIRST `/*` and
    // the LAST `*/`, so the real statement between the two block
    // comments would be erased and the body would collapse to just
    // `return true;`, mis-classifying as a constant return.
    const src =
      `function f() {\n` +
      `  /* head */\n` +
      `  writeLog("hit");\n` +
      `  /* tail */\n` +
      `  return true;\n` +
      `}`;
    expect(isConstantReturnOnly(src)).toBe(false);
  });
});

describe("filterConstantReturns, escape hatch", () => {
  function mk(name: string, source: string): Candidate {
    return {
      language: "cfml",
      filePath: `/x/${name}.cfc`,
      relativePath: `${name}.cfc`,
      name,
      kind: "cf-script-function",
      lineStart: 1,
      lineEnd: 3,
      source,
      hints: {},
    };
  }
  const stub = mk("onRequestStart", `function onRequestStart() { return true; }`);
  const real = mk("compute", `function compute(x) { return arguments.x * 2; }`);

  it("drops constant-return candidates when includeConstantReturns=false", () => {
    const out = filterConstantReturns([stub, real], false);
    expect(out.map((c) => c.name)).toEqual(["compute"]);
  });
  it("keeps constant-return candidates when includeConstantReturns=true (escape hatch)", () => {
    const out = filterConstantReturns([stub, real], true);
    expect(out.map((c) => c.name)).toEqual(["onRequestStart", "compute"]);
  });
});
