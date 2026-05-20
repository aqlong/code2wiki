import { describe, it, expect } from "vitest";
import { ConfluencePublisher } from "./confluence.js";
import { NotionPublisher } from "./notion.js";
import type { PageInput } from "./types.js";

const PAGE: PageInput = {
  code2wiki_id: "java-foo-bar-v1",
  title: "Foo Bar Use Case",
  slug: "foo-bar",
  markdown: "## Summary\n\nA quick test.\n",
  tags: ["foo"],
};

const CFG_C = {
  baseUrl: "https://example.atlassian.net/wiki",
  email: "tester@example.com",
  apiToken: "test-token",
  spaceKey: "DOCS",
};

const CFG_N = {
  apiToken: "secret",
  databaseId: "db-1",
};

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function record(handler: (req: { url: string; method: string; body: unknown }) => { status: number; body: unknown }) {
  const calls: RecordedCall[] = [];
  const fn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const { status, body: respBody } = handler({ url, method, body });
    return new Response(JSON.stringify(respBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

// ---- Confluence: parallel mode + parent page ----

describe("Confluence parallel mode (PR-1, PR-2, PR-3, PR-4)", () => {
  it("PR-1: creates a 'code2wiki' parent when one doesn't exist", async () => {
    let parentCreated = false;
    let pageCreatedAncestors: unknown;
    const { fetch, calls } = record(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) {
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        const b = body as { title: string; ancestors?: Array<{ id: string }> };
        if (b.title === "code2wiki") {
          parentCreated = true;
          return {
            status: 200,
            body: { id: "parent-1", type: "page", title: "code2wiki", version: { number: 1 } },
          };
        }
        pageCreatedAncestors = b.ancestors;
        return {
          status: 200,
          body: { id: "child-1", type: "page", title: b.title, version: { number: 1 } },
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(
      { ...CFG_C, coexistence: { mode: "parallel", banner: { repoName: "acme", now: () => "2026-05-07T00:00:00.000Z" } } },
      { fetch },
    );
    const [r] = await pub.publish([PAGE]);
    expect(r?.outcome).toBe("created");
    expect(parentCreated).toBe(true);
    expect(pageCreatedAncestors).toEqual([{ id: "parent-1" }]);
    // Final create call should reference the parent page id.
    expect(calls.some((c) => c.url.includes("/rest/api/content") && c.method === "POST")).toBe(true);
  });

  it("PR-2: reuses an existing parent (no duplicate)", async () => {
    let parentCreates = 0;
    const { fetch } = record(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) {
        const cql = new URL(url).searchParams.get("cql") ?? "";
        if (cql.includes('title="code2wiki"')) {
          return {
            status: 200,
            body: {
              results: [
                {
                  id: "parent-existing",
                  title: "code2wiki",
                  version: { number: 1 },
                  metadata: { labels: { results: [] } },
                },
              ],
            },
          };
        }
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        const b = body as { title: string };
        if (b.title === "code2wiki") parentCreates++;
        return {
          status: 200,
          body: { id: "child", type: "page", title: b.title, version: { number: 1 } },
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(
      { ...CFG_C, coexistence: { mode: "parallel" } },
      { fetch },
    );
    await pub.publish([PAGE]);
    expect(parentCreates).toBe(0);
  });

  it("PR-3: custom slugPrefix sets the parent title to the first segment", async () => {
    let parentTitle: string | undefined;
    const { fetch } = record(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) return { status: 200, body: { results: [] } };
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        const b = body as { title: string };
        if (b.title.startsWith("[") || b.title === PAGE.title) {
          return { status: 200, body: { id: "child", title: b.title, version: { number: 1 } } };
        }
        parentTitle = b.title;
        return { status: 200, body: { id: "p", title: b.title, version: { number: 1 } } };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(
      { ...CFG_C, coexistence: { mode: "parallel", slugPrefix: "auto-docs/" } },
      { fetch },
    );
    await pub.publish([PAGE]);
    expect(parentTitle).toBe("auto-docs");
  });
});

// ---- Confluence: banner ----

describe("Confluence banner injection (BN-1, BN-3, BN-9)", () => {
  it("BN-1: created page's storage starts with the info macro", async () => {
    let createdStorage: string | undefined;
    const { fetch } = record(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) return { status: 200, body: { results: [] } };
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        const b = body as { body?: { storage?: { value?: string } } };
        createdStorage = b.body?.storage?.value;
        return { status: 200, body: { id: "1", title: "x", version: { number: 1 } } };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(
      { ...CFG_C, coexistence: { mode: "greenfield", banner: { repoName: "acme", now: () => "2026-05-07T00:00:00.000Z" } } },
      { fetch },
    );
    await pub.publish([PAGE]);
    expect(createdStorage).toMatch(/^<ac:structured-macro ac:name="info"/);
    expect(createdStorage).toContain("📝");
  });

  it("BN-3: banner is rewritten on update (timestamp changes)", async () => {
    let putStorage: string | undefined;
    const { fetch } = record(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) {
        return {
          status: 200,
          body: {
            results: [
              {
                id: "ex-1",
                title: PAGE.title,
                version: { number: 1 },
                body: { storage: { value: "<ac:structured-macro ac:name=\"info\"><p>old</p></ac:structured-macro><!-- code2wiki:managed:start id=foo -->\n<p>old gen</p>\n<!-- code2wiki:managed:end -->" } },
              },
            ],
          },
        };
      }
      if (method === "PUT" && url.includes("/rest/api/content/ex-1")) {
        const b = body as { body?: { storage?: { value?: string } } };
        putStorage = b.body?.storage?.value;
        return { status: 200, body: { id: "ex-1", title: PAGE.title, version: { number: 2 } } };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(
      { ...CFG_C, coexistence: { mode: "greenfield", banner: { repoName: "acme", now: () => "2026-05-07T01:01:01.000Z" } } },
      { fetch },
    );
    await pub.publish([PAGE]);
    expect(putStorage).toMatch(/Last synced: 2026-05-07T01:01:01.000Z/);
    expect(putStorage).not.toContain("old gen");
  });
});

// ---- Confluence claim ----

describe("Confluence claim flow (CL-1, CL-5, CL-7, CL-8, CL-13)", () => {
  it("CL-1 + CL-5: claim by URL, default placement=below, banner+fence+separator+original", async () => {
    let putStorage: string | undefined;
    let labelsAdded: string[] = [];
    const { fetch } = record(({ url, method, body }) => {
      if (method === "GET" && url.includes("/rest/api/content/12345")) {
        return {
          status: 200,
          body: {
            id: "12345",
            title: "Hand Written",
            version: { number: 7 },
            body: { storage: { value: "<p>Original prose lives here</p>" } },
            metadata: { labels: { results: [] } },
            space: { key: "DOCS" },
          },
        };
      }
      if (method === "PUT" && url.includes("/rest/api/content/12345")) {
        const b = body as { body?: { storage?: { value?: string } } };
        putStorage = b.body?.storage?.value;
        return { status: 200, body: { id: "12345", title: "Hand Written", version: { number: 8 } } };
      }
      if (method === "POST" && url.includes("/rest/api/content/12345/label")) {
        const arr = body as Array<{ name: string }>;
        labelsAdded.push(...arr.map((l) => l.name));
        return { status: 200, body: { results: arr } };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG_C, { fetch });
    const result = await pub.claim({
      pageId: "12345",
      code2wiki_id: "publishing-a-site",
      placement: "below",
      title: "Publishing a Site",
      repoName: "acme",
      commit: "abc1234",
      now: () => "2026-05-07T00:00:00.000Z",
    });
    expect(result.external_id).toBe("12345");
    expect(result.pre_claim_content_hash).toMatch(/^sha256:/);
    expect(putStorage).toMatch(/^<ac:structured-macro/); // banner first
    expect(putStorage).toContain("<!-- code2wiki:managed:start id=publishing-a-site -->");
    expect(putStorage).toContain("Original content (preserved)");
    // Default placement=below: original goes after the managed region.
    const fenceCloseIdx = putStorage!.indexOf("<!-- code2wiki:managed:end -->");
    const originalIdx = putStorage!.indexOf("Original prose lives here");
    expect(originalIdx).toBeGreaterThan(fenceCloseIdx);
    expect(labelsAdded).toContain("c2w-publishing-a-site");
    expect(labelsAdded).toContain("code2wiki");
  });

  it("CL-4: --placement=above puts original before the fence", async () => {
    let putStorage: string | undefined;
    const { fetch } = record(({ url, method, body }) => {
      if (method === "GET" && url.includes("/rest/api/content/777")) {
        return {
          status: 200,
          body: {
            id: "777",
            title: "X",
            version: { number: 1 },
            body: { storage: { value: "<p>ORIGINAL</p>" } },
            metadata: { labels: { results: [] } },
            space: { key: "DOCS" },
          },
        };
      }
      if (method === "PUT") {
        const b = body as { body?: { storage?: { value?: string } } };
        putStorage = b.body?.storage?.value;
        return { status: 200, body: { id: "777", title: "X", version: { number: 2 } } };
      }
      if (method === "POST" && url.includes("/label")) return { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG_C, { fetch });
    await pub.claim({
      pageId: "777",
      code2wiki_id: "x",
      placement: "above",
      title: "X",
      repoName: "acme",
      commit: "abc",
    });
    const originalIdx = putStorage!.indexOf("<p>ORIGINAL</p>");
    const fenceIdx = putStorage!.indexOf("<!-- code2wiki:managed:start");
    expect(originalIdx).toBeGreaterThan(0);
    expect(fenceIdx).toBeGreaterThan(originalIdx);
  });

  it("CL-7: refuses a page already labeled c2w-*", async () => {
    const { fetch } = record(({ url, method }) => {
      if (method === "GET") {
        return {
          status: 200,
          body: {
            id: "1",
            title: "X",
            version: { number: 1 },
            body: { storage: { value: "" } },
            metadata: { labels: { results: [{ name: "c2w-something-else" }] } },
            space: { key: "DOCS" },
          },
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG_C, { fetch });
    await expect(
      pub.claim({
        pageId: "1",
        code2wiki_id: "x",
        placement: "below",
        title: "X",
        repoName: "acme",
      }),
    ).rejects.toThrow(/already managed/);
  });

  it("CL-13: rollback restores the original body when label-write fails", async () => {
    const puts: Array<{ value?: string; version?: number }> = [];
    let labelAttempts = 0;
    const { fetch } = record(({ url, method, body }) => {
      if (method === "GET" && url.includes("/rest/api/content/999")) {
        return {
          status: 200,
          body: {
            id: "999",
            title: "X",
            version: { number: 3 },
            body: { storage: { value: "<p>ORIGINAL UNTOUCHED</p>" } },
            metadata: { labels: { results: [] } },
            space: { key: "DOCS" },
          },
        };
      }
      if (method === "PUT" && url.includes("/rest/api/content/999")) {
        const b = body as {
          body?: { storage?: { value?: string } };
          version?: { number: number };
        };
        puts.push({
          value: b.body?.storage?.value,
          version: b.version?.number,
        });
        return { status: 200, body: { id: "999", title: "X", version: { number: b.version?.number ?? 4 } } };
      }
      if (method === "POST" && url.includes("/rest/api/content/999/label")) {
        labelAttempts++;
        return { status: 500, body: { message: "label write failed" } };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG_C, { fetch });
    await expect(
      pub.claim({
        pageId: "999",
        code2wiki_id: "x",
        placement: "below",
        title: "X",
        repoName: "acme",
      }),
    ).rejects.toThrow(/rolled back/);
    // Two PUTs: one for the body rewrite, one for the rollback.
    expect(puts.length).toBe(2);
    expect(puts[0]?.value).toContain("<!-- code2wiki:managed:start");
    expect(puts[1]?.value).toBe("<p>ORIGINAL UNTOUCHED</p>");
    expect(labelAttempts).toBeGreaterThanOrEqual(1);
  });

  it("CL-8: refuses a page in the wrong space", async () => {
    const { fetch } = record(() => ({
      status: 200,
      body: {
        id: "1",
        title: "X",
        version: { number: 1 },
        body: { storage: { value: "" } },
        metadata: { labels: { results: [] } },
        space: { key: "OTHER" },
      },
    }));
    const pub = new ConfluencePublisher(CFG_C, { fetch });
    await expect(
      pub.claim({
        pageId: "1",
        code2wiki_id: "x",
        placement: "below",
        title: "X",
        repoName: "acme",
      }),
    ).rejects.toThrow(/configured space/);
  });
});

// ---- Confluence: claim → publish round-trip preserves original ----

describe("Confluence post-claim publish (CL-11, CL-12)", () => {
  it("CL-11: first publish on a claimed page populates the managed region but keeps original", async () => {
    let putStorage: string | undefined;
    const { fetch } = record(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) {
        return {
          status: 200,
          body: {
            results: [
              {
                id: "claimed",
                title: PAGE.title,
                version: { number: 5 },
                body: {
                  storage: {
                    value:
                      "<ac:structured-macro ac:name=\"info\"><p>OLD BANNER</p></ac:structured-macro>\n<!-- code2wiki:managed:start id=foo -->\n<!-- code2wiki:managed:end -->\n<hr/>\n<h2>Original content (preserved)</h2>\n<p>ORIGINAL TEXT</p>",
                  },
                },
                metadata: { labels: { results: [{ name: "c2w-foo" }] } },
              },
            ],
          },
        };
      }
      if (method === "PUT" && url.includes("/rest/api/content/claimed")) {
        const b = body as { body?: { storage?: { value?: string } } };
        putStorage = b.body?.storage?.value;
        return { status: 200, body: { id: "claimed", title: PAGE.title, version: { number: 6 } } };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(
      { ...CFG_C, coexistence: { mode: "claim", banner: { repoName: "acme", now: () => "2026-05-07T00:00:00.000Z" } } },
      { fetch },
    );
    await pub.publish([PAGE]);
    expect(putStorage).toContain("ORIGINAL TEXT"); // preserved
    expect(putStorage).not.toContain("OLD BANNER"); // banner replaced
    expect(putStorage).toContain("Last synced: 2026-05-07T00:00:00.000Z");
  });
});

// ---- Notion: parallel mode + banner + claim ----

describe("Notion parallel mode (PR-5)", () => {
  it("sets Section property to the slug prefix", async () => {
    let createBody: { properties?: Record<string, unknown> } | undefined;
    const { fetch } = record(({ url, method, body }) => {
      if (method === "POST" && url.endsWith(`/databases/${CFG_N.databaseId}/query`)) {
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/pages")) {
        createBody = body as { properties?: Record<string, unknown> };
        return { status: 200, body: { id: "1", url: "https://notion.so/1", archived: false } };
      }
      return { status: 404, body: {} };
    });
    const pub = new NotionPublisher(
      { ...CFG_N, coexistence: { mode: "parallel" } },
      { fetch },
    );
    await pub.publish([PAGE]);
    const props = createBody?.properties as Record<string, unknown>;
    expect(props["Section"]).toBeDefined();
    expect(JSON.stringify(props["Section"])).toContain("code2wiki");
  });
});

describe("Notion banner injection (BN-2)", () => {
  it("first child block is a 📝 callout", async () => {
    let firstChild: { type?: string; callout?: { icon?: { emoji?: string } } } | undefined;
    const { fetch } = record(({ url, method, body }) => {
      if (method === "POST" && url.endsWith(`/databases/${CFG_N.databaseId}/query`)) {
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/pages")) {
        const b = body as { children?: Array<{ type: string }> };
        firstChild = b.children?.[0] as typeof firstChild;
        return { status: 200, body: { id: "1", url: "https://notion.so/1", archived: false } };
      }
      return { status: 404, body: {} };
    });
    const pub = new NotionPublisher(
      { ...CFG_N, coexistence: { mode: "greenfield", banner: { repoName: "acme" } } },
      { fetch },
    );
    await pub.publish([PAGE]);
    expect(firstChild?.type).toBe("callout");
    expect(firstChild?.callout?.icon?.emoji).toBe("📝");
  });
});

describe("Notion claim flow (CL-3, CL-7-Notion)", () => {
  it("CL-3: archives existing children, appends [banner, ...originals, divider] (placement=below)", async () => {
    let archivedIds: string[] = [];
    let appendedChildren: Array<{ type: string }> = [];
    let propsSet: Record<string, unknown> | undefined;
    const { fetch } = record(({ url, method, body }) => {
      if (method === "GET" && url.endsWith("/pages/abcdefab-cdef-abcd-efab-cdefabcdefab")) {
        return {
          status: 200,
          body: {
            id: "abcdefab-cdef-abcd-efab-cdefabcdefab",
            url: "https://notion.so/x",
            archived: false,
            properties: { code2wiki_id: { rich_text: [] } },
          },
        };
      }
      if (method === "GET" && url.includes("/blocks/abcdefab-cdef-abcd-efab-cdefabcdefab/children")) {
        return {
          status: 200,
          body: {
            results: [
              { id: "block-1", type: "paragraph", paragraph: { rich_text: [{ text: { content: "ORIG_A" } }] } },
              { id: "block-2", type: "heading_2", heading_2: { rich_text: [{ text: { content: "ORIG_B" } }] } },
            ],
          },
        };
      }
      if (method === "DELETE" && url.includes("/blocks/")) {
        archivedIds.push(url.split("/blocks/")[1]!);
        return { status: 200, body: {} };
      }
      if (method === "PATCH" && url.includes("/blocks/abcdefab-cdef-abcd-efab-cdefabcdefab/children")) {
        const b = body as { children: Array<{ type: string }> };
        appendedChildren = b.children;
        return { status: 200, body: { results: [] } };
      }
      if (method === "PATCH" && url.endsWith("/pages/abcdefab-cdef-abcd-efab-cdefabcdefab")) {
        propsSet = (body as { properties: Record<string, unknown> }).properties;
        return { status: 200, body: {} };
      }
      return { status: 404, body: {} };
    });
    const pub = new NotionPublisher(CFG_N, { fetch });
    const result = await pub.claim({
      pageId: "abcdefab-cdef-abcd-efab-cdefabcdefab",
      code2wiki_id: "publishing-a-site",
      placement: "below",
      title: "Publishing a Site",
      repoName: "acme",
    });
    expect(result.pre_claim_content_hash).toMatch(/^sha256:/);
    expect(archivedIds.length).toBe(2);
    // [banner, divider, ...originals]
    expect(appendedChildren[0]?.type).toBe("callout");
    expect(appendedChildren[1]?.type).toBe("divider");
    expect(appendedChildren.slice(2).map((b) => b.type)).toEqual([
      "paragraph",
      "heading_2",
    ]);
    expect((propsSet?.["code2wiki_id"] as { rich_text?: Array<{ text: { content: string } }> })?.rich_text?.[0]?.text.content).toBe("publishing-a-site");
  });

  it("CL-7-Notion: refuses a page already managed", async () => {
    const { fetch } = record(({ method }) => {
      if (method === "GET") {
        return {
          status: 200,
          body: {
            id: "x",
            url: "https://notion.so/x",
            archived: false,
            properties: {
              code2wiki_id: { rich_text: [{ plain_text: "existing" }] },
            },
          },
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new NotionPublisher(CFG_N, { fetch });
    await expect(
      pub.claim({
        pageId: "abcdefab-cdef-abcd-efab-cdefabcdefab",
        code2wiki_id: "new",
        placement: "below",
        title: "X",
        repoName: "acme",
      }),
    ).rejects.toThrow(/already managed/);
  });
});

// ---- titlePrefix ----

describe("Title prefix (PR-7, PR-8)", () => {
  it("PR-7: titlePrefix is applied when set", async () => {
    let createdTitle: string | undefined;
    const { fetch } = record(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) return { status: 200, body: { results: [] } };
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        const b = body as { title: string };
        if (b.title.includes("Foo")) createdTitle = b.title;
        return { status: 200, body: { id: "1", title: b.title, version: { number: 1 } } };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(
      { ...CFG_C, coexistence: { mode: "greenfield", titlePrefix: "[code2wiki]" } },
      { fetch },
    );
    await pub.publish([PAGE]);
    expect(createdTitle).toBe("[code2wiki] Foo Bar Use Case");
  });

  it("PR-8: no title prefix by default", async () => {
    let createdTitle: string | undefined;
    const { fetch } = record(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) return { status: 200, body: { results: [] } };
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        const b = body as { title: string };
        createdTitle = b.title;
        return { status: 200, body: { id: "1", title: b.title, version: { number: 1 } } };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG_C, { fetch });
    await pub.publish([PAGE]);
    expect(createdTitle).toBe("Foo Bar Use Case");
  });
});
