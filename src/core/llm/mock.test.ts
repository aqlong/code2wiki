import { describe, it, expect } from "vitest";
import { mockExtract } from "./mock.js";
import type { Candidate } from "../types.js";

const cfCandidate: Candidate = {
  language: "cfml",
  filePath: "/x/publisher.cfc",
  relativePath: "publisher.cfc",
  name: "publish",
  kind: "cf-tag-function",
  lineStart: 100,
  lineEnd: 200,
  source: "<cffunction name=\"publish\"></cffunction>",
  hints: {
    parameters: [{ name: "siteid" }, { name: "pushMode" }],
    databaseTables: ["tsettings", "tglobals"],
    callees: ["copyDir", "announceEvent"],
  },
};

function makeCandidate(overrides: Partial<Candidate>): Candidate {
  return {
    language: "java",
    filePath: "/x/Foo.java",
    relativePath: "Foo.java",
    name: "doThing",
    kind: "function",
    lineStart: 1,
    lineEnd: 10,
    source: "",
    hints: {},
    ...overrides,
  };
}

describe("mockExtract", () => {
  const result = mockExtract(cfCandidate, "demo") as Record<string, unknown>;

  it("includes a DRAFT marker in the title so users never confuse it for real output", () => {
    expect(String(result["title"])).toMatch(/DRAFT/);
  });

  it("returns confidence='low' for any mock output", () => {
    expect(result["confidence"]).toBe("low");
  });

  it("explains how to enable real extraction in the summary", () => {
    const summary = String(result["summary"]);
    expect(summary).toMatch(/ANTHROPIC_API_KEY|DEEPSEEK_API_KEY/);
  });

  it("surfaces parser-detected database tables as raw business rules", () => {
    const rules = result["business_rules"] as Array<{ rule: string }>;
    const allRules = rules.map((r) => r.rule).join(" ");
    expect(allRules).toMatch(/tsettings/);
  });

  it("emits a tag indicating mock origin", () => {
    expect(result["tags"]).toContain("mock-output");
  });
});

// The mock is the unauthenticated-dev + CI smoke path: every test run + every
// new-contributor first invocation routes through it. Without these pins the
// three-way kind branching, the humanize regex pipeline, the callees cap, and
// the business_rules conditional shape can silently regress and BAs see wrong
// actor/trigger copy on the smoke-test pages they're judging the product by.
describe("mockExtract: kind branching and helper shape", () => {
  it("controller-method: actor describes a signed-in user; trigger names the endpoint; tags has 'controller' not 'library'", () => {
    const cand = makeCandidate({
      kind: "controller-method",
      language: "java",
      name: "getUser",
    });
    const r = mockExtract(cand, "demo") as Record<string, unknown>;
    expect(String(r["actor"])).toMatch(/signed-in user/);
    expect(String(r["trigger"])).toMatch(/submits a request to the corresponding endpoint/);
    const tags = r["tags"] as string[];
    expect(tags).toContain("controller");
    expect(tags).not.toContain("library");
    // Defensive negatives: trigger MUST NOT carry the cf-tag or generic copy.
    expect(String(r["trigger"])).not.toMatch(/from the application layer/);
    expect(String(r["trigger"])).not.toMatch(/^A caller invokes this function\.$/);
  });

  it("cf-tag-function: actor is internal-caller; trigger names CFML application layer; tags has 'library' not 'controller'", () => {
    const cand = makeCandidate({
      kind: "cf-tag-function",
      language: "cfml",
      name: "publish",
    });
    const r = mockExtract(cand, "demo") as Record<string, unknown>;
    expect(String(r["actor"])).toBe("An internal application caller");
    expect(String(r["trigger"])).toMatch(/from the application layer/);
    const tags = r["tags"] as string[];
    expect(tags).toContain("library");
    expect(tags).not.toContain("controller");
    // A regression collapsing isCfTag into the controller branch would land
    // the wrong copy here; the negative pins it.
    expect(String(r["trigger"])).not.toMatch(/submits a request/);
  });

  it("kind='function' (neither controller nor cfTag) falls through to the bare-default trigger and library tag", () => {
    const cand = makeCandidate({ kind: "function", language: "java" });
    const r = mockExtract(cand, "demo") as Record<string, unknown>;
    expect(String(r["trigger"])).toBe("A caller invokes this function.");
    expect(String(r["actor"])).toBe("An internal application caller");
    const tags = r["tags"] as string[];
    expect(tags).toContain("library");
    expect(tags).toContain("function");
    // Defensive negatives against the other two branches' copy.
    expect(String(r["trigger"])).not.toMatch(/submits a request/);
    expect(String(r["trigger"])).not.toMatch(/from the application layer/);
  });

  // humanize() runs four substitutions then trim+lowercase, then capitalize()
  // upper-cases the first char. A regression dropping any step (e.g. removing
  // the [._] replace, or losing the space-collapse) would silently mis-render
  // the smoke-test title and confuse new contributors. Pin every step with a
  // single composite input.
  it("humanize composition: camelCase splits, dots+underscores become spaces, multi-space collapses, lowercase + capitalize", () => {
    // "doFooBar.x_y_Z" exercises camelCase split (3 segments + tail Z), dot
    // replacement, underscore replacement (twice), and space collapse. The
    // `_Z` produces a [space-from-camelCase-split][underscore-as-space] pair
    // that ONLY collapses to single space if \s+ → " " is intact; a
    // regression dropping that step would surface as the literal "x y  z"
    // (double space) in the title.
    const cand = makeCandidate({ name: "doFooBar.x_y_Z" });
    const r = mockExtract(cand, "demo") as Record<string, unknown>;
    expect(String(r["title"])).toBe("Do foo bar x y z (DRAFT)");
    // Defensive negative: regression dropping space-collapse surfaces as double space.
    expect(String(r["title"])).not.toMatch(/x y {2,}z/);
    // Defensive negative: regression dropping dot replace surfaces as "bar.x".
    expect(String(r["title"])).not.toMatch(/bar\.x/);
    // Defensive negative: regression dropping underscore replace surfaces as "x_y" or "y_z".
    expect(String(r["title"])).not.toMatch(/_/);
    // Defensive negative: regression dropping camelCase split surfaces as "doFooBar" run-on.
    expect(String(r["title"])).not.toMatch(/foobar/);
  });

  // callees are capped at 5 via .slice(0, 5). main_flow shape is
  // [entry, ...callees.slice(0,5), return] = 7 entries for any input
  // with >= 5 callees. A regression dropping the cap would inflate the
  // mock page with every callee (some real codebases have 50+).
  it("callees are capped at 5 in main_flow regardless of input length", () => {
    const cand = makeCandidate({
      hints: { callees: ["a", "b", "c", "d", "e", "f", "g", "h"] },
    });
    const r = mockExtract(cand, "demo") as Record<string, unknown>;
    const flow = r["main_flow"] as Array<{ step: string }>;
    expect(flow.length).toBe(7); // entry + 5 callees + return
    expect(flow[0]!.step).toMatch(/enters `doThing`/);
    expect(flow[1]!.step).toMatch(/calls `a`/);
    expect(flow[5]!.step).toMatch(/calls `e`/);
    expect(flow[6]!.step).toBe("Control returns to the caller.");
    // Defensive negatives: callees 6, 7, 8 must NOT appear anywhere.
    const flowText = flow.map((s) => s.step).join("\n");
    expect(flowText).not.toMatch(/calls `f`/);
    expect(flowText).not.toMatch(/calls `g`/);
    expect(flowText).not.toMatch(/calls `h`/);
  });

  // business_rules is built from two independent conditional spreads (db
  // tables, then annotations); a regression flipping their order would
  // shift which rule the BA reads first, and an empty-hints regression
  // dropping the optional-chain guards would crash on every smoke run.
  it("business_rules: empty hints → []; both present → [db, annotations] in that order", () => {
    const empty = makeCandidate({ hints: {} });
    const rEmpty = mockExtract(empty, "demo") as Record<string, unknown>;
    expect(rEmpty["business_rules"]).toEqual([]);

    const both = makeCandidate({
      hints: {
        databaseTables: ["users", "orders"],
        annotations: ["@GetMapping", "@Transactional"],
      },
    });
    const rBoth = mockExtract(both, "demo") as Record<string, unknown>;
    const rules = rBoth["business_rules"] as Array<{ rule: string }>;
    expect(rules).toHaveLength(2);
    // db comes first; annotations second.
    expect(rules[0]!.rule).toMatch(/Touches database tables: users, orders/);
    expect(rules[1]!.rule).toMatch(/Annotations present: @GetMapping, @Transactional/);
  });
});
