import { describe, it, expect } from "vitest";
import { NotionPublisher, markdownToNotionBlocks } from "./notion.js";
import type { PageInput } from "./types.js";
import type { CoexistenceConfig } from "./types.js";

const SAMPLE_PAGE: PageInput = {
  code2wiki_id: "java-foo-bar-v1",
  title: "Foo Bar",
  slug: "foo-bar",
  markdown:
    "## Summary\n\nA quick test paragraph.\n\n- Bullet one\n- Bullet two\n\n1. Step one\n2. Step two\n\n```js\nlet x = 1;\n```\n",
  tags: ["foo"],
};

const CFG = {
  apiToken: "secret_test_token",
  databaseId: "db-id-1",
};

function mockFetch(handler: (req: { url: string; method: string }) => { status: number; body: unknown }) {
  const calls: { url: string; method: string }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const { status, body } = handler({ url, method });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

describe("markdownToNotionBlocks", () => {
  const blocks = markdownToNotionBlocks(SAMPLE_PAGE.markdown) as Array<{
    type: string;
  }>;

  it("emits a heading_2 for ## headings", () => {
    expect(blocks.find((b) => b.type === "heading_2")).toBeDefined();
  });

  it("emits bulleted_list_item blocks for - items", () => {
    const bulleted = blocks.filter((b) => b.type === "bulleted_list_item");
    expect(bulleted.length).toBe(2);
  });

  it("emits numbered_list_item blocks for 1. items", () => {
    const numbered = blocks.filter((b) => b.type === "numbered_list_item");
    expect(numbered.length).toBe(2);
  });

  it("emits a code block for ``` fences", () => {
    const code = blocks.find((b) => b.type === "code");
    expect(code).toBeDefined();
  });

  it("emits heading_1 for # and heading_3 for ###", () => {
    const h = markdownToNotionBlocks("# Top Level\n### Third Level\n") as Array<{ type: string }>;
    expect(h.some((b) => b.type === "heading_1")).toBe(true);
    expect(h.some((b) => b.type === "heading_3")).toBe(true);
  });

  it("emits quote block for > lines", () => {
    const q = markdownToNotionBlocks("> a quoted line\n") as Array<{ type: string }>;
    expect(q.find((b) => b.type === "quote")).toBeDefined();
  });

  it("emits paragraph for plain non-special lines", () => {
    const p = markdownToNotionBlocks("just plain text\n") as Array<{ type: string }>;
    expect(p.find((b) => b.type === "paragraph")).toBeDefined();
  });
});

// Deeper edges: pin code-fence semantics, list-regex edges, and structural
// invariants the gold-path tests don't exercise. The Notion blocks payload is
// the LLM's structured output rendered to the customer's wiki; a regression
// here is visible to every Notion-target publish. Each case names the specific
// regression it guards against.
describe("markdownToNotionBlocks, deeper edges", () => {
  type BlockShape = {
    type: string;
    code?: { rich_text: Array<{ text: { content: string } }>; language: string };
    paragraph?: { rich_text: Array<{ text: { content: string } }> };
    numbered_list_item?: { rich_text: Array<{ text: { content: string } }> };
    bulleted_list_item?: { rich_text: Array<{ text: { content: string } }> };
  };

  it("empty markdown produces an empty block list", () => {
    // Pin: a regression emitting a phantom empty paragraph would create
    // visible whitespace blocks on pages generated from a fence-only body.
    expect(markdownToNotionBlocks("")).toEqual([]);
  });

  it("blank lines produce no blocks (not empty paragraphs)", () => {
    // Pin: a regression dropping the `trim() === ""` guard would emit one
    // paragraph per blank line, blowing up the API payload on long docs.
    const out = markdownToNotionBlocks("\n\n\nfoo\n\n\nbar\n\n") as BlockShape[];
    expect(out.length).toBe(2);
    expect(out.every((b) => b.type === "paragraph")).toBe(true);
  });

  it("code fence with no language defaults to 'plain text'", () => {
    // Pin: Notion API rejects empty `language`; defaulting to "plain text"
    // is the contract. A slip to "" or "text" would 400-fail every fence
    // a user wrote without a language tag.
    const out = markdownToNotionBlocks("```\nlet x = 1;\n```\n") as BlockShape[];
    const code = out.find((b) => b.type === "code")!;
    expect(code.code!.language).toBe("plain text");
    expect(code.code!.rich_text[0]!.text.content).toBe("let x = 1;");
  });

  it("code fence with explicit language passes language through verbatim", () => {
    // Pin: `lang = line.slice(3).trim()`, a regression lower-casing or
    // normalizing the tag would silently re-render `TypeScript` blocks as
    // `typescript`, an unintended difference for Notion's syntax highlight.
    const out = markdownToNotionBlocks("```TypeScript\nconst y = 2;\n```\n") as BlockShape[];
    const code = out.find((b) => b.type === "code")!;
    expect(code.code!.language).toBe("TypeScript");
  });

  it("unbalanced code fence terminates at end-of-input without infinite loop", () => {
    // Pin: the inner `while (i < lines.length && !lines[i]!.startsWith('```'))`
    // is the only guard against runaway. A regression dropping the
    // `i < lines.length` check would loop forever on an unterminated fence.
    // After the loop exits, the implementation still emits one code block
    // containing the captured lines, and the trailing `i++` (consume close)
    // safely overshoots to terminate the outer loop on next iteration.
    // Trailing newline produces an empty final split entry that gets
    // captured into the code body, pinned as current semantic so any
    // future trim/rstrip change surfaces as deliberate.
    const out = markdownToNotionBlocks("```js\nline one\nline two\n") as BlockShape[];
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe("code");
    expect(out[0]!.code!.rich_text[0]!.text.content).toBe("line one\nline two\n");
  });

  it("empty code block (open + close, no body) emits a code block with empty content", () => {
    // Pin: `code.join('\n')` of zero lines is "", a regression dispatching
    // on `code.length > 0` would silently drop legitimately empty code
    // examples (e.g., a placeholder for upcoming snippets).
    const out = markdownToNotionBlocks("```js\n```\n") as BlockShape[];
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe("code");
    expect(out[0]!.code!.rich_text[0]!.text.content).toBe("");
    expect(out[0]!.code!.language).toBe("js");
  });

  it("paragraph → code → paragraph stays as three separate blocks in order", () => {
    // Pin: ordering invariant. A regression merging consecutive paragraphs
    // around a code fence would scramble the customer's narrative.
    const out = markdownToNotionBlocks(
      "before fence\n\n```js\nconst z = 3;\n```\n\nafter fence\n",
    ) as BlockShape[];
    expect(out.map((b) => b.type)).toEqual(["paragraph", "code", "paragraph"]);
    expect(out[0]!.paragraph!.rich_text[0]!.text.content).toBe("before fence");
    expect(out[2]!.paragraph!.rich_text[0]!.text.content).toBe("after fence");
  });

  it("mixed bullet + numbered interleaved preserves order and per-line type", () => {
    // Pin: each list item is its own block (Notion expects flat). A regression
    // grouping consecutive same-type items into a single multi-line block
    // would collapse the customer's enumerated steps into one big bullet.
    const md = "- a bullet\n1. first step\n- another bullet\n2. second step\n";
    const out = markdownToNotionBlocks(md) as BlockShape[];
    expect(out.map((b) => b.type)).toEqual([
      "bulleted_list_item",
      "numbered_list_item",
      "bulleted_list_item",
      "numbered_list_item",
    ]);
    expect(out[1]!.numbered_list_item!.rich_text[0]!.text.content).toBe("first step");
    expect(out[3]!.numbered_list_item!.rich_text[0]!.text.content).toBe("second step");
  });

  it("multi-digit numbered prefix matches and is stripped fully", () => {
    // Pin: `/^\d+\. /` accepts 1-or-more digits and `replace(/^\d+\.\s+/, "")`
    // strips ALL of them. A regression to `/^\d\. /` would mis-classify
    // step 10+ as paragraphs; a regression to `.slice(3)` would leave "0. "
    // in the content.
    const out = markdownToNotionBlocks("10. tenth step\n") as BlockShape[];
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe("numbered_list_item");
    expect(out[0]!.numbered_list_item!.rich_text[0]!.text.content).toBe("tenth step");
  });

  it("regex-prefix variants without trailing space fall through to paragraph", () => {
    // Pin: every list/heading regex requires a trailing space. A regression
    // relaxing the space (e.g., switching `/^- /` to `/^-/`) would
    // mis-classify legitimate paragraphs like "-1 means …" or "#tags".
    const out = markdownToNotionBlocks("1.no-space\n-foo\n#bar\n>baz\n") as BlockShape[];
    expect(out.length).toBe(4);
    expect(out.every((b) => b.type === "paragraph")).toBe(true);
    expect(out[0]!.paragraph!.rich_text[0]!.text.content).toBe("1.no-space");
    expect(out[2]!.paragraph!.rich_text[0]!.text.content).toBe("#bar");
  });

  it("strips HTML comments so the fence markers don't leak as visible text", () => {
    const md = `# Title\n\n<!-- code2wiki:managed:start id=x -->\nBody.\n<!-- code2wiki:managed:end -->\n`;
    const out = markdownToNotionBlocks(md) as BlockShape[];
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("code2wiki:managed");
    expect(serialised).not.toContain("<!--");
    expect(serialised).toContain("Body.");
  });

  it("rewrites <details><summary>X</summary>Y</details> as a heading_3 + body", () => {
    const md = `<details>\n<summary>Implementation files</summary>\n\n- foo.java\n- bar.java\n\n</details>\n`;
    const out = markdownToNotionBlocks(md) as BlockShape[];
    // Heading_3 for the summary
    const h3 = out.find((b) => b.type === "heading_3");
    expect(h3).toBeDefined();
    expect(h3!.heading_3!.rich_text[0]!.text.content).toBe(
      "Implementation files",
    );
    // The bullets render as bulleted_list_item blocks
    const bullets = out.filter((b) => b.type === "bulleted_list_item");
    expect(bullets.length).toBe(2);
    // No leftover <details> or <summary> text
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("<details>");
    expect(serialised).not.toContain("<summary>");
  });

  it("converts a markdown horizontal rule into a divider block", () => {
    const md = `Para one.\n\n---\n\nPara two.\n`;
    const out = markdownToNotionBlocks(md) as BlockShape[];
    const divider = out.find((b) => b.type === "divider");
    expect(divider).toBeDefined();
    // The literal '---' string should never appear as paragraph text.
    expect(JSON.stringify(out)).not.toMatch(/"content":\s*"---"/);
  });

  it("also converts ***  *** triple-asterisk horizontal rule into a divider", () => {
    const out = markdownToNotionBlocks(`a\n\n***\n\nb\n`) as BlockShape[];
    expect(out.find((b) => b.type === "divider")).toBeDefined();
  });
});

describe("NotionPublisher", () => {
  it("creates a new page when query returns no match", async () => {
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (method === "POST" && url.endsWith(`/databases/${CFG.databaseId}/query`)) {
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/pages")) {
        return {
          status: 200,
          body: {
            id: "new-1",
            url: "https://notion.so/new-1",
            archived: false,
          },
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("created");
    expect(result?.externalId).toBe("new-1");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pages"))).toBe(true);
  });

  it("strips leading YAML frontmatter before rendering blocks (parity with Confluence; never leaks frontmatter keys)", async () => {
    // The publish command hands the whole generated .md file (frontmatter
    // included) to the publisher as page.markdown. bodyMarkdown() must strip it
    // via the shared stripFrontmatter() helper before markdownToNotionBlocks()
    // runs; otherwise code2wiki_id:/title:/confidence: lines leak as visible
    // paragraph/heading blocks on every published Notion page. Confluence got
    // this end-to-end guard in 0956532; this is the missing Notion half (a
    // refactor dropping stripFrontmatter from bodyMarkdown passes every other
    // Notion test because none of them feed a frontmatter-bearing page).
    // Reverse-validate: revert bodyMarkdown() to `page.markdown` and the
    // DO_NOT_LEAK_ME assertion fails.
    let createBody: { children?: unknown[] } | undefined;
    const fetch = buildBodyCaptureFetch((url, method, body) => {
      if (method === "POST" && url.endsWith(`/databases/${CFG.databaseId}/query`)) {
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/pages")) {
        createBody = body as typeof createBody;
        return { status: 200, body: { id: "fm-1", url: "https://notion.so/fm-1", archived: false } };
      }
      return { status: 404, body: {} };
    });
    const pageWithFrontmatter: PageInput = {
      ...SAMPLE_PAGE,
      markdown:
        "---\ncode2wiki_id: java-foo-bar-v1\ntitle: Foo Bar\nslug: foo-bar\nconfidence: high\nx_frontmatter_sentinel: DO_NOT_LEAK_ME\n---\n\n## Summary\n\nReal body paragraph.\n",
    };
    const pub = new NotionPublisher(CFG, { fetch });
    const [result] = await pub.publish([pageWithFrontmatter]);
    expect(result?.outcome).toBe("created");

    // Assert against the created page's child blocks only (sentinels below are
    // never written to Notion page properties, so a hit means a body leak).
    const childrenJson = JSON.stringify(createBody?.children ?? []);
    expect(childrenJson).toContain("Summary"); // body content survives the strip
    expect(childrenJson).toContain("Real body paragraph.");
    expect(childrenJson).not.toContain("DO_NOT_LEAK_ME"); // frontmatter never rendered
    expect(childrenJson).not.toContain("x_frontmatter_sentinel");
    expect(childrenJson).not.toContain("confidence: high");
  });

  it("updates an existing page when query returns a match", async () => {
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (method === "POST" && url.endsWith(`/databases/${CFG.databaseId}/query`)) {
        return {
          status: 200,
          body: {
            results: [
              {
                id: "existing-1",
                url: "https://notion.so/existing-1",
                archived: false,
              },
            ],
          },
        };
      }
      if (method === "GET" && url.includes("/blocks/existing-1/children")) {
        return { status: 200, body: { results: [] } };
      }
      if (method === "PATCH" && url.includes("/blocks/existing-1/children")) {
        return { status: 200, body: { results: [] } };
      }
      if (method === "PATCH" && url.endsWith("/pages/existing-1")) {
        return { status: 200, body: { id: "existing-1" } };
      }
      return { status: 404, body: {} };
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("updated");
    expect(result?.externalId).toBe("existing-1");
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/blocks/"))).toBe(true);
  });

  it("dry-run does not mutate", async () => {
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (method === "POST" && url.endsWith(`/databases/${CFG.databaseId}/query`)) {
        return { status: 200, body: { results: [] } };
      }
      throw new Error(`dry-run should not POST/PATCH; saw ${method} ${url}`);
    });
    const pub = new NotionPublisher(CFG, { fetch, dryRun: true });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("created");
    expect(result?.message).toContain("dry run");
    expect(calls.every((c) => !(c.method === "PATCH" || (c.method === "POST" && c.url.endsWith("/pages"))))).toBe(true);
  });

  it("captures errors per page without aborting the batch", async () => {
    let nthQuery = 0;
    const { fetch } = mockFetch(({ url, method }) => {
      if (method === "POST" && url.endsWith(`/databases/${CFG.databaseId}/query`)) {
        nthQuery++;
        if (nthQuery === 1) return { status: 500, body: {} };
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/pages")) {
        return { status: 200, body: { id: "p2", url: "https://notion.so/p2", archived: false } };
      }
      return { status: 404, body: {} };
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const results = await pub.publish([
      SAMPLE_PAGE,
      { ...SAMPLE_PAGE, code2wiki_id: "java-second-v1", slug: "second", title: "Second" },
    ]);
    expect(results[0]?.outcome).toBe("skipped");
    expect(results[1]?.outcome).toBe("created");
  });
});

function buildBodyCaptureFetch(
  handler: (url: string, method: string, body: unknown) => { status: number; body: unknown },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const { status, body: respBody } = handler(url, method, body);
    return new Response(JSON.stringify(respBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("NotionPublisher - claimed update path", () => {
  it("archives only generated blocks, patches banner in place, appends new content after banner", async () => {
    const archivedIds: string[] = [];
    let appendBody: { children: unknown[]; after?: string } | undefined;
    let bannerPatchBody: unknown;

    const fetch = buildBodyCaptureFetch((url, method, body) => {
      if (method === "POST" && url.endsWith(`/databases/${CFG.databaseId}/query`)) {
        return { status: 200, body: { results: [{ id: "page-1", url: "https://notion.so/p1", archived: false }] } };
      }
      if (method === "GET" && url.includes("/blocks/page-1/children")) {
        return {
          status: 200,
          body: {
            results: [
              { id: "banner-id", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [] } },
              { id: "gen-1", type: "paragraph", paragraph: { rich_text: [] } },
              { id: "div-id", type: "divider", divider: {} },
              { id: "orig-1", type: "paragraph", paragraph: { rich_text: [] } },
            ],
          },
        };
      }
      if (method === "DELETE") { archivedIds.push(url.split("/blocks/")[1]!); return { status: 200, body: {} }; }
      if (method === "PATCH" && url.endsWith("/blocks/banner-id")) { bannerPatchBody = body; return { status: 200, body: {} }; }
      if (method === "PATCH" && url.includes("/blocks/page-1/children")) { appendBody = body as typeof appendBody; return { status: 200, body: { results: [] } }; }
      if (method === "PATCH" && url.endsWith("/pages/page-1")) { return { status: 200, body: {} }; }
      return { status: 404, body: {} };
    });

    const pub = new NotionPublisher(CFG, { fetch });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("updated");
    expect(archivedIds).toEqual(["gen-1"]); // banner + div + orig preserved; only the generated block archived
    expect(bannerPatchBody).toBeDefined(); // banner block patched in place with new content
    expect(appendBody?.after).toBe("banner-id"); // new generated blocks inserted after banner (before divider)
  });
});

// replacePageBody is the load-bearing update-path surface; every Notion-target
// republish hits it. findClaimSeparator's banner-OR-divider negatives all fall
// through to the destructive greenfield repaint (nuke + repaint banner+blocks),
// so a sloppy boundary check silently deletes customer-preserved content. The
// happy-path test above pins the canonical claim layout; these cases pin the
// branching itself plus what each branch actually writes.
type NotionChild = {
  id: string;
  type: string;
  callout?: { icon?: { emoji?: string }; rich_text?: unknown[] };
  divider?: Record<string, unknown>;
  paragraph?: { rich_text?: unknown[] };
};
type UpdateArtifacts = {
  archivedIds: string[];
  bannerPatchBodies: Array<{ blockId: string; body: unknown }>;
  appendBodies: Array<{ children: unknown[]; after?: string }>;
  propertiesPatchCount: number;
  propertiesPatchBody?: unknown;
  fetch: typeof fetch;
};
function buildUpdateFetch(pageId: string, children: NotionChild[]): UpdateArtifacts {
  const artifacts = {
    archivedIds: [] as string[],
    bannerPatchBodies: [] as Array<{ blockId: string; body: unknown }>,
    appendBodies: [] as Array<{ children: unknown[]; after?: string }>,
    propertiesPatchCount: 0,
    propertiesPatchBody: undefined as unknown,
  } as UpdateArtifacts;
  artifacts.fetch = buildBodyCaptureFetch((url, method, body) => {
    if (method === "POST" && url.endsWith(`/databases/${CFG.databaseId}/query`)) {
      return { status: 200, body: { results: [{ id: pageId, url: `https://notion.so/${pageId}`, archived: false }] } };
    }
    if (method === "GET" && url.includes(`/blocks/${pageId}/children`)) {
      return { status: 200, body: { results: children } };
    }
    if (method === "DELETE" && url.includes("/blocks/")) {
      artifacts.archivedIds.push(url.split("/blocks/")[1]!);
      return { status: 200, body: {} };
    }
    if (method === "PATCH" && url.includes("/blocks/") && url.endsWith("/children")) {
      artifacts.appendBodies.push(body as { children: unknown[]; after?: string });
      return { status: 200, body: { results: [] } };
    }
    if (method === "PATCH" && url.includes("/blocks/")) {
      const blockId = url.split("/blocks/")[1]!;
      artifacts.bannerPatchBodies.push({ blockId, body });
      return { status: 200, body: {} };
    }
    if (method === "PATCH" && url.endsWith(`/pages/${pageId}`)) {
      artifacts.propertiesPatchCount++;
      artifacts.propertiesPatchBody = body;
      return { status: 200, body: {} };
    }
    return { status: 404, body: {} };
  });
  return artifacts;
}

describe("NotionPublisher.replacePageBody branching edges", () => {
  it("greenfield path archives EVERY pre-existing child, then appends [banner, ...blocks]", async () => {
    // Regression guard against an update that "additive-appends" without
    // archiving; the page would double-paint on every republish until the
    // child cap is hit and Notion starts rejecting.
    const a = buildUpdateFetch("page-gf", [
      { id: "old-1", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "old-2", type: "heading_2", paragraph: { rich_text: [] } },
      { id: "old-3", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("updated");
    expect(a.archivedIds).toEqual(["old-1", "old-2", "old-3"]);
    expect(a.appendBodies.length).toBe(1);
    const appended = a.appendBodies[0]!;
    expect(appended.after).toBeUndefined(); // greenfield prepends banner; no after
    const first = appended.children[0] as { type?: string };
    expect(first?.type).toBe("callout"); // banner is first
  });

  it("banner with WRONG emoji falls through to greenfield (archives the wrong-emoji callout too)", async () => {
    // findClaimSeparator keys on emoji "📝" specifically; a customer page whose
    // banner emoji was changed (or a future emoji bump that runs against an
    // old-banner page) MUST repaint, not silently fail to detect the boundary
    // and then preserve stale content the customer doesn't realize is there.
    const a = buildUpdateFetch("page-wrong-emoji", [
      { id: "wrong-banner", type: "callout", callout: { icon: { emoji: "📋" }, rich_text: [] } },
      { id: "gen-x", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "div-x", type: "divider", divider: {} },
      { id: "orig-x", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    // All four children archived (greenfield); no banner-PATCH happened.
    expect(a.archivedIds).toEqual(["wrong-banner", "gen-x", "div-x", "orig-x"]);
    expect(a.bannerPatchBodies).toEqual([]);
  });

  it("banner present but NO divider falls through to greenfield", async () => {
    // Without a divider we can't bound the managed region, so we cannot
    // preserve "below the divider" content. The correct behavior is the
    // destructive repaint, NOT a "smart" partial preserve that would surface
    // stale or duplicated content in the rendered page.
    const a = buildUpdateFetch("page-no-div", [
      { id: "banner-id", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [] } },
      { id: "stale-1", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "stale-2", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect(a.archivedIds).toEqual(["banner-id", "stale-1", "stale-2"]);
    expect(a.bannerPatchBodies).toEqual([]);
    expect(a.appendBodies.length).toBe(1);
  });

  it("divider BEFORE banner is not a valid claim layout: falls through to greenfield", async () => {
    // findClaimSeparator walks AFTER the banner for the divider; a leading
    // divider must not be mistaken for the claim separator (which would
    // ARCHIVE the banner, the opposite of what we want).
    const a = buildUpdateFetch("page-rev", [
      { id: "rogue-div", type: "divider", divider: {} },
      { id: "banner-id", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [] } },
      { id: "tail", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect(a.archivedIds).toEqual(["rogue-div", "banner-id", "tail"]);
  });

  it("banner not at index 0 is still detected: claim path archives only the gen-range", async () => {
    // An operator might insert a callout / heading above our banner. We use
    // findIndex (first match), so banner detection survives leading blocks;
    // archival starts at bannerIdx + 1, NOT at 0, so the operator's leading
    // content must be preserved.
    const a = buildUpdateFetch("page-shift", [
      { id: "op-note", type: "callout", callout: { icon: { emoji: "ℹ️" }, rich_text: [] } },
      { id: "banner-id", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [] } },
      { id: "gen-a", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "gen-b", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "div-id", type: "divider", divider: {} },
      { id: "orig-1", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect(a.archivedIds).toEqual(["gen-a", "gen-b"]);
    expect(a.bannerPatchBodies.length).toBe(1);
    expect(a.bannerPatchBodies[0]?.blockId).toBe("banner-id"); // not op-note
    expect(a.appendBodies[0]?.after).toBe("banner-id");
  });

  it("banner PATCH body carries the NEW banner content from bannerBlock (not the existing banner)", async () => {
    // Regression guard: a refactor that sent the old `banner` object back
    // would silently stale-banner the page (lastSyncedIso would never refresh,
    // breaking the customer-visible "Last synced: <iso>" line in the banner).
    const a = buildUpdateFetch("page-banner-content", [
      { id: "banner-id", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [{ text: { content: "stale banner" } }] } },
      { id: "gen-1", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "div-id", type: "divider", divider: {} },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    const patch = a.bannerPatchBodies[0]!.body as {
      callout?: { icon?: { emoji?: string }; rich_text?: Array<{ text?: { content?: string } }> };
    };
    expect(patch.callout?.icon?.emoji).toBe("📝");
    // The fresh banner content includes the canonical opening sentence.
    const firstText = patch.callout?.rich_text?.[0]?.text?.content ?? "";
    expect(firstText).toContain("auto-generated by code2wiki");
    // And it includes a fresh Last synced ISO string (NOT the stale-banner content).
    const allText = (patch.callout?.rich_text ?? []).map((r) => r.text?.content ?? "").join("");
    expect(allText).toContain("Last synced:");
    expect(allText).not.toContain("stale banner");
  });

  it("multiple generated blocks between banner and divider are ALL archived", async () => {
    // Off-by-one regression guard on `for (let i = bannerIdx+1; i < separatorIdx; i++)`.
    const a = buildUpdateFetch("page-multi-gen", [
      { id: "banner-id", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [] } },
      { id: "gen-1", type: "heading_2", paragraph: { rich_text: [] } },
      { id: "gen-2", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "gen-3", type: "bulleted_list_item", paragraph: { rich_text: [] } },
      { id: "gen-4", type: "code", paragraph: { rich_text: [] } },
      { id: "div-id", type: "divider", divider: {} },
      { id: "orig-1", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect(a.archivedIds).toEqual(["gen-1", "gen-2", "gen-3", "gen-4"]);
    // The divider and the customer's original block survive.
    expect(a.archivedIds).not.toContain("div-id");
    expect(a.archivedIds).not.toContain("orig-1");
  });

  it("empty managed region (banner immediately followed by divider): banner PATCH fires, no gen-archive, append still wires after banner", async () => {
    // The very first publish after a freshly-claimed page has nothing to
    // archive in the managed region. Pin that the loop bound `i < separatorIdx`
    // executes zero times (i = bannerIdx+1 = separatorIdx) and we still
    // PATCH the banner + appendChildren-after.
    const a = buildUpdateFetch("page-empty-managed", [
      { id: "banner-id", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [] } },
      { id: "div-id", type: "divider", divider: {} },
      { id: "orig-1", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect(a.archivedIds).toEqual([]);
    expect(a.bannerPatchBodies.length).toBe(1);
    expect(a.appendBodies.length).toBe(1);
    expect(a.appendBodies[0]?.after).toBe("banner-id");
  });

  it("empty existing page (zero children): no DELETE, single PATCH with [banner, ...blocks]", async () => {
    // Edge case: the page exists in the database but has no body yet. Must
    // not crash; must emit the banner + blocks in one append.
    const a = buildUpdateFetch("page-empty", []);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("updated");
    expect(a.archivedIds).toEqual([]);
    expect(a.appendBodies.length).toBe(1);
    const appended = a.appendBodies[0]!;
    expect(appended.after).toBeUndefined();
    const first = appended.children[0] as { type?: string };
    expect(first?.type).toBe("callout");
    // Body blocks follow the banner.
    expect(appended.children.length).toBeGreaterThan(1);
  });

  it("properties PATCH fires on both greenfield AND claim branches (title/titlePrefix changes must propagate)", async () => {
    // Both branches must converge on the final PATCH /pages/<id>; a refactor
    // that moved the call into one branch would silently break titlePrefix
    // application (a customer enabling titlePrefix mid-stream would see
    // unchanged page titles in Notion despite our preflight reporting them
    // as renamed).
    const greenfield = buildUpdateFetch("page-gf-prop", [
      { id: "old-1", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const claim = buildUpdateFetch("page-cl-prop", [
      { id: "banner-id", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [] } },
      { id: "gen-1", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "div-id", type: "divider", divider: {} },
    ]);
    await new NotionPublisher(CFG, { fetch: greenfield.fetch }).publish([SAMPLE_PAGE]);
    await new NotionPublisher(CFG, { fetch: claim.fetch }).publish([SAMPLE_PAGE]);
    expect(greenfield.propertiesPatchCount).toBe(1);
    expect(claim.propertiesPatchCount).toBe(1);
    // The propertiesPatchBody for the claim branch carries the page's title in
    // Notion's title-rich-text shape (proving propertiesFor was called); a
    // regression dropping the call entirely would surface as propertiesPatchCount=0.
    const props = (claim.propertiesPatchBody as { properties?: { Name?: { title?: Array<{ text?: { content?: string } }> } } })?.properties;
    expect(props?.Name?.title?.[0]?.text?.content).toBe("Foo Bar");
  });
});

// findClaimSeparator drives the claim-vs-greenfield branching in replacePageBody.
// The existing "branching edges" describe pins outcomes when the layout is
// near-canonical (wrong emoji, missing divider, divider-before-banner, banner-
// shifted-by-one). These six pin the narrow corner cases that survive longer
// in the wild: callouts whose icon/emoji shape was mutated by an operator or a
// future Notion API change, AND multi-banner / multi-divider pages where the
// findIndex semantic matters. A regression dropping the optional chaining on
// `b.callout?.icon?.emoji` would TypeError mid-publish on operator-inserted
// callouts without a callout payload; a regression to findLastIndex would
// silently pick the wrong banner or divider and archive customer content the
// claim layout was supposed to preserve.
describe("NotionPublisher.findClaimSeparator corner cases (via replacePageBody)", () => {
  it("callout block with NO `callout` payload falls through to greenfield (optional chaining handles undefined)", async () => {
    // Operator-inserted callout that the Notion API surfaced without a callout
    // payload structure. A regression dropping the `?.` on `b.callout` would
    // surface as `Cannot read properties of undefined (reading 'icon')` mid-
    // publish, taking down every page on the customer's database with a
    // similarly-shaped block.
    const a = buildUpdateFetch("page-no-callout", [
      { id: "bare-callout", type: "callout" }, // no .callout payload at all
      { id: "old-1", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("updated");
    expect(a.archivedIds).toEqual(["bare-callout", "old-1"]); // greenfield archives all
    expect(a.bannerPatchBodies).toEqual([]); // no claim path -> no banner PATCH
  });

  it("callout block with `callout` payload but NO `icon` falls through to greenfield", async () => {
    // Pins the second link in the optional-chain: `callout?.icon?.emoji`. A
    // regression dropping the `?.` after icon would TypeError on any callout
    // whose icon was deleted by a Notion editor (the icon field is optional).
    const a = buildUpdateFetch("page-no-icon", [
      { id: "icon-less", type: "callout", callout: { rich_text: [] } }, // no icon
      { id: "old-1", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect(a.archivedIds).toEqual(["icon-less", "old-1"]);
    expect(a.bannerPatchBodies).toEqual([]);
  });

  it("callout block with `icon` but NO `emoji` falls through to greenfield", async () => {
    // Customer used a custom-image icon (Notion supports `icon.type=external`
    // with no emoji field). Equality check `... === "📝"` must NOT match
    // undefined; this case independently pins the third link in the chain.
    const a = buildUpdateFetch("page-no-emoji", [
      { id: "img-icon", type: "callout", callout: { icon: {}, rich_text: [] } }, // icon present, no emoji
      { id: "old-1", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect(a.archivedIds).toEqual(["img-icon", "old-1"]);
    expect(a.bannerPatchBodies).toEqual([]);
  });

  it("multiple 📝 banners: claim path uses the FIRST banner via findIndex (regression guard against findLastIndex)", async () => {
    // An operator added a SECOND 📝 callout below our managed block (perhaps
    // copy-pasted from another page). findIndex returns the first match; a
    // regression to findLastIndex would silently PATCH the wrong banner block
    // (the operator's copy) AND archive the customer's claim-preserved content
    // because the archive loop would start AFTER the second banner.
    const a = buildUpdateFetch("page-multi-banner", [
      { id: "first-banner", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [] } },
      { id: "gen-1", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "second-banner", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [] } },
      { id: "gen-2", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "div-id", type: "divider", divider: {} },
      { id: "orig-1", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    // FIRST banner is the picked one: PATCH targets it, archive range is
    // [first-banner+1 .. divider), so the SECOND banner gets archived along
    // with the gen blocks; the customer's original (orig-1, post-divider) survives.
    expect(a.bannerPatchBodies.length).toBe(1);
    expect(a.bannerPatchBodies[0]?.blockId).toBe("first-banner");
    expect(a.archivedIds).toEqual(["gen-1", "second-banner", "gen-2"]);
    expect(a.archivedIds).not.toContain("first-banner");
    expect(a.archivedIds).not.toContain("orig-1");
    expect(a.appendBodies[0]?.after).toBe("first-banner"); // new blocks insert after FIRST banner
  });

  it("multiple dividers after the banner: claim path uses the FIRST divider after banner (regression guard against lastIndexOf)", async () => {
    // The customer's claim-preserved content can contain its own dividers
    // (Notion's `---` rule is a common BA-written separator). findClaimSeparator
    // must pick the FIRST post-banner divider; a regression to lastIndexOf
    // would archive customer content sitting between the two dividers, since
    // the archive loop would extend up to the LAST divider.
    const a = buildUpdateFetch("page-multi-div", [
      { id: "banner-id", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [] } },
      { id: "gen-1", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "gen-2", type: "paragraph", paragraph: { rich_text: [] } },
      { id: "first-div", type: "divider", divider: {} },
      { id: "cust-1", type: "paragraph", paragraph: { rich_text: [] } }, // customer-preserved content
      { id: "second-div", type: "divider", divider: {} }, // customer's own divider
      { id: "cust-2", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    // Archive range is [banner+1 .. first-div), so only gen-1 + gen-2; every
    // block at and after first-div survives.
    expect(a.archivedIds).toEqual(["gen-1", "gen-2"]);
    expect(a.archivedIds).not.toContain("first-div");
    expect(a.archivedIds).not.toContain("cust-1");
    expect(a.archivedIds).not.toContain("second-div");
    expect(a.archivedIds).not.toContain("cust-2");
    expect(a.bannerPatchBodies[0]?.blockId).toBe("banner-id");
    expect(a.appendBodies[0]?.after).toBe("banner-id");
  });

  it("a non-callout block whose rich_text contains 📝 does NOT trigger banner detection (type === 'callout' is required)", async () => {
    // Defensive pin against a hypothetical refactor that switched banner
    // detection from the block-type+icon-emoji predicate to a content-text
    // scan. A paragraph that happens to mention 📝 in its body (for example,
    // BA-written prose describing the syncing process) must NOT be mistaken
    // for the banner. Greenfield path archives everything.
    const a = buildUpdateFetch("page-emoji-in-text", [
      {
        id: "para-with-emoji",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: "📝 the syncing process" } }] as unknown[] },
      },
      { id: "div-id", type: "divider", divider: {} }, // divider also present
      { id: "tail", type: "paragraph", paragraph: { rich_text: [] } },
    ]);
    const pub = new NotionPublisher(CFG, { fetch: a.fetch });
    await pub.publish([SAMPLE_PAGE]);
    // Greenfield: every existing block archived; no banner PATCH.
    expect(a.archivedIds).toEqual(["para-with-emoji", "div-id", "tail"]);
    expect(a.bannerPatchBodies).toEqual([]);
  });
});

// replacePageBody's final `PATCH /pages/<id>` carries the properties payload
// that propagates title (incl. titlePrefix), code2wiki_id (the upsert key),
// and the parallel-mode Section property. A regression in propertiesFor or in
// either branch's call to it silently breaks the customer-visible page title,
// forks upsert continuity, or strands parallel-mode pages without their
// section tag. The existing "properties PATCH fires on both branches" case
// pins the COUNT and the bare claim-branch title content; these six pin the
// PATCH BODY SHAPE for both branches across the coexistence-config dimensions.
type PropsPayload = {
  properties?: {
    Name?: { title?: Array<{ text?: { content?: string } }> };
    code2wiki_id?: { rich_text?: Array<{ text?: { content?: string } }> };
    Section?: { rich_text?: Array<{ text?: { content?: string } }> };
  };
};
const GREENFIELD_CHILDREN: NotionChild[] = [
  { id: "old-1", type: "paragraph", paragraph: { rich_text: [] } },
];
const CLAIM_CHILDREN: NotionChild[] = [
  { id: "banner-id", type: "callout", callout: { icon: { emoji: "📝" }, rich_text: [] } },
  { id: "gen-1", type: "paragraph", paragraph: { rich_text: [] } },
  { id: "div-id", type: "divider", divider: {} },
];

describe("NotionPublisher.replacePageBody properties PATCH payload", () => {
  it("code2wiki_id rich_text carries page.code2wiki_id verbatim (NOT slug, NOT title)", async () => {
    // Defensive pin: id/slug/title are distinct strings; a refactor that
    // confused the upsert key would surface here directly rather than as a
    // customer-impact outage where every publish forks new pages because
    // findByCode2wikiId can no longer match its own write.
    const distinct: PageInput = {
      ...SAMPLE_PAGE,
      code2wiki_id: "java-distinct-id-v1",
      slug: "distinct-slug",
      title: "Distinct Title",
    };
    const a = buildUpdateFetch("page-id-key", GREENFIELD_CHILDREN);
    await new NotionPublisher(CFG, { fetch: a.fetch }).publish([distinct]);
    const props = (a.propertiesPatchBody as PropsPayload).properties;
    expect(props?.code2wiki_id?.rich_text?.[0]?.text?.content).toBe(
      "java-distinct-id-v1",
    );
    expect(props?.code2wiki_id?.rich_text?.[0]?.text?.content).not.toBe(
      "distinct-slug",
    );
    expect(props?.code2wiki_id?.rich_text?.[0]?.text?.content).not.toBe(
      "Distinct Title",
    );
    // Section property must be absent in non-parallel (default) mode. Assert
    // properties is defined first so a regression that DROPPED the whole
    // PATCH body doesn't pass this case vacuously.
    expect(props).toBeDefined();
    expect("Section" in (props as object)).toBe(false);
  });

  it("titlePrefix on greenfield branch: Name.title becomes '[DOCS] Foo Bar' with single space", async () => {
    // Pin the literal `${prefix} ${title}` concatenation. A regression
    // dropping the space would surface as "[DOCS]Foo Bar" in every
    // customer's Notion page title.
    const a = buildUpdateFetch("page-tp-gf", GREENFIELD_CHILDREN);
    await new NotionPublisher(
      { ...CFG, coexistence: { titlePrefix: "[DOCS]" } },
      { fetch: a.fetch },
    ).publish([SAMPLE_PAGE]);
    const props = (a.propertiesPatchBody as PropsPayload).properties;
    expect(props?.Name?.title?.[0]?.text?.content).toBe("[DOCS] Foo Bar");
  });

  it("titlePrefix on claim branch: same prefixed title reaches the PATCH (regression guard against per-branch divergence)", async () => {
    // The existing "properties PATCH fires on both branches" case pins the
    // bare-CFG claim-branch title only. A regression that bypassed
    // propertiesFor on one branch would not be caught by that case if the
    // skipped branch happened to be the one without titlePrefix. Pinning
    // the claim branch WITH titlePrefix surfaces such a regression.
    const a = buildUpdateFetch("page-tp-cl", CLAIM_CHILDREN);
    await new NotionPublisher(
      { ...CFG, coexistence: { titlePrefix: "[DOCS]" } },
      { fetch: a.fetch },
    ).publish([SAMPLE_PAGE]);
    const props = (a.propertiesPatchBody as PropsPayload).properties;
    expect(props?.Name?.title?.[0]?.text?.content).toBe("[DOCS] Foo Bar");
  });

  it("titlePrefix is trimmed before prefixing: '  [DOCS]  ' becomes '[DOCS] Foo Bar'", async () => {
    // effectiveTitle calls .trim() on the prefix before concatenating.
    // A regression dropping .trim() would surface as "  [DOCS]    Foo Bar"
    // (leading whitespace + multi-space separator) in the customer's title.
    const a = buildUpdateFetch("page-tp-trim", GREENFIELD_CHILDREN);
    await new NotionPublisher(
      { ...CFG, coexistence: { titlePrefix: "  [DOCS]  " } },
      { fetch: a.fetch },
    ).publish([SAMPLE_PAGE]);
    const props = (a.propertiesPatchBody as PropsPayload).properties;
    expect(props?.Name?.title?.[0]?.text?.content).toBe("[DOCS] Foo Bar");
  });

  it("whitespace-only titlePrefix falls back to bare title (no leading whitespace)", async () => {
    // After .trim() returns "", the `prefix ? ... : ...` ternary takes the
    // unprefixed branch. A regression to unconditional concat would surface
    // as a leading-whitespace title in the customer's wiki.
    const a = buildUpdateFetch("page-tp-empty", GREENFIELD_CHILDREN);
    await new NotionPublisher(
      { ...CFG, coexistence: { titlePrefix: "   " } },
      { fetch: a.fetch },
    ).publish([SAMPLE_PAGE]);
    const props = (a.propertiesPatchBody as PropsPayload).properties;
    expect(props?.Name?.title?.[0]?.text?.content).toBe("Foo Bar");
  });

  it("parallel mode adds Section property (slugPrefix trailing slash stripped); non-parallel omits Section", async () => {
    // sectionForParallel returns null for non-parallel modes, so the
    // Section key is conditionally omitted from properties. In parallel
    // mode, the slug-prefix path is surfaced via Section.rich_text with
    // trailing slashes stripped. A regression that always emitted Section
    // (or that left the trailing slash in place) would surface here.
    const parallel = buildUpdateFetch("page-sec-parallel", GREENFIELD_CHILDREN);
    await new NotionPublisher(
      { ...CFG, coexistence: { mode: "parallel", slugPrefix: "auto/docs/" } },
      { fetch: parallel.fetch },
    ).publish([SAMPLE_PAGE]);
    const parallelProps = (parallel.propertiesPatchBody as PropsPayload).properties;
    expect(parallelProps?.Section?.rich_text?.[0]?.text?.content).toBe("auto/docs");

    const bare = buildUpdateFetch("page-sec-bare", GREENFIELD_CHILDREN);
    await new NotionPublisher(CFG, { fetch: bare.fetch }).publish([SAMPLE_PAGE]);
    const bareProps = (bare.propertiesPatchBody as PropsPayload).properties;
    // Assert defined first so a regression dropping the whole body doesn't
    // pass this case vacuously.
    expect(bareProps).toBeDefined();
    expect("Section" in (bareProps as object)).toBe(false);
  });
});

// Routes the /databases/<id>/query POST to one of two branches by inspecting
// the parsed filter body. Notion's findByCode2wikiId queries on the
// `code2wiki_id` rich-text property; findByTitle queries on the `Name`
// title property. Both hit the same URL, so URL-substring matching alone
// (the pattern in earlier tests) can't separate them.
function buildPreflightFetch(handlers: {
  onIdQuery?: (id: string) => unknown[];
  onTitleQuery?: (title: string) => unknown[];
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (
      method === "POST" &&
      url.endsWith(`/databases/${CFG.databaseId}/query`)
    ) {
      const body = init?.body ? (JSON.parse(init.body as string) as {
        filter?: { property?: string; rich_text?: { equals?: string }; title?: { equals?: string } };
      }) : {};
      const filter = body.filter ?? {};
      if (filter.property === "code2wiki_id") {
        const id = filter.rich_text?.equals ?? "";
        return new Response(
          JSON.stringify({ results: handlers.onIdQuery?.(id) ?? [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (filter.property === "Name") {
        const t = filter.title?.equals ?? "";
        return new Response(
          JSON.stringify({ results: handlers.onTitleQuery?.(t) ?? [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as unknown as typeof fetch;
}

describe("NotionPublisher.preflight", () => {
  it("classifies a page with no id match and no title match as clean", async () => {
    const fetch = buildPreflightFetch({});
    const pub = new NotionPublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.target).toBe("notion");
    expect(result.mode).toBe("greenfield");
    expect(result.entries[0]?.outcome).toBe("clean");
    expect(result.entries[0]?.existing).toBeUndefined();
    expect(result.summary).toEqual({
      clean: 1,
      managed: 0,
      collision: 0,
      renamed: 0,
    });
    // generated_at is an ISO-8601 timestamp; dashboard surfaces parse this.
    expect(result.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("classifies an id-matched page whose Name property matches as managed", async () => {
    const fetch = buildPreflightFetch({
      onIdQuery: () => [
        {
          id: "page-1",
          url: "https://notion.so/page-1",
          archived: false,
          properties: {
            Name: { title: [{ plain_text: SAMPLE_PAGE.title }] },
          },
        },
      ],
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("managed");
    expect(result.entries[0]?.existing?.external_id).toBe("page-1");
    expect(result.entries[0]?.existing?.match_reason).toBe("label");
    expect(result.entries[0]?.existing?.url).toBe("https://notion.so/page-1");
    expect(result.entries[0]?.existing?.title).toBe(SAMPLE_PAGE.title);
    expect(result.summary.managed).toBe(1);
  });

  it("classifies an id-matched page whose Name property is empty as managed (no drift signal)", async () => {
    // labeledTitle = "" → the `labeledTitle && ...` short-circuit makes drift
    // falsy → managed. A regression flipping this to renamed would force a
    // no-op publish on every page whose Notion title property has been
    // cleared via API (rare but observed when integrations strip properties).
    const fetch = buildPreflightFetch({
      onIdQuery: () => [
        {
          id: "page-empty-title",
          url: "https://notion.so/empty",
          archived: false,
          properties: { Name: { title: [] } },
        },
      ],
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("managed");
    // No title flows into existing.title in this case (undefined, not empty
    // string, the `|| undefined` short-circuit at notion.ts:475 enforces
    // that consumers can `.title ? render : ''` without nullish guards).
    expect(result.entries[0]?.existing?.title).toBeUndefined();
  });

  it("classifies an id-matched page whose Name drifted as renamed", async () => {
    const fetch = buildPreflightFetch({
      onIdQuery: () => [
        {
          id: "drift-1",
          url: "https://notion.so/drift-1",
          archived: false,
          properties: {
            Name: { title: [{ plain_text: "Stale Title (Renamed in UI)" }] },
          },
        },
      ],
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("renamed");
    expect(result.entries[0]?.existing?.title).toBe(
      "Stale Title (Renamed in UI)",
    );
    expect(result.summary.renamed).toBe(1);
  });

  it("treats managed-vs-renamed comparison as case-insensitive", async () => {
    // Notion titles are case-sensitive by default but a UI tweak to caps
    // shouldn't flip a "managed" page to "renamed" and force a no-op publish.
    // Mirror of the same invariant in confluence.test.ts.
    const fetch = buildPreflightFetch({
      onIdQuery: () => [
        {
          id: "case-1",
          url: "https://notion.so/case-1",
          archived: false,
          properties: {
            Name: { title: [{ plain_text: SAMPLE_PAGE.title.toUpperCase() }] },
          },
        },
      ],
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("managed");
  });

  it("classifies a title-only match (no code2wiki_id property) as collision with suggestClaim hint", async () => {
    const fetch = buildPreflightFetch({
      onTitleQuery: () => [
        {
          id: "col-1",
          url: "https://notion.so/col-1",
          archived: false,
          // No code2wiki_id property → findByTitle keeps this result.
        },
      ],
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("collision");
    expect(result.entries[0]?.existing?.external_id).toBe("col-1");
    expect(result.entries[0]?.existing?.match_reason).toBe("title_exact_ci");
    expect(result.entries[0]?.suggested_action).toContain("--target=notion");
    expect(result.entries[0]?.suggested_action).toContain(
      `--map-to=${SAMPLE_PAGE.code2wiki_id}`,
    );
    expect(result.entries[0]?.suggested_action).toContain("--page-id=col-1");
    expect(result.summary.collision).toBe(1);
  });

  it("filters title-search results that already carry a code2wiki_id and reports clean", async () => {
    // A page with code2wiki_id is already managed by someone else (or by us
    // under a different id); findByTitle MUST skip such results to avoid a
    // double-claim suggestion. Pin the in-publisher filter loop.
    const fetch = buildPreflightFetch({
      onTitleQuery: () => [
        {
          id: "other-managed-1",
          url: "https://notion.so/other",
          archived: false,
          properties: {
            code2wiki_id: { rich_text: [{ plain_text: "someone-else-id" }] },
          },
        },
      ],
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("clean");
    expect(result.summary.collision).toBe(0);
  });

  it("returns the first non-managed title-search result, skipping managed ones in-order", async () => {
    // Pins findByTitle's loop-and-return semantic when several results come
    // back: skip every page with a non-empty code2wiki_id, return the first
    // page WITHOUT one. A regression to .find(p => !p.code2wiki_id) would
    // pass this case, but a regression returning data.results[0] always
    // would surface the wrong page id.
    const fetch = buildPreflightFetch({
      onTitleQuery: () => [
        {
          id: "managed-a",
          url: "https://notion.so/a",
          archived: false,
          properties: {
            code2wiki_id: { rich_text: [{ plain_text: "id-a" }] },
          },
        },
        {
          id: "collidable-b",
          url: "https://notion.so/b",
          archived: false,
        },
      ],
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("collision");
    expect(result.entries[0]?.existing?.external_id).toBe("collidable-b");
  });

  it("propagates explicit coexistence.mode into the PreflightResult", async () => {
    const fetch = buildPreflightFetch({});
    const coexistence: CoexistenceConfig = { mode: "claim" };
    const pub = new NotionPublisher({ ...CFG, coexistence }, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.mode).toBe("claim");
  });

  it("applies titlePrefix to the entry title and to the title query, never to the id query", async () => {
    // titlePrefix flows into effectiveTitle (driving entry.title AND the
    // findByTitle search). The id query stays keyed on code2wiki_id; a
    // regression sending the prefixed title there would silently miss every
    // existing managed page the moment a customer enables titlePrefix
    // mid-stream. Pin both branches.
    let observedIdValue = "";
    let observedTitleValue = "";
    const fetch = buildPreflightFetch({
      onIdQuery: (id) => {
        observedIdValue = id;
        return [];
      },
      onTitleQuery: (t) => {
        observedTitleValue = t;
        return [];
      },
    });
    const pub = new NotionPublisher(
      { ...CFG, coexistence: { titlePrefix: "[c2w]" } },
      { fetch },
    );
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.title).toBe("[c2w] Foo Bar");
    expect(observedTitleValue).toBe("[c2w] Foo Bar");
    expect(observedIdValue).toBe(SAMPLE_PAGE.code2wiki_id);
  });

  it("aggregates summary correctly across a mixed batch (clean + managed + renamed + collision)", async () => {
    const inputs: PageInput[] = [
      { ...SAMPLE_PAGE, code2wiki_id: "p-clean", title: "Clean Page" },
      { ...SAMPLE_PAGE, code2wiki_id: "p-managed", title: "Managed Page" },
      { ...SAMPLE_PAGE, code2wiki_id: "p-renamed", title: "Renamed Page" },
      { ...SAMPLE_PAGE, code2wiki_id: "p-collision", title: "Collision Page" },
    ];
    const fetch = buildPreflightFetch({
      onIdQuery: (id) => {
        if (id === "p-managed") {
          return [
            {
              id: "m-1",
              url: "https://notion.so/m-1",
              archived: false,
              properties: {
                Name: { title: [{ plain_text: "Managed Page" }] },
              },
            },
          ];
        }
        if (id === "p-renamed") {
          return [
            {
              id: "r-1",
              url: "https://notion.so/r-1",
              archived: false,
              properties: {
                Name: { title: [{ plain_text: "Drifted Title" }] },
              },
            },
          ];
        }
        return [];
      },
      onTitleQuery: (t) => {
        if (t === "Collision Page") {
          return [
            {
              id: "c-1",
              url: "https://notion.so/c-1",
              archived: false,
            },
          ];
        }
        return [];
      },
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const result = await pub.preflight(inputs);
    expect(result.summary).toEqual({
      clean: 1,
      managed: 1,
      collision: 1,
      renamed: 1,
    });
    expect(
      result.entries.find((e) => e.code2wiki_id === "p-clean")?.outcome,
    ).toBe("clean");
    expect(
      result.entries.find((e) => e.code2wiki_id === "p-managed")?.outcome,
    ).toBe("managed");
    expect(
      result.entries.find((e) => e.code2wiki_id === "p-renamed")?.outcome,
    ).toBe("renamed");
    expect(
      result.entries.find((e) => e.code2wiki_id === "p-collision")?.outcome,
    ).toBe("collision");
  });

  it("checks the id query BEFORE the title query (label match short-circuits the title search)", async () => {
    // findByCode2wikiId returning a labeled page should skip findByTitle
    // entirely. A regression doing both lookups in parallel, or
    // unconditionally running findByTitle, would surface a spurious
    // "collision" alongside the legitimate "managed" classification, and
    // could double-count the same page in summary if the regression also
    // pushed both into entries.
    let titleQueryCount = 0;
    const fetch = buildPreflightFetch({
      onIdQuery: () => [
        {
          id: "labeled-x",
          url: "https://notion.so/labeled-x",
          archived: false,
          properties: { Name: { title: [{ plain_text: SAMPLE_PAGE.title }] } },
        },
      ],
      onTitleQuery: (t) => {
        titleQueryCount++;
        if (t === SAMPLE_PAGE.title) {
          return [{ id: "other", url: "x", archived: false }];
        }
        return [];
      },
    });
    const pub = new NotionPublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("managed");
    expect(titleQueryCount).toBe(0);
  });
});

describe("NotionPublisher - stripReadonlyBlock via claim", () => {
  it("unsupported and child_database blocks become paragraph stubs in appended children", async () => {
    let appendedChildren: Array<{ type: string; paragraph?: { rich_text?: Array<{ text: { content: string } }> } }> = [];

    const fetch = buildBodyCaptureFetch((url, method, body) => {
      if (method === "GET" && url.endsWith("/pages/strip-pg")) {
        return { status: 200, body: { id: "strip-pg", url: "https://notion.so/s", archived: false, properties: { code2wiki_id: { rich_text: [] } } } };
      }
      if (method === "GET" && url.includes("/blocks/strip-pg/children")) {
        return { status: 200, body: { results: [
          { id: "b1", type: "unsupported" },
          { id: "b2", type: "child_database", child_database: {} },
        ] } };
      }
      if (method === "DELETE") return { status: 200, body: {} };
      if (method === "PATCH" && url.includes("/blocks/strip-pg/children")) {
        appendedChildren = (body as { children: typeof appendedChildren }).children;
        return { status: 200, body: { results: [] } };
      }
      if (method === "PATCH") return { status: 200, body: {} };
      return { status: 404, body: {} };
    });

    const pub = new NotionPublisher(CFG, { fetch });
    await pub.claim({ pageId: "strip-pg", code2wiki_id: "x", placement: "below", title: "X", repoName: "acme" });

    // placement=below: [banner, divider, ...replays]; replays[0/1] are the stubs
    const stub0 = appendedChildren[2];
    const stub1 = appendedChildren[3];
    expect(stub0?.type).toBe("paragraph");
    expect(stub0?.paragraph?.rich_text?.[0]?.text?.content).toContain("unsupported");
    expect(stub1?.type).toBe("paragraph");
    expect(stub1?.paragraph?.rich_text?.[0]?.text?.content).toContain("child_database");
  });
});

// findByCode2wikiId is the upsert-key lookup at the head of every publish:
// publish() calls it first, and the create-vs-update branch hinges on whether
// it returns a row. The query body is the schema contract with the customer's
// Notion database, `property: "code2wiki_id"` must match the rich-text
// property name they were instructed to create at onboarding, and the
// `rich_text.equals` filter must carry the page's stable id (NOT slug, NOT
// title, those drift). A regression to `contains` would silently match
// neighboring ids; a regression to filtering on Name would fork a new page on
// every title edit. The existing publish() tests assert outcome + URL substring
// but never inspect the POST body or headers, so a body-shape regression would
// reach prod undetected. Six cases pin the URL+method, filter shape, page_size,
// auth+version headers, and error message contract.
describe("NotionPublisher.findByCode2wikiId query body", () => {
  type CapturedIdQuery = {
    url: string;
    method: string;
    body: {
      filter?: { property?: string; rich_text?: { equals?: string } };
      page_size?: number;
    };
    headers: Record<string, string>;
  };
  const captureIdQuery = () => {
    let captured: CapturedIdQuery | null = null;
    const fn = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (
        method === "POST" &&
        url.endsWith(`/databases/${CFG.databaseId}/query`)
      ) {
        const body = init?.body
          ? (JSON.parse(init.body as string) as CapturedIdQuery["body"])
          : {};
        if (body.filter?.property === "code2wiki_id") {
          captured = {
            url,
            method,
            body,
            headers: (init?.headers ?? {}) as Record<string, string>,
          };
        }
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetch: fn, get: () => captured };
  };

  it("POSTs to /databases/<configured-db-id>/query (the query endpoint, not /pages or /search)", async () => {
    // The Notion API surfaces three endpoints that can return pages: the
    // database-query (used here), /v1/search, and per-page GET. A regression
    // to /search would silently widen the lookup beyond the configured
    // database, and would not filter on the `code2wiki_id` rich-text
    // property at all. Pin the exact path + method so a refactor surfaces.
    const { fetch, get } = captureIdQuery();
    await new NotionPublisher(CFG, { fetch }).publish([SAMPLE_PAGE]);
    const c = get()!;
    expect(c).not.toBeNull();
    expect(c.url).toBe(`https://api.notion.com/v1/databases/${CFG.databaseId}/query`);
    expect(c.method).toBe("POST");
  });

  it("filter.property is exactly 'code2wiki_id' (the schema-contracted property name)", async () => {
    // The Notion DB schema instructs onboarding customers to create a
    // Rich Text property literally named "code2wiki_id". A refactor that
    // renamed it (to "id" / "code2wiki-id" / "Code2wiki_id") would compile
    // and pass every other test in this file, but every customer's existing
    // managed pages would suddenly be invisible to findByCode2wikiId and the
    // next publish would fork duplicate pages alongside them. Pin the
    // literal property name to make that drift surface here.
    const { fetch, get } = captureIdQuery();
    await new NotionPublisher(CFG, { fetch }).publish([SAMPLE_PAGE]);
    expect(get()!.body.filter?.property).toBe("code2wiki_id");
  });

  it("filter.rich_text.equals carries page.code2wiki_id verbatim (NOT slug, NOT title)", async () => {
    // code2wiki_id is the stable upsert key per CLAUDE.md "Key conventions";
    // slug and title can drift across renames. A regression that filtered on
    // slug would break upsert on the first slug rename; filtering on title
    // would break it on any user-visible title edit. Make the three strings
    // pairwise-distinct so any confusion surfaces directly.
    const distinct: PageInput = {
      ...SAMPLE_PAGE,
      code2wiki_id: "java-distinct-id-v1",
      slug: "distinct-slug",
      title: "Distinct Title",
    };
    const { fetch, get } = captureIdQuery();
    await new NotionPublisher(CFG, { fetch }).publish([distinct]);
    const filter = get()!.body.filter;
    expect(filter?.rich_text?.equals).toBe("java-distinct-id-v1");
    expect(filter?.rich_text?.equals).not.toBe("distinct-slug");
    expect(filter?.rich_text?.equals).not.toBe("Distinct Title");
  });

  it("body.page_size is 1 (we trust uniqueness; defense vs cost spike on large dbs)", async () => {
    // code2wiki_id is unique by construction (`findByCode2wikiId` reads
    // `results[0] ?? null`), so a page_size higher than 1 only inflates API
    // cost without changing correctness. A regression that dropped page_size
    // entirely would default Notion to 100 rows per query, a 100x cost
    // multiplier on a customer with thousands of managed pages.
    const { fetch, get } = captureIdQuery();
    await new NotionPublisher(CFG, { fetch }).publish([SAMPLE_PAGE]);
    expect(get()!.body.page_size).toBe(1);
  });

  it("sends Authorization: Bearer <apiToken>, Content-Type: application/json, and Notion-Version (default + cfg.apiVersion override)", async () => {
    // Auth header is load-bearing; a regression dropping it would 401 every
    // request and surface as the "Notion query failed" throw path. The
    // Notion-Version header pins the contract version of the response shape
    // (`results[]`, `properties` structure); a customer pinning a specific
    // version via cfg.apiVersion must reach the wire. Content-Type guards
    // against a slip to text/plain that would make Notion reject the body.
    const dflt = captureIdQuery();
    await new NotionPublisher(CFG, { fetch: dflt.fetch }).publish([SAMPLE_PAGE]);
    const h = dflt.get()!.headers;
    expect(h.Authorization).toBe(`Bearer ${CFG.apiToken}`);
    expect(h["Notion-Version"]).toBe("2022-06-28");
    expect(h["Content-Type"]).toBe("application/json");

    const pinned = captureIdQuery();
    await new NotionPublisher(
      { ...CFG, apiVersion: "2099-01-01" },
      { fetch: pinned.fetch },
    ).publish([SAMPLE_PAGE]);
    expect(pinned.get()!.headers["Notion-Version"]).toBe("2099-01-01");
  });

  it("throws 'Notion query failed: <status> <body>' on non-OK response", async () => {
    // Pin the exact error message shape. The CLI prints publisher errors to
    // stderr verbatim and the dashboard's run-error surface keys off the
    // prefix; a refactor that dropped the status code or body payload would
    // silently degrade operator forensics on transient Notion 5xx blips.
    const fn = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/databases/${CFG.databaseId}/query`)) {
        return new Response("upstream timeout", { status: 503 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const [result] = await new NotionPublisher(CFG, { fetch: fn }).publish([
      SAMPLE_PAGE,
    ]);
    expect(result?.outcome).toBe("skipped");
    expect(result?.message).toContain("Notion query failed: 503");
    expect(result?.message).toContain("upstream timeout");
  });
});

// Sister to the ConfluencePublisher: 429 retry wiring block in
// confluence.test.ts. NotionPublisher has its own constructor (notion.ts:472)
// that independently calls withRetry(opts.fetch ?? fetch, opts.retry); the
// regression surface is separate from Confluence's, so the pin lives here too.
describe("NotionPublisher: 429 retry wiring", () => {
  it("retries 429 on database query via withRetry, then succeeds (pins constructor wrap + sleep forwarding)", async () => {
    // Sequence: query 429 -> query 200 (empty results) -> POST 200 (created).
    // Without the constructor wrap, the first 429 throws via the "Notion
    // query failed" path and the publish outcome flips to "skipped".
    let queryCalls = 0;
    const sleepDelays: number[] = [];
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (method === "POST" && url.endsWith(`/databases/${CFG.databaseId}/query`)) {
        queryCalls++;
        if (queryCalls === 1) return { status: 429, body: {} };
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/pages")) {
        return {
          status: 200,
          body: {
            id: "new-retry-1",
            url: "https://notion.so/new-retry-1",
            archived: false,
          },
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new NotionPublisher(CFG, {
      fetch,
      retry: {
        jitter: () => 0,
        baseDelayMs: 0,
        sleep: async (ms) => {
          sleepDelays.push(ms);
        },
      },
    });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("created");
    expect(result?.externalId).toBe("new-retry-1");
    // Two query calls (first 429, second 200) prove the wrap routed back to
    // the injected fetch on retry.
    expect(queryCalls).toBe(2);
    // Exactly one sleep between attempts; tracker proves opts.retry.sleep
    // reached the wrapper. Default setTimeout-based sleep would leave it empty.
    expect(sleepDelays).toEqual([0]);
    // Create endpoint hit exactly once (no double-create from stray retry
    // leaking past the query endpoint into the mutation endpoint).
    const creates = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/pages"),
    );
    expect(creates).toHaveLength(1);
  });

  it("opts.retry.maxAttempts=1 is forwarded: a sustained 429 hard-fails without retry (pins maxAttempts forwarding)", async () => {
    let queryCalls = 0;
    const sleepDelays: number[] = [];
    const { fetch } = mockFetch(({ url, method }) => {
      if (method === "POST" && url.endsWith(`/databases/${CFG.databaseId}/query`)) {
        queryCalls++;
        return { status: 429, body: { message: "rate limited" } };
      }
      return { status: 500, body: {} };
    });
    const pub = new NotionPublisher(CFG, {
      fetch,
      retry: {
        maxAttempts: 1,
        sleep: async (ms) => {
          sleepDelays.push(ms);
        },
      },
    });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("skipped");
    expect(queryCalls).toBe(1);
    expect(sleepDelays).toEqual([]);
    expect(result?.message).toContain("Notion query failed: 429");
  });
});
