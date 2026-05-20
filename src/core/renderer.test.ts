import { describe, expect, it } from "vitest";
import { renderUseCase } from "./renderer.js";
import type { UseCase } from "./types.js";

// `renderUseCase` is the entire Markdown rendering surface for use
// cases. Every published page (Confluence + Notion) and every regen
// roundtrip goes through it. A regression in:
//   - frontmatter field set / order
//   - section ordering or empty-array suppression
//   - footnote numbering for main_flow / business_rules
//   - the managed-fence layout (parsed by lib/feedback/fence.ts AND
//     the publishers' replace-inside-fence helpers)
//   - confidence-reason rendering
// ...would silently break customer wikis with no test feedback. The
// only prior coverage was a smoke test in integration.test.ts that
// pins three contains() probes; everything else was reasoned-only.

function baseUseCase(over: Partial<UseCase> = {}): UseCase {
  return {
    code2wiki_id: "demo-v1",
    title: "Demo use case",
    slug: "demo-use-case",
    actor: "A signed-in user",
    status: "active",
    last_generated: "2026-05-11T00:00:00Z",
    last_commit: "abc1234",
    confidence: "high",
    source_files: [{ path: "src/Demo.java", lines: "10-25" }],
    tags: ["alpha"],
    summary: "A short summary line.",
    actor_detail: "Detail about the actor.",
    trigger: "A user clicks Submit.",
    preconditions: [],
    main_flow: [],
    alternate_flows: [],
    postconditions: [],
    business_rules: [],
    test_scenarios: [],
    related: [],
    confidence_reason: "",
    ...over,
  };
}

describe("renderUseCase frontmatter", () => {
  it("emits the 10 expected frontmatter fields in declared order and excludes body fields", () => {
    const md = renderUseCase(baseUseCase());
    const fence = md.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fence).not.toBeNull();
    const fm = fence![1]!;
    // Order is asserted by the joined-keys check; ordering matters
    // because diff tools surface frontmatter-reorder as noise.
    const keysInOrder = fm
      .split("\n")
      .filter((l) => /^[a-z0-9_]+:/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keysInOrder).toEqual([
      "code2wiki_id",
      "title",
      "slug",
      "actor",
      "status",
      "last_generated",
      "last_commit",
      "confidence",
      "source_files",
      "tags",
    ]);
    // Body fields must NOT leak into frontmatter, regression guard
    // against a careless `yaml.dump(useCase, …)`.
    expect(fm).not.toMatch(/^summary:/m);
    expect(fm).not.toMatch(/^actor_detail:/m);
    expect(fm).not.toMatch(/^trigger:/m);
    expect(fm).not.toMatch(/^main_flow:/m);
    expect(fm).not.toMatch(/^confidence_reason:/m);
  });

  it("serializes source_files + tags as YAML arrays with the expected values", () => {
    const md = renderUseCase(
      baseUseCase({
        source_files: [
          { path: "src/A.java", lines: "1-5" },
          { path: "src/B.java", lines: "10-20" },
        ],
        tags: ["billing", "checkout"],
      }),
    );
    expect(md).toMatch(/source_files:\n {2}- path: src\/A\.java\n {4}lines: 1-5\n {2}- path: src\/B\.java\n {4}lines: 10-20/);
    expect(md).toMatch(/tags:\n {2}- billing\n {2}- checkout/);
  });
});

describe("renderUseCase always-present sections", () => {
  it("always emits Summary, Actor and triggers, and Source links", () => {
    const md = renderUseCase(baseUseCase());
    expect(md).toContain("## Summary\n\nA short summary line.");
    expect(md).toContain("## Actor and triggers");
    expect(md).toContain("- **Actor:** A signed-in user");
    expect(md).toContain("## Source links");
    expect(md).toContain("<details>");
    expect(md).toContain("</details>");
    expect(md).toContain("- `src/Demo.java` lines 10-25");
  });

  it("omits the Trigger line when trigger is empty (falsy guard)", () => {
    const md = renderUseCase(baseUseCase({ trigger: "" }));
    expect(md).toContain("- **Actor:** A signed-in user");
    expect(md).not.toContain("- **Trigger:**");
  });
});

describe("renderUseCase optional section gating", () => {
  it("skips Preconditions / Postconditions / Business rules / Test scenarios / Related / Alternate flows / Main flow when arrays are empty", () => {
    const md = renderUseCase(baseUseCase());
    expect(md).not.toContain("## Preconditions");
    expect(md).not.toContain("## Postconditions");
    expect(md).not.toContain("## Business rules");
    expect(md).not.toContain("## Suggested test scenarios");
    expect(md).not.toContain("## Related use cases");
    expect(md).not.toContain("## Alternate and exception flows");
    expect(md).not.toContain("## Main flow");
  });

  it("renders Preconditions and Postconditions as bullet lists when present", () => {
    const md = renderUseCase(
      baseUseCase({
        preconditions: ["User is signed in", "Cart is non-empty"],
        postconditions: ["Order is created", "Cart is cleared"],
      }),
    );
    expect(md).toContain("## Preconditions\n\n- User is signed in\n- Cart is non-empty");
    expect(md).toContain("## Postconditions\n\n- Order is created\n- Cart is cleared");
  });
});

describe("renderUseCase main flow numbering + footnotes", () => {
  it("numbers steps from 1 and attaches footnotes when present (mixed-footnote shape)", () => {
    const md = renderUseCase(
      baseUseCase({
        main_flow: [
          { step: "User clicks Pay." },
          {
            step: "System charges the card.",
            footnote: "See Stripe-handlers.",
          },
          { step: "Receipt is emailed." },
        ],
      }),
    );
    expect(md).toContain("## Main flow\n\n1. User clicks Pay.\n2. System charges the card. [^step2]\n3. Receipt is emailed.");
    // Footnotes block appears AFTER the numbered list, gathering only
    // footnoted steps. Step 1 + step 3 have no footnotes; only step 2
    // produces a [^step2]: line.
    expect(md).toContain("[^step2]: See Stripe-handlers.");
    expect(md).not.toContain("[^step1]:");
    expect(md).not.toContain("[^step3]:");
  });

  it("renders Main flow without a trailing footnotes block when no step has a footnote", () => {
    const md = renderUseCase(
      baseUseCase({ main_flow: [{ step: "Only step." }] }),
    );
    expect(md).toContain("## Main flow\n\n1. Only step.");
    expect(md).not.toMatch(/\[\^step\d+\]:/);
  });
});

describe("renderUseCase business rules + alternate flows + test scenarios + related", () => {
  it("renders Business rules with [^rule1] footnotes ONLY for footnoted rules", () => {
    const md = renderUseCase(
      baseUseCase({
        business_rules: [
          { rule: "Orders over $1000 require approval.", footnote: "ADR-007" },
          { rule: "Refunds within 30 days." },
        ],
      }),
    );
    expect(md).toContain("- Orders over $1000 require approval. [^rule1]");
    expect(md).toContain("- Refunds within 30 days.");
    expect(md).toContain("[^rule1]: ADR-007");
    expect(md).not.toContain("[^rule2]:");
  });

  it("renders Alternate and exception flows as labeled bullets", () => {
    const md = renderUseCase(
      baseUseCase({
        alternate_flows: [
          { label: "Card declined", description: "Show error, return to cart." },
          { label: "Timeout", description: "Retry once, then fail." },
        ],
      }),
    );
    expect(md).toContain("## Alternate and exception flows\n\n- **Card declined:** Show error, return to cart.\n- **Timeout:** Retry once, then fail.");
  });

  it("renders Suggested test scenarios with label-colon-gwt format", () => {
    const md = renderUseCase(
      baseUseCase({
        test_scenarios: [
          { label: "happy", gwt: "Given valid card, when Pay, then Order created." },
          { label: "decline", gwt: "Given declined card, when Pay, then Error shown." },
        ],
      }),
    );
    expect(md).toContain("## Suggested test scenarios\n\n- **happy**: Given valid card, when Pay, then Order created.\n- **decline**: Given declined card, when Pay, then Error shown.");
  });

  it("renders Related use cases as Markdown links to the related slug", () => {
    const md = renderUseCase(
      baseUseCase({
        related: [
          { slug: "view-cart", title: "View cart" },
          { slug: "checkout", title: "Checkout" },
        ],
      }),
    );
    expect(md).toContain("## Related use cases\n\n- [View cart](view-cart)\n- [Checkout](checkout)");
  });

  it("when validSlugs provided: only in-run related items get links; others become plain text", () => {
    const md = renderUseCase(
      baseUseCase({
        related: [
          { slug: "view-cart", title: "View cart" },
          { slug: "checkout", title: "Checkout" },
          { slug: "apply-coupon", title: "Apply coupon" },
        ],
      }),
      new Set(["view-cart", "apply-coupon"]), // only these two exist in the run
    );
    expect(md).toContain("## Related use cases\n\n- [View cart](view-cart)\n- Checkout\n- [Apply coupon](apply-coupon)");
  });

  it("when validSlugs provided and empty: all related items become plain text (no broken anchors)", () => {
    const md = renderUseCase(
      baseUseCase({
        related: [
          { slug: "view-cart", title: "View cart" },
          { slug: "checkout", title: "Checkout" },
        ],
      }),
      new Set(), // no slugs exist in this run
    );
    expect(md).toContain("## Related use cases\n\n- View cart\n- Checkout");
    expect(md).not.toContain("[View cart]");
    expect(md).not.toContain("[Checkout]");
  });
});

describe("renderUseCase managed fence", () => {
  it("emits the managed fence with the code2wiki_id and the confidence + reason inside", () => {
    const md = renderUseCase(
      baseUseCase({
        code2wiki_id: "billing-v3",
        confidence: "medium",
        confidence_reason: "Heuristic on call-graph depth.",
        last_commit: "deadbee",
        last_generated: "2026-01-02T03:04:05Z",
      }),
    );
    expect(md).toContain("<!-- code2wiki:managed:start id=billing-v3 -->");
    expect(md).toContain("<!-- code2wiki:managed:end -->");
    expect(md).toContain(
      "*Generated by [code2wiki](https://github.com/aqlong/code2wiki) from commit `deadbee` on 2026-01-02T03:04:05Z.*",
    );
    expect(md).toContain("*Confidence: **medium**, Heuristic on call-graph depth.*");
  });

  it("omits the ', reason' suffix when confidence_reason is empty (falsy-guard contract)", () => {
    const md = renderUseCase(baseUseCase({ confidence_reason: "" }));
    expect(md).toContain("*Confidence: **high***");
    expect(md).not.toContain("*Confidence: **high**, *");
  });

  it("places the managed fence AFTER the body and the '---' horizontal divider (publishers depend on this layout)", () => {
    const md = renderUseCase(baseUseCase({ code2wiki_id: "layout-v1" }));
    const fenceStartIdx = md.indexOf("<!-- code2wiki:managed:start ");
    const fenceEndIdx = md.indexOf("<!-- code2wiki:managed:end -->");
    const sourceLinksIdx = md.indexOf("## Source links");
    // Source-links section lives in the body, BEFORE the fence; the
    // fence is the trailing audit banner. lib/feedback/fence.ts and the
    // publishers' regen helpers split on this boundary; if a future
    // refactor moved Source links inside the fence, regenerated pages
    // would lose the file citations on every publish.
    expect(sourceLinksIdx).toBeGreaterThan(0);
    expect(sourceLinksIdx).toBeLessThan(fenceStartIdx);
    expect(fenceStartIdx).toBeLessThan(fenceEndIdx);
    // The body's trailing horizontal-rule '---' sits between Source
    // links and the fence (separates the rendered doc from the banner).
    const between = md.slice(sourceLinksIdx, fenceStartIdx);
    expect(between).toMatch(/\n---\n/);
  });
});
