import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfluencePublisher } from "./confluence.js";
import { NotionPublisher } from "./notion.js";
import { writePreflight, preflightPath } from "./preflight.js";
import type { PageInput } from "./types.js";

const PAGE_A: PageInput = {
  code2wiki_id: "publishing-a-site",
  title: "Publishing a Site",
  slug: "publishing-a-site",
  markdown: "## Summary\n\nA quick test.\n",
  tags: [],
};

const PAGE_B: PageInput = {
  code2wiki_id: "managing-users",
  title: "Managing Users",
  slug: "managing-users",
  markdown: "## Summary\n\nB.\n",
  tags: [],
};

const PAGE_C: PageInput = {
  code2wiki_id: "deleting-content",
  title: "Deleting Content",
  slug: "deleting-content",
  markdown: "## Summary\n\nC.\n",
  tags: [],
};

const CFG_CONFLUENCE = {
  baseUrl: "https://example.atlassian.net/wiki",
  email: "tester@example.com",
  apiToken: "test-token",
  spaceKey: "DOCS",
};

const CFG_NOTION = {
  apiToken: "secret",
  databaseId: "db-1",
};

interface FakeConfluencePage {
  id: string;
  title: string;
  labels?: string[];
}

function confluenceFetch(pages: FakeConfluencePage[]) {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/rest/api/content/search")) {
      // URLSearchParams encodes spaces as `+`; new URL().searchParams.get
      // decodes them back, which raw decodeURIComponent does NOT.
      const cql = new URL(url).searchParams.get("cql") ?? "";
      let matched: FakeConfluencePage[] = [];
      const labelMatch = cql.match(/label="([^"]+)"/);
      const titleMatch = cql.match(/title="([^"]+)"/);
      if (labelMatch?.[1]) {
        const lbl = labelMatch[1];
        matched = pages.filter((p) => (p.labels ?? []).includes(lbl));
      } else if (titleMatch?.[1]) {
        const t = titleMatch[1].toLowerCase();
        matched = pages.filter((p) => p.title.toLowerCase() === t);
      }
      return new Response(
        JSON.stringify({
          results: matched.map((p) => ({
            id: p.id,
            type: "page",
            title: p.title,
            version: { number: 1 },
            metadata: {
              labels: { results: (p.labels ?? []).map((name) => ({ name })) },
            },
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as unknown as typeof fetch;
}

interface FakeNotionPage {
  id: string;
  title: string;
  code2wiki_id?: string;
}

function notionFetch(pages: FakeNotionPage[]) {
  return (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith(`/databases/${CFG_NOTION.databaseId}/query`)) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const filter = body.filter ?? {};
      let matches: FakeNotionPage[] = [];
      if (filter.property === "code2wiki_id") {
        const target = filter.rich_text?.equals;
        matches = pages.filter((p) => p.code2wiki_id === target);
      } else if (filter.property === "Name") {
        const target = filter.title?.equals;
        matches = pages.filter((p) => p.title === target);
      }
      return new Response(
        JSON.stringify({
          results: matches.map((p) => ({
            id: p.id,
            url: `https://notion.so/${p.id}`,
            archived: false,
            properties: {
              Name: { title: [{ plain_text: p.title }] },
              code2wiki_id: {
                rich_text: p.code2wiki_id
                  ? [{ plain_text: p.code2wiki_id }]
                  : [],
              },
            },
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as unknown as typeof fetch;
}

describe("preflight (Confluence)", () => {
  it("PF-1: empty space → all clean", async () => {
    const pub = new ConfluencePublisher(CFG_CONFLUENCE, {
      fetch: confluenceFetch([]),
    });
    const r = await pub.preflight([PAGE_A, PAGE_B, PAGE_C]);
    expect(r.summary.clean).toBe(3);
    expect(r.summary.collision).toBe(0);
    expect(r.entries.every((e) => e.outcome === "clean")).toBe(true);
  });

  it("PF-2: already-managed page → managed outcome", async () => {
    const pub = new ConfluencePublisher(CFG_CONFLUENCE, {
      fetch: confluenceFetch([
        {
          id: "111",
          title: "Publishing a Site",
          labels: ["c2w-publishing-a-site"],
        },
      ]),
    });
    const r = await pub.preflight([PAGE_A]);
    expect(r.summary.managed).toBe(1);
    expect(r.entries[0]?.outcome).toBe("managed");
    expect(r.entries[0]?.existing?.match_reason).toBe("label");
  });

  it("PF-3: title collision (greenfield) → collision entry, ignoreCollisions allowed", async () => {
    const pub = new ConfluencePublisher(
      { ...CFG_CONFLUENCE, coexistence: { mode: "greenfield" } },
      { fetch: confluenceFetch([{ id: "222", title: "Publishing a Site" }]) },
    );
    const r = await pub.preflight([PAGE_A]);
    expect(r.summary.collision).toBe(1);
    expect(r.entries[0]?.outcome).toBe("collision");
    expect(r.entries[0]?.existing?.match_reason).toBe("title_exact_ci");
    expect(r.entries[0]?.suggested_action).toContain("claim --target=confluence");
  });

  it("PF-6: case-insensitive title collision", async () => {
    const pub = new ConfluencePublisher(CFG_CONFLUENCE, {
      fetch: confluenceFetch([{ id: "333", title: "PUBLISHING A SITE" }]),
    });
    const r = await pub.preflight([PAGE_A]);
    expect(r.entries[0]?.outcome).toBe("collision");
  });

  it("PF-7: renamed managed page", async () => {
    const pub = new ConfluencePublisher(CFG_CONFLUENCE, {
      fetch: confluenceFetch([
        {
          id: "444",
          title: "Publish a Site (legacy)",
          labels: ["c2w-publishing-a-site"],
        },
      ]),
    });
    const r = await pub.preflight([PAGE_A]);
    expect(r.entries[0]?.outcome).toBe("renamed");
  });

  it("PF-9: multiple collisions counted in summary", async () => {
    const pub = new ConfluencePublisher(CFG_CONFLUENCE, {
      fetch: confluenceFetch([
        { id: "1", title: "Publishing a Site" },
        { id: "2", title: "Managing Users" },
        { id: "3", title: "Deleting Content" },
      ]),
    });
    const r = await pub.preflight([PAGE_A, PAGE_B, PAGE_C]);
    expect(r.summary.collision).toBe(3);
    expect(r.entries.every((e) => e.suggested_action)).toBe(true);
  });
});

describe("preflight collision-by-mode (PF-4, PF-5)", () => {
  it("PF-4: claim mode preflight reports collision (caller blocks)", async () => {
    const pub = new ConfluencePublisher(
      { ...CFG_CONFLUENCE, coexistence: { mode: "claim" } },
      { fetch: confluenceFetch([{ id: "1", title: "Publishing a Site" }]) },
    );
    const r = await pub.preflight([PAGE_A]);
    expect(r.mode).toBe("claim");
    expect(r.summary.collision).toBe(1);
    // The CLI is what decides whether to abort; preflight just records.
    expect(r.entries[0]?.suggested_action).toContain("--map-to=publishing-a-site");
  });

  it("PF-5: parallel mode preflight reports collision but as informational", async () => {
    const pub = new ConfluencePublisher(
      { ...CFG_CONFLUENCE, coexistence: { mode: "parallel" } },
      { fetch: confluenceFetch([{ id: "1", title: "Publishing a Site" }]) },
    );
    const r = await pub.preflight([PAGE_A]);
    expect(r.mode).toBe("parallel");
    expect(r.summary.collision).toBe(1);
  });
});

describe("preflight (Notion)", () => {
  it("PF-1 (Notion): empty database → all clean", async () => {
    const pub = new NotionPublisher(CFG_NOTION, {
      fetch: notionFetch([]),
    });
    const r = await pub.preflight([PAGE_A]);
    expect(r.entries[0]?.outcome).toBe("clean");
  });

  it("PF-2 (Notion): existing labeled page → managed", async () => {
    const pub = new NotionPublisher(CFG_NOTION, {
      fetch: notionFetch([
        {
          id: "n-1",
          title: "Publishing a Site",
          code2wiki_id: "publishing-a-site",
        },
      ]),
    });
    const r = await pub.preflight([PAGE_A]);
    expect(r.entries[0]?.outcome).toBe("managed");
  });

  it("PF-3 (Notion): title collision", async () => {
    const pub = new NotionPublisher(CFG_NOTION, {
      fetch: notionFetch([{ id: "n-2", title: "Publishing a Site" }]),
    });
    const r = await pub.preflight([PAGE_A]);
    expect(r.entries[0]?.outcome).toBe("collision");
  });
});

describe("preflight JSON output", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-preflight-"));
  });
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("PF-10: writes .code2wiki/preflight.json with the expected schema", async () => {
    const pub = new ConfluencePublisher(CFG_CONFLUENCE, {
      fetch: confluenceFetch([{ id: "555", title: "Publishing a Site" }]),
    });
    const r = await pub.preflight([PAGE_A]);
    await writePreflight(dir, r);
    const written = await fs.readFile(preflightPath(dir), "utf-8");
    const parsed = JSON.parse(written);
    expect(parsed.target).toBe("confluence");
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.collision).toBe(1);
    expect(parsed.entries[0].outcome).toBe("collision");
    expect(parsed.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
