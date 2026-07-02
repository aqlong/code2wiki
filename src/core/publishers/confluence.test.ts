import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import {
  ConfluencePublisher,
  markdownToConfluenceStorage,
} from "./confluence.js";
import type { PageInput } from "./types.js";

const SAMPLE_PAGE: PageInput = {
  code2wiki_id: "java-foo-bar-v1",
  title: "Foo Bar Use Case",
  slug: "foo-bar-use-case",
  markdown: "## Summary\n\nA quick test.\n",
  tags: ["foo", "bar"],
};

const CFG = {
  baseUrl: "https://example.atlassian.net/wiki",
  email: "tester@example.com",
  apiToken: "test-token",
  spaceKey: "DOCS",
};

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function mockFetch(handler: (req: { url: string; method: string; body: unknown }) => { status: number; body: unknown }) {
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

describe("markdownToConfluenceStorage", () => {
  it("renders headings and paragraphs", () => {
    const html = markdownToConfluenceStorage("## Hello\n\nworld");
    expect(html).toContain("<h2>");
    expect(html).toContain("Hello");
    expect(html).toContain("<p>");
  });

  it("preserves code fences as <pre><code>", () => {
    const html = markdownToConfluenceStorage("```js\nlet x = 1;\n```");
    expect(html).toMatch(/<pre>.*<code/);
  });

  // Regression: marked's default renderer passes raw HTML tokens through
  // verbatim, which means an LLM-quoted `<user>` or `<cfif>` in prose
  // would emit invalid XHTML and Confluence would reject the publish
  // with a 400. Discovered 2026-05-13 while writing tests for the local
  // wiki preview's xmllint round-trip.
  it("escapes unknown raw HTML tags in prose (`<user>`)", () => {
    const html = markdownToConfluenceStorage(
      "Field example: a `<user>` element holds the actor. End <user> stray.",
    );
    // The codespan stays an escaped <code> block (marked entity-escapes
    // codespan content); the raw `<user>` outside the backticks must be
    // escaped to entity text, not passed through as a literal tag.
    expect(html).toContain("<code>&lt;user&gt;</code>");
    expect(html).not.toMatch(/\sEnd <user>\s/);
    expect(html).toContain("&lt;user&gt;");
  });

  it("escapes unknown raw HTML tags from CFML/XML examples (`<cfif>`)", () => {
    const html = markdownToConfluenceStorage(
      "The template wraps logic in <cfif x> ... </cfif> blocks.",
    );
    expect(html).not.toMatch(/<cfif x>/);
    expect(html).not.toMatch(/<\/cfif>/);
    expect(html).toContain("&lt;cfif x&gt;");
    expect(html).toContain("&lt;/cfif&gt;");
  });

  it("escapes mismatched HTML-shaped prose without leaving dangling angle brackets", () => {
    const html = markdownToConfluenceStorage(
      "Prose with <like this> and <unbalanced tag.",
    );
    expect(html).toContain("&lt;like this&gt;");
    expect(html).not.toMatch(/<like this>/);
  });

  it("escapes attribute-bearing unknown tags", () => {
    const html = markdownToConfluenceStorage(
      'Sample: <custom data-x="1">payload</custom> closes.',
    );
    expect(html).toContain("&lt;custom data-x=&quot;1&quot;&gt;");
    expect(html).toContain("&lt;/custom&gt;");
  });

  it("preserves the managed-fence HTML comments verbatim", () => {
    const html = markdownToConfluenceStorage(
      "<!-- code2wiki:managed:start id=abc -->\nbody\n<!-- code2wiki:managed:end -->",
    );
    expect(html).toContain("<!-- code2wiki:managed:start id=abc -->");
    expect(html).toContain("<!-- code2wiki:managed:end -->");
  });

  it("preserves the intentional <details>/<summary> block from renderer.ts", () => {
    const md =
      "<details>\n<summary>Implementation files</summary>\n\n- `foo.cfc` lines 1-10\n\n</details>";
    const html = markdownToConfluenceStorage(md);
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>");
    expect(html).toContain("</details>");
    expect(html).toContain("</summary>");
  });

  it("leaves code-fence content escaped by marked (raw HTML inside fences is safe)", () => {
    const html = markdownToConfluenceStorage(
      "```xml\n<cfif x>\n  <cfset y=1>\n</cfif>\n```",
    );
    expect(html).toContain("&lt;cfif x&gt;");
    expect(html).toContain("&lt;cfset y=1&gt;");
    expect(html).not.toMatch(/<cfif x>/);
  });

  // xmllint round-trip on a corpus of adversarial inputs that would have
  // produced invalid XHTML under the pre-fix renderer (raw HTML tag passes
  // through verbatim). xmllint ships with libxml2 on macOS by default; CI
  // runners without it silently skip. The wrapper mirrors the one in
  // tools/scripts/local-wiki-preview.ts so unbound namespace prefixes
  // don't confuse the parser.
  it("produces XHTML that survives xmllint on adversarial inputs (when available)", () => {
    const probe = spawnSync("xmllint", ["--version"]);
    if (probe.status !== 0) {
      console.log("  (skipped, xmllint not available)");
      return;
    }
    const adversarial = [
      "Prose with a stray <unknown> tag.",
      "Mismatched <a><b></a></b> nesting.",
      'Attributed unknown: <custom data-x="1">payload</custom>.',
      "CFML snippet: <cfif x><cfset y=1></cfif>.",
      "XML excerpt: <user>aqlong</user> and <user/> self-closer.",
      "Stray opener with no closer: <hello world.",
      "<!-- code2wiki:managed:start id=x -->\nbody with <user> inside\n<!-- code2wiki:managed:end -->",
      "<details>\n<summary>Open me</summary>\n\nbody with <stray> tag\n\n</details>",
    ];
    for (const md of adversarial) {
      const rendered = markdownToConfluenceStorage(md);
      const wrapped =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<root xmlns:ac="http://atlassian.com/content">\n` +
        rendered +
        `\n</root>\n`;
      const r = spawnSync("xmllint", ["--noout", "-"], { input: wrapped });
      if (r.status !== 0) {
        throw new Error(
          `xmllint rejected output for adversarial input ${JSON.stringify(md)}:\n` +
            r.stderr.toString() +
            `\nrendered:\n${rendered}`,
        );
      }
    }
  });
});

describe("ConfluencePublisher", () => {
  it("creates a new page when none exists", async () => {
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (url.includes("/rest/api/content/search")) {
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        return {
          status: 200,
          body: {
            id: "new-page-1",
            type: "page",
            title: "Foo Bar Use Case",
            version: { number: 1 },
            _links: { webui: "/spaces/DOCS/pages/new-page-1", base: CFG.baseUrl },
          },
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("created");
    expect(result?.externalId).toBe("new-page-1");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/rest/api/content"))).toBe(true);
  });

  it("strips YAML frontmatter so its keys never render as body text", async () => {
    // The `publish` command hands the whole .md file (frontmatter included)
    // to the publisher as page.markdown. Without stripFrontmatter() the keys
    // leak as a visible heading on every Confluence page. Regression guard.
    const fmPage: PageInput = {
      ...SAMPLE_PAGE,
      markdown:
        "---\n" +
        "code2wiki_id: java-foo-bar-v1\n" +
        "title: Foo Bar Use Case\n" +
        "slug: foo-bar-use-case\n" +
        "tags: [foo, bar]\n" +
        "confidence: high\n" +
        "---\n\n" +
        "## Summary\n\nA quick test.\n",
    };
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (url.includes("/rest/api/content/search")) {
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        return {
          status: 200,
          body: {
            id: "new-page-1",
            type: "page",
            title: "Foo Bar Use Case",
            version: { number: 1 },
            _links: { webui: "/spaces/DOCS/pages/new-page-1", base: CFG.baseUrl },
          },
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    const [result] = await pub.publish([fmPage]);
    expect(result?.outcome).toBe("created");
    const post = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/rest/api/content"),
    );
    const storage = (post?.body as { body: { storage: { value: string } } })
      .body.storage.value;
    // Frontmatter keys must NOT appear anywhere in the rendered storage.
    expect(storage).not.toContain("code2wiki_id:");
    expect(storage).not.toContain("confidence: high");
    expect(storage).not.toContain("tags: [foo, bar]");
    // The real body still renders.
    expect(storage).toContain("Summary");
    expect(storage).toContain("A quick test.");
  });

  it("updates an existing page when the search returns one", async () => {
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (url.includes("/rest/api/content/search")) {
        return {
          status: 200,
          body: {
            results: [
              {
                id: "existing-1",
                type: "page",
                title: "Foo Bar Use Case",
                version: { number: 7 },
              },
            ],
          },
        };
      }
      if (method === "PUT" && url.includes("/rest/api/content/existing-1")) {
        return {
          status: 200,
          body: {
            id: "existing-1",
            type: "page",
            title: "Foo Bar Use Case",
            version: { number: 8 },
          },
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("updated");
    expect(result?.externalId).toBe("existing-1");
    const putCall = calls.find((c) => c.method === "PUT");
    // Updated to version 8 (incremented from 7).
    expect((putCall?.body as { version: { number: number } }).version.number).toBe(8);
  });

  it("dry-run does not POST or PUT", async () => {
    const { fetch, calls } = mockFetch(({ url }) => {
      if (url.includes("/rest/api/content/search")) {
        return { status: 200, body: { results: [] } };
      }
      throw new Error(
        `dry-run should not call ${url}; only the search endpoint is allowed`,
      );
    });
    const pub = new ConfluencePublisher(CFG, { fetch, dryRun: true });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("created");
    expect(result?.message).toContain("dry run");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("parallel mode: parent setup failure marks all pages as skipped", async () => {
    const { fetch } = mockFetch(() => ({ status: 500, body: { message: "unavailable" } }));
    const pub = new ConfluencePublisher(
      { ...CFG, coexistence: { mode: "parallel" } },
      { fetch },
    );
    const results = await pub.publish([
      SAMPLE_PAGE,
      { ...SAMPLE_PAGE, code2wiki_id: "java-foo-second-v1", slug: "second", title: "Second" },
    ]);
    expect(results.every((r) => r.outcome === "skipped")).toBe(true);
    expect(results[0]?.message).toContain("parallel-parent setup failed");
  });

  it("findExistingPage search URL expands body.storage so post-claim outside content is preserved", async () => {
    let searchExpandParam: string | undefined;
    const { fetch } = mockFetch(({ url, method }) => {
      if (url.includes("/rest/api/content/search")) {
        try { searchExpandParam = new URL(url).searchParams.get("expand") ?? ""; } catch { /* */ }
        return { status: 200, body: { results: [{ id: "p1", type: "page", title: "Foo Bar Use Case", version: { number: 1 } }] } };
      }
      if (method === "PUT") return { status: 200, body: { id: "p1", title: "Foo Bar Use Case", version: { number: 2 } } };
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect(searchExpandParam).toContain("body.storage");
  });

  it("captures errors per page without aborting the batch", async () => {
    let nthSearch = 0;
    const { fetch } = mockFetch(({ url }) => {
      if (url.includes("/rest/api/content/search")) {
        nthSearch++;
        if (nthSearch === 1) return { status: 500, body: { error: "boom" } };
        return { status: 200, body: { results: [] } };
      }
      return {
        status: 200,
        body: {
          id: "p2",
          type: "page",
          title: "Second",
          version: { number: 1 },
        },
      };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    const results = await pub.publish([
      SAMPLE_PAGE,
      { ...SAMPLE_PAGE, code2wiki_id: "java-foo-second-v1", slug: "second", title: "Second" },
    ]);
    expect(results[0]?.outcome).toBe("skipped");
    expect(results[1]?.outcome).toBe("created");
  });
});

describe("ConfluencePublisher.preflight", () => {
  // Decode the cql query param to distinguish the label search from the title
  // search; findExistingPage builds CQL with `label="c2w-..."`, findByTitle
  // builds CQL with `title="..."`. URL.searchParams.get decodes percent-encoded
  // characters back to literal `=`/`"`/etc. so substring checks work.
  const cqlOf = (url: string) => new URL(url).searchParams.get("cql") ?? "";

  it("classifies a page with no label match and no title match as clean", async () => {
    const { fetch } = mockFetch(({ url }) => {
      if (url.includes("/rest/api/content/search")) {
        return { status: 200, body: { results: [] } };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.target).toBe("confluence");
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

  it("classifies a labeled page with matching title as managed", async () => {
    const { fetch } = mockFetch(({ url }) => {
      if (cqlOf(url).includes("label=")) {
        return {
          status: 200,
          body: {
            results: [
              {
                id: "lab-1",
                type: "page",
                title: "Foo Bar Use Case",
                version: { number: 4 },
                _links: {
                  webui: "/spaces/DOCS/pages/lab-1",
                  base: CFG.baseUrl,
                },
              },
            ],
          },
        };
      }
      return { status: 200, body: { results: [] } };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("managed");
    expect(result.entries[0]?.existing?.external_id).toBe("lab-1");
    expect(result.entries[0]?.existing?.match_reason).toBe("label");
    expect(result.entries[0]?.existing?.url).toBe(
      `${CFG.baseUrl}/spaces/DOCS/pages/lab-1`,
    );
    expect(result.summary.managed).toBe(1);
  });

  it("classifies a labeled page whose title drifted as renamed", async () => {
    const { fetch } = mockFetch(({ url }) => {
      if (cqlOf(url).includes("label=")) {
        return {
          status: 200,
          body: {
            results: [
              {
                id: "drift-1",
                type: "page",
                title: "Stale Title (Renamed in UI)",
                version: { number: 2 },
              },
            ],
          },
        };
      }
      return { status: 200, body: { results: [] } };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("renamed");
    expect(result.entries[0]?.existing?.title).toBe(
      "Stale Title (Renamed in UI)",
    );
    expect(result.summary.renamed).toBe(1);
  });

  it("treats managed-vs-renamed comparison as case-insensitive", async () => {
    // Confluence titles are case-insensitive at lookup; a UI tweak to caps
    // shouldn't flip a "managed" page to "renamed" and force a no-op publish.
    const { fetch } = mockFetch(({ url }) => {
      if (cqlOf(url).includes("label=")) {
        return {
          status: 200,
          body: {
            results: [
              {
                id: "case-1",
                type: "page",
                title: "FOO BAR USE CASE",
                version: { number: 1 },
              },
            ],
          },
        };
      }
      return { status: 200, body: { results: [] } };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("managed");
  });

  it("classifies a title-only match (no c2w label) as collision with suggestClaim hint", async () => {
    const { fetch } = mockFetch(({ url }) => {
      const cql = cqlOf(url);
      if (cql.includes("label=")) {
        return { status: 200, body: { results: [] } };
      }
      // title search
      return {
        status: 200,
        body: {
          results: [
            {
              id: "col-1",
              type: "page",
              title: "Foo Bar Use Case",
              version: { number: 1 },
              metadata: { labels: { results: [{ name: "doc" }] } },
              _links: {
                webui: "/spaces/DOCS/pages/col-1",
                base: CFG.baseUrl,
              },
            },
          ],
        },
      };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("collision");
    expect(result.entries[0]?.existing?.external_id).toBe("col-1");
    expect(result.entries[0]?.existing?.match_reason).toBe("title_exact_ci");
    expect(result.entries[0]?.suggested_action).toContain(
      "--target=confluence",
    );
    expect(result.entries[0]?.suggested_action).toContain(
      `--map-to=${SAMPLE_PAGE.code2wiki_id}`,
    );
    expect(result.entries[0]?.suggested_action).toContain("--page-id=col-1");
    expect(result.summary.collision).toBe(1);
  });

  it("filters title-search results already labeled c2w-* and reports clean", async () => {
    // A c2w-labeled page would already have been caught by findExistingPage;
    // findByTitle MUST skip such results to avoid a double-claim suggestion.
    const { fetch } = mockFetch(({ url }) => {
      const cql = cqlOf(url);
      if (cql.includes("label=")) {
        return { status: 200, body: { results: [] } };
      }
      return {
        status: 200,
        body: {
          results: [
            {
              id: "label-coll-1",
              type: "page",
              title: "Foo Bar Use Case",
              version: { number: 1 },
              metadata: {
                labels: { results: [{ name: "c2w-someone-else-id" }] },
              },
            },
          ],
        },
      };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.outcome).toBe("clean");
    expect(result.summary.collision).toBe(0);
  });

  it("propagates explicit coexistence.mode into the PreflightResult", async () => {
    const { fetch } = mockFetch(() => ({
      status: 200,
      body: { results: [] },
    }));
    const pub = new ConfluencePublisher(
      { ...CFG, coexistence: { mode: "claim" } },
      { fetch },
    );
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.mode).toBe("claim");
  });

  it("applies titlePrefix to the title search and to the PreflightEntry's title, never to the c2w label", async () => {
    let labelCql = "";
    let titleCql = "";
    const { fetch } = mockFetch(({ url }) => {
      if (!url.includes("/rest/api/content/search")) {
        return { status: 404, body: {} };
      }
      const cql = cqlOf(url);
      if (cql.includes("label=")) labelCql = cql;
      else if (cql.includes("title=")) titleCql = cql;
      return { status: 200, body: { results: [] } };
    });
    const pub = new ConfluencePublisher(
      { ...CFG, coexistence: { titlePrefix: "[c2w]" } },
      { fetch },
    );
    const result = await pub.preflight([SAMPLE_PAGE]);
    expect(result.entries[0]?.title).toBe("[c2w] Foo Bar Use Case");
    expect(titleCql).toContain('title="[c2w] Foo Bar Use Case"');
    // Label lookup stays keyed on code2wiki_id, NOT the prefixed title, a
    // regression here would break upsert continuity for every customer who
    // turns on titlePrefix mid-stream.
    expect(labelCql).toContain('label="c2w-java-foo-bar-v1"');
  });

  it("aggregates summary correctly across a mixed batch (clean + managed + renamed + collision)", async () => {
    const inputs: PageInput[] = [
      { ...SAMPLE_PAGE, code2wiki_id: "p-clean", title: "Clean Page" },
      { ...SAMPLE_PAGE, code2wiki_id: "p-managed", title: "Managed Page" },
      { ...SAMPLE_PAGE, code2wiki_id: "p-renamed", title: "Renamed Page" },
      { ...SAMPLE_PAGE, code2wiki_id: "p-collision", title: "Collision Page" },
    ];
    const { fetch } = mockFetch(({ url }) => {
      const cql = cqlOf(url);
      if (cql.includes("label=")) {
        if (cql.includes("p-managed")) {
          return {
            status: 200,
            body: {
              results: [
                {
                  id: "m-1",
                  type: "page",
                  title: "Managed Page",
                  version: { number: 1 },
                },
              ],
            },
          };
        }
        if (cql.includes("p-renamed")) {
          return {
            status: 200,
            body: {
              results: [
                {
                  id: "r-1",
                  type: "page",
                  title: "Drifted Title",
                  version: { number: 1 },
                },
              ],
            },
          };
        }
        return { status: 200, body: { results: [] } };
      }
      // title-search branch
      if (cql.includes('"Collision Page"')) {
        return {
          status: 200,
          body: {
            results: [
              {
                id: "c-1",
                type: "page",
                title: "Collision Page",
                version: { number: 1 },
              },
            ],
          },
        };
      }
      return { status: 200, body: { results: [] } };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
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

  // findByTitle builds CQL with `title="<page-title>"` after escaping any
  // embedded `"` to `\"`. Without escape, a title containing `"` would
  // unbalance the CQL quoting and Confluence would either 400 or, worse,
  // silently match the wrong page. The escape is `title.replace(/"/g, '\\"')`
  // in confluence.ts; these cases are a regression guard.
  describe("findByTitle CQL escape", () => {
    // Capture the title-search CQL (after URL decoding). Only fires on the
    // non-label branch; label branch always returns empty so findByTitle runs.
    const captureTitleCql = () => {
      let titleCql: string | null = null;
      const { fetch } = mockFetch(({ url }) => {
        if (!url.includes("/rest/api/content/search")) {
          return { status: 404, body: {} };
        }
        const cql = cqlOf(url);
        if (cql.includes("label=")) {
          return { status: 200, body: { results: [] } };
        }
        titleCql = cql;
        return { status: 200, body: { results: [] } };
      });
      return { fetch, getCql: () => titleCql };
    };

    it("escapes a single embedded double quote", async () => {
      const { fetch, getCql } = captureTitleCql();
      const pub = new ConfluencePublisher(CFG, { fetch });
      await pub.preflight([{ ...SAMPLE_PAGE, title: 'He said "hi" loudly' }]);
      expect(getCql()).toContain('title="He said \\"hi\\" loudly"');
    });

    it("escapes every double quote, not just the first", async () => {
      // Regression guard: if the regex ever loses its `/g` flag, only the
      // first `"` would escape and the rest would break the CQL clause.
      const { fetch, getCql } = captureTitleCql();
      const pub = new ConfluencePublisher(CFG, { fetch });
      await pub.preflight([{ ...SAMPLE_PAGE, title: 'a"b"c"d' }]);
      const cql = getCql();
      expect(cql).toContain('title="a\\"b\\"c\\"d"');
      // Three escaped quotes inside the title segment.
      const titleSeg = cql?.match(/title="([^]*)"$/)?.[1] ?? "";
      expect(titleSeg.match(/\\"/g)?.length).toBe(3);
    });

    it("does not inject backslashes when the title has no double quotes", async () => {
      // Regression guard: overly-aggressive escape (e.g. escaping every
      // special char) would smuggle backslashes into a clean title and
      // break exact-match lookups for plain-titled pages, the common case.
      const { fetch, getCql } = captureTitleCql();
      const pub = new ConfluencePublisher(CFG, { fetch });
      await pub.preflight([{ ...SAMPLE_PAGE, title: "Foo Bar Use Case" }]);
      const cql = getCql();
      expect(cql).toContain('title="Foo Bar Use Case"');
      expect(cql).not.toContain("\\");
    });

    it("preserves the surrounding CQL shape (space + type + title clauses)", async () => {
      // Regression guard: a future tweak to the cql template that dropped
      // `space="..."` would let title search match across every space the
      // API token can see, silently surfacing collisions from unrelated
      // teams and triggering wrong-page claim suggestions.
      const { fetch, getCql } = captureTitleCql();
      const pub = new ConfluencePublisher(CFG, { fetch });
      await pub.preflight([{ ...SAMPLE_PAGE, title: 'q"q' }]);
      const cql = getCql() ?? "";
      expect(cql).toContain('space="DOCS"');
      expect(cql).toContain("type=page");
      expect(cql).toContain('title="q\\"q"');
      expect(cql).toMatch(
        /^space="DOCS" AND type=page AND title="q\\"q"$/,
      );
    });

    it("escapes inside a titlePrefix-prepended title", async () => {
      // The escape applies AFTER effectiveTitle prepends the prefix; both
      // the prefix's literal `"` (if any) and the page-title's `"` must
      // escape. Pin the prefix-bearing branch so a refactor that escapes
      // before prefixing doesn't silently regress.
      const { fetch, getCql } = captureTitleCql();
      const pub = new ConfluencePublisher(
        { ...CFG, coexistence: { titlePrefix: '[say "hi"]' } },
        { fetch },
      );
      await pub.preflight([{ ...SAMPLE_PAGE, title: 'Foo "Bar"' }]);
      expect(getCql()).toContain(
        'title="[say \\"hi\\"] Foo \\"Bar\\""',
      );
    });
  });
});

// findExistingPage is the upsert key for the entire Confluence publisher:
// every publish() and preflight() consults it to decide create-vs-update.
// The CQL is `space="<key>" AND label="c2w-<id>"`, expanded for
// `version,body.storage` and limited to 1 result. A regression in any of:
// (a) the c2w- label prefix, (b) the code2wiki_id as the label suffix,
// (c) the space-scoping clause, (d) the version+body.storage expand pair,
// (e) the Basic-auth header, silently breaks upsert continuity for every
// customer's managed pages. The existing happy-path tests (lines ~89, 158,
// 426) cover individual fragments; these cases pin the full URL + headers
// + error-shape contract.
describe("ConfluencePublisher.findExistingPage label CQL", () => {
  const captureLabelSearch = () => {
    let labelUrl: string | null = null;
    let labelHeaders: Record<string, string> | null = null;
    const fn = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/rest/api/content/search")) {
        const cql = new URL(url).searchParams.get("cql") ?? "";
        if (cql.includes("label=")) {
          labelUrl = url;
          labelHeaders = (init?.headers ?? {}) as Record<string, string>;
        }
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    return {
      fetch: fn,
      getLabelUrl: () => labelUrl,
      getLabelHeaders: () => labelHeaders,
    };
  };

  it("uses `label=\"c2w-<code2wiki_id>\"` with the page's full code2wiki_id (NOT slug or title)", async () => {
    // Pin the upsert-key contract. Regression to `c2w-<slug>` or `c2w-<title>`
    // would break upsert the moment a customer renames a page's title (the
    // whole point of having a stable code2wiki_id separate from slug/title
    // per CLAUDE.md "Key conventions").
    const { fetch, getLabelUrl } = captureLabelSearch();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.preflight([SAMPLE_PAGE]);
    const cql = new URL(getLabelUrl()!).searchParams.get("cql") ?? "";
    expect(cql).toContain('label="c2w-java-foo-bar-v1"');
    // Defensive: confirm NEITHER slug NOR title leaked in as the suffix.
    expect(cql).not.toContain('label="c2w-foo-bar-use-case"');
    expect(cql).not.toContain('label="c2w-Foo Bar Use Case"');
  });

  it("scopes the CQL to the configured space via `space=\"<key>\"`", async () => {
    // Regression dropping the space clause would surface wrong-space label
    // matches: an unrelated team's page tagged with the same c2w-<id> in a
    // shared API token's reach would be picked up as "our" managed page and
    // the next publish would PUT to it. Pin the full CQL shape.
    const { fetch, getLabelUrl } = captureLabelSearch();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.preflight([SAMPLE_PAGE]);
    const cql = new URL(getLabelUrl()!).searchParams.get("cql") ?? "";
    expect(cql).toBe('space="DOCS" AND label="c2w-java-foo-bar-v1"');
  });

  it("expands BOTH version AND body.storage on the search URL", async () => {
    // version is consumed by updatePage's `version.number + 1`; a regression
    // dropping it would surface as TypeError mid-publish. body.storage is
    // consumed by mergePreservedOutside to preserve post-claim customer
    // content. The existing test at L158 pins body.storage; this case pins
    // both halves of the expand parameter together so a regression to either
    // alone surfaces here as well.
    const { fetch, getLabelUrl } = captureLabelSearch();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.preflight([SAMPLE_PAGE]);
    const expand = new URL(getLabelUrl()!).searchParams.get("expand") ?? "";
    expect(expand).toBe("version,body.storage");
  });

  it("sets limit=1 on the search URL", async () => {
    // Defense-in-depth: with limit=1, the publisher only ever sees one
    // labeled match. A regression dropping the limit or raising it would not
    // change correctness (results[0] still wins), but would inflate API cost
    // and surface latency for tenants with many labels in the space.
    const { fetch, getLabelUrl } = captureLabelSearch();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.preflight([SAMPLE_PAGE]);
    const limit = new URL(getLabelUrl()!).searchParams.get("limit") ?? "";
    expect(limit).toBe("1");
  });

  it("sends `Authorization: Basic <base64(email:apiToken)>` and `Accept: application/json`", async () => {
    // Auth is load-bearing; a regression dropping the Authorization header
    // would 401 every request and surface as the "Confluence search failed"
    // throw path; pin the exact header shape so the base64 derivation stays
    // stable across refactors. Accept header pin guards against a slip to
    // text/* that would break JSON parsing.
    const { fetch, getLabelHeaders } = captureLabelSearch();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.preflight([SAMPLE_PAGE]);
    const headers = getLabelHeaders() ?? {};
    const expected = `Basic ${Buffer.from(`${CFG.email}:${CFG.apiToken}`).toString("base64")}`;
    expect(headers.Authorization).toBe(expected);
    expect(headers.Accept).toBe("application/json");
  });

  it("throws `Confluence search failed: <status> <body>` on non-OK response", async () => {
    // Pin the exact error message shape. The CLI prints publisher errors to
    // stderr verbatim (cli/commands/publish.ts) and the dashboard's run-error
    // surface keys off it; a refactor that drops the status code or the body
    // payload from the message would silently degrade the operator's
    // forensics on transient Confluence 5xx blips.
    const fn = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/rest/api/content/search")) {
        return new Response("upstream timeout", { status: 503 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const pub = new ConfluencePublisher(CFG, { fetch: fn });
    // preflight() catches per-page errors into entries; use publish() which
    // surfaces the throw via per-page outcome="skipped" + message.
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("skipped");
    expect(result?.message).toContain("Confluence search failed: 503");
    expect(result?.message).toContain("upstream timeout");
  });
});

describe("ConfluencePublisher.claim", () => {
  const PRE_CLAIM_BODY = "<p>Original BA content.</p>";
  const CLAIM_INPUT = {
    pageId: "wiki-page-42",
    code2wiki_id: "java-foo-bar-v1",
    placement: "below" as const,
    title: "Foo Bar Use Case",
    repoName: "test-repo",
    commit: "abc1234",
    now: () => "2026-05-12T00:00:00.000Z",
  };

  function makeGetResponse(overrides: {
    labels?: Array<{ name: string }>;
    spaceKey?: string;
    body?: string;
  } = {}) {
    return {
      id: CLAIM_INPUT.pageId,
      type: "page",
      title: "Pre-claim Hand-written Title",
      version: { number: 5 },
      body: { storage: { value: overrides.body ?? PRE_CLAIM_BODY } },
      metadata: { labels: { results: overrides.labels ?? [] } },
      space: { key: overrides.spaceKey ?? CFG.spaceKey },
      _links: {
        webui: "/spaces/DOCS/pages/wiki-page-42",
        base: CFG.baseUrl,
      },
    };
  }

  it("rejects when the page already carries any c2w-* label", async () => {
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (
        method === "GET" &&
        url.includes(`/content/${CLAIM_INPUT.pageId}`)
      ) {
        return {
          status: 200,
          body: makeGetResponse({ labels: [{ name: "c2w-other-id" }] }),
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    await expect(pub.claim(CLAIM_INPUT)).rejects.toThrow(/already managed/);
    // No body write, no label POST, the rejection happens before any mutation.
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("rejects when the target page lives in a different space", async () => {
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (
        method === "GET" &&
        url.includes(`/content/${CLAIM_INPUT.pageId}`)
      ) {
        return {
          status: 200,
          body: makeGetResponse({ spaceKey: "OTHER" }),
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    await expect(pub.claim(CLAIM_INPUT)).rejects.toThrow(/space 'OTHER'/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("happy path: writes banner+fence-below+preserved body, adds c2w-<id> and default code2wiki labels, returns hash", async () => {
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (
        method === "GET" &&
        url.includes(`/content/${CLAIM_INPUT.pageId}`)
      ) {
        return { status: 200, body: makeGetResponse() };
      }
      if (
        method === "PUT" &&
        url.includes(`/content/${CLAIM_INPUT.pageId}`)
      ) {
        return {
          status: 200,
          body: { id: CLAIM_INPUT.pageId, version: { number: 6 } },
        };
      }
      if (
        method === "POST" &&
        url.includes(`/content/${CLAIM_INPUT.pageId}/label`)
      ) {
        return { status: 200, body: {} };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    const result = await pub.claim(CLAIM_INPUT);
    expect(result.external_id).toBe(CLAIM_INPUT.pageId);
    expect(result.pre_claim_content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Hash determinism: an identical pre-claim body MUST produce an identical
    // hash so the audit log can dedupe re-claim attempts deterministically.
    const crypto = await import("node:crypto");
    const expected =
      "sha256:" +
      crypto.createHash("sha256").update(PRE_CLAIM_BODY, "utf-8").digest("hex");
    expect(result.pre_claim_content_hash).toBe(expected);
    expect(result.url).toBe(`${CFG.baseUrl}/spaces/DOCS/pages/wiki-page-42`);

    const putCall = calls.find((c) => c.method === "PUT");
    const newBody = (
      putCall?.body as { body: { storage: { value: string } } }
    ).body.storage.value;
    // Banner sits OUTSIDE the managed fence (ADR-016 attribution invariant).
    expect(newBody).toContain("📝");
    expect(newBody).toContain(
      "code2wiki:managed:start id=java-foo-bar-v1",
    );
    expect(newBody).toContain("code2wiki:managed:end");
    expect(newBody).toContain("Original content (preserved)");
    expect(newBody).toContain(PRE_CLAIM_BODY);
    // Default placement is below: fence close comes BEFORE the preserved
    // original. A regression flipping the default would surface the original
    // above the fence, confusing BAs about which region they can edit.
    expect(newBody.indexOf("code2wiki:managed:end")).toBeLessThan(
      newBody.indexOf(PRE_CLAIM_BODY),
    );
    // Title is NOT updated at claim time, the put body carries the existing
    // title verbatim so an active customer rename is preserved.
    expect(
      (putCall?.body as { title: string }).title,
    ).toBe("Pre-claim Hand-written Title");
    // Version increments by 1.
    expect(
      (putCall?.body as { version: { number: number } }).version.number,
    ).toBe(6);

    const labelPosts = calls.filter(
      (c) => c.method === "POST" && c.url.includes("/label"),
    );
    expect(labelPosts).toHaveLength(2);
    expect((labelPosts[0]?.body as Array<{ name: string }>)[0]?.name).toBe(
      "c2w-java-foo-bar-v1",
    );
    expect((labelPosts[1]?.body as Array<{ name: string }>)[0]?.name).toBe(
      "code2wiki",
    );
  });

  it("placement 'above' puts the preserved original BEFORE the fence", async () => {
    const { fetch, calls } = mockFetch(({ method }) => {
      if (method === "GET") return { status: 200, body: makeGetResponse() };
      if (method === "PUT") return { status: 200, body: {} };
      if (method === "POST") return { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.claim({ ...CLAIM_INPUT, placement: "above" });
    const putCall = calls.find((c) => c.method === "PUT");
    const newBody = (
      putCall?.body as { body: { storage: { value: string } } }
    ).body.storage.value;
    // Original content first, fence close at end of body.
    expect(newBody.indexOf(PRE_CLAIM_BODY)).toBeLessThan(
      newBody.indexOf("code2wiki:managed:end"),
    );
  });

  it("uses the cfg.label override (instead of default 'code2wiki') on the second label POST", async () => {
    const { fetch, calls } = mockFetch(({ method }) => {
      if (method === "GET") return { status: 200, body: makeGetResponse() };
      if (method === "PUT") return { status: 200, body: {} };
      if (method === "POST") return { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(
      { ...CFG, label: "custom-label" },
      { fetch },
    );
    await pub.claim(CLAIM_INPUT);
    const labelPosts = calls.filter(
      (c) => c.method === "POST" && c.url.includes("/label"),
    );
    expect((labelPosts[1]?.body as Array<{ name: string }>)[0]?.name).toBe(
      "custom-label",
    );
  });

  it("label-write failure with successful rollback throws a non-CLAIM_ABORTED 'rolled back' error", async () => {
    // CLAIM_ABORTED means wiki state is inconsistent. When rollback succeeds
    // the wiki page IS fully restored, so we surface a plain Error without
    // the code so the CLI does NOT emit a `claim_aborted` audit entry for
    // what is, from the customer's wiki's perspective, a no-op.
    let putCount = 0;
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (method === "GET") return { status: 200, body: makeGetResponse() };
      if (method === "PUT") {
        putCount++;
        // First PUT is the claim body-write (success); second is rollback (success).
        return { status: 200, body: {} };
      }
      if (method === "POST" && url.includes("/label")) {
        return { status: 500, body: { message: "label boom" } };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    let err: (Error & { code?: string }) | null = null;
    try {
      await pub.claim(CLAIM_INPUT);
    } catch (e) {
      err = e as Error & { code?: string };
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBeUndefined();
    expect(err?.message).toMatch(/rolled back/);
    expect(err?.message).toMatch(/label boom/);
    // 2 PUTs: forward claim body-write + rollback.
    expect(putCount).toBe(2);
    const rollbackPut = calls.filter((c) => c.method === "PUT")[1];
    const rollbackBody = (
      rollbackPut?.body as { body: { storage: { value: string } } }
    ).body.storage.value;
    // Rollback PUT carries the pre-claim body verbatim, wiki page is restored.
    expect(rollbackBody).toBe(PRE_CLAIM_BODY);
    // Rollback bumps version by 2 (one for the claim PUT, one for itself).
    expect(
      (rollbackPut?.body as { version: { number: number } }).version.number,
    ).toBe(7);
  });

  it("label-write failure with FAILED rollback throws CLAIM_ABORTED carrying both errors", async () => {
    // Rollback PUT itself failing means the wiki page is left in a partial
    // claim state (managed-fenced content but no c2w-* label). This is the
    // only path that should emit a `claim_aborted` audit entry, operators
    // need the audit-hash anchor to manually restore the page.
    let putCount = 0;
    const { fetch } = mockFetch(({ url, method }) => {
      if (method === "GET") return { status: 200, body: makeGetResponse() };
      if (method === "PUT") {
        putCount++;
        // First PUT (claim body-write) succeeds; second PUT (rollback) fails.
        if (putCount === 1) return { status: 200, body: {} };
        return { status: 502, body: { message: "rollback boom" } };
      }
      if (method === "POST" && url.includes("/label")) {
        return { status: 500, body: { message: "label boom" } };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, { fetch });
    let err: (Error & { code?: string }) | null = null;
    try {
      await pub.claim(CLAIM_INPUT);
    } catch (e) {
      err = e as Error & { code?: string };
    }
    expect(err).not.toBeNull();
    expect(err?.code).toBe("CLAIM_ABORTED");
    expect(err?.message).toMatch(/rollback also failed/);
    expect(err?.message).toMatch(/label boom/);
    expect(err?.message).toMatch(/rollback boom/);
    expect(putCount).toBe(2);
  });
});

// Pins the post-claim preservation contract on every subsequent publish:
// when a customer's BA appends notes AFTER the managed fence (claim mode's
// placement=below default leaves the original wiki content there permanently),
// the publisher MUST re-attach that trailing chunk to every PUT body. A
// regression dropping the merge step would silently overwrite the customer's
// hand-written content on the next code-change-driven regenerate. The function
// itself is not exported, so we exercise it through the publish() update path.
describe("ConfluencePublisher.publish, mergePreservedOutside", () => {
  const PAGE_ID = SAMPLE_PAGE.code2wiki_id;
  const FENCE_OPEN = `<!-- code2wiki:managed:start id=${PAGE_ID} -->`;
  const FENCE_CLOSE_TAG = "<!-- code2wiki:managed:end -->";

  // Build a search response whose first hit carries `body.storage.value`.
  // The publisher's update path calls findExistingPage with
  // `expand=version,body.storage`, so a realistic existing-page response
  // includes the stored XHTML.
  function searchHit(existingBody: string | undefined) {
    const result: Record<string, unknown> = {
      id: "claimed-1",
      type: "page",
      title: "Foo Bar Use Case",
      version: { number: 3 },
    };
    if (existingBody !== undefined) {
      result.body = { storage: { value: existingBody, representation: "storage" } };
    }
    return { results: [result] };
  }

  function setupForUpdate(existingBody: string | undefined) {
    return mockFetch(({ url, method }) => {
      if (url.includes("/rest/api/content/search")) {
        return { status: 200, body: searchHit(existingBody) };
      }
      if (method === "PUT" && url.includes("/rest/api/content/claimed-1")) {
        return {
          status: 200,
          body: {
            id: "claimed-1",
            type: "page",
            title: "Foo Bar Use Case",
            version: { number: 4 },
          },
        };
      }
      return { status: 404, body: {} };
    });
  }

  function putStorage(calls: RecordedCall[]): string {
    const putCall = calls.find((c) => c.method === "PUT");
    const body = putCall?.body as
      | { body?: { storage?: { value?: string } } }
      | undefined;
    return body?.body?.storage?.value ?? "";
  }

  it("preserves post-fence customer content from the existing page on every update", async () => {
    // Realistic post-claim shape: claim mode wrote banner + fence + new
    // managed body + <hr/> + customer's pre-claim original content. On the
    // NEXT publish (this code path), we replace the managed body but keep
    // the customer's trailing content intact.
    const trailing = `\n<hr/>\n<p>BA hand-written notes, see PROD-1234</p>`;
    const existingBody = `<p>📝 STALE Banner from a previous publish</p>\n${FENCE_OPEN}\n<h2>OBSOLETE managed body</h2>\n${FENCE_CLOSE_TAG}${trailing}`;
    const { fetch, calls } = setupForUpdate(existingBody);
    const pub = new ConfluencePublisher(CFG, { fetch });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("updated");
    const stored = putStorage(calls);
    // The trailing chunk lives at the very tail: `${newStorage}${after}`.
    // endsWith pins both that it's present AND that nothing leaked past it.
    expect(stored.endsWith(trailing)).toBe(true);
    // The pre-fence "before" region (the OLD banner that was already
    // rewritten on the previous publish) MUST NOT survive; only `after`
    // is preserved by mergePreservedOutside. A regression that returned
    // `${before}${newStorage}${after}` would double-banner the page and
    // confuse readers.
    expect(stored).not.toContain("STALE Banner");
    // Similarly, the OLD managed body (between fence-open and fence-close)
    // MUST NOT survive; it's replaced by the freshly-rendered body.
    expect(stored).not.toContain("OBSOLETE managed body");
    // And the new content from SAMPLE_PAGE.markdown landed.
    expect(stored).toContain("A quick test");
  });

  it("does not append anything when the existing page has no post-fence content", async () => {
    const existingBody = `<p>📝 Banner</p>\n${FENCE_OPEN}\n<h2>Old managed body</h2>\n${FENCE_CLOSE_TAG}`;
    const { fetch, calls } = setupForUpdate(existingBody);
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    const stored = putStorage(calls);
    // The stored body should NOT contain the old managed body, only the
    // freshly-rendered new banner+body. A regression that always concatenates
    // `existing.after` (without the trim short-circuit) would harmlessly
    // append "" here, but a regression that concatenates `existing.before` or
    // the whole body would leak the old <h2> into the PUT.
    expect(stored).not.toContain("Old managed body");
    expect(stored).toContain("A quick test"); // freshly-rendered SAMPLE_PAGE
  });

  it("treats whitespace-only post-fence content as empty (trim short-circuit)", async () => {
    // Newline + tab + spaces after the close marker would survive a naive
    // string concat. The `!after.trim()` guard at confluence.ts:649 short-
    // circuits this case so PUT body stays clean. Pin so a regression
    // dropping the trim (e.g. `if (!after.length)`) surfaces.
    const existingBody = `<p>Banner</p>\n${FENCE_OPEN}\nx\n${FENCE_CLOSE_TAG}\n\n\t  \n`;
    const { fetch, calls } = setupForUpdate(existingBody);
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    const stored = putStorage(calls);
    // No trailing tab+whitespace dump in the PUT body. Specifically, the
    // body should END with whatever the renderer produced for SAMPLE_PAGE,
    // not the whitespace from `existing.after`.
    expect(stored.endsWith("\n\n\t  \n")).toBe(false);
  });

  it("does not merge anything when the existing body has no managed fence at all", async () => {
    // A page that's labeled c2w-* (so findExistingPage returns it) but whose
    // body somehow lacks the fence (pathological customer rewrite, schema
    // drift, etc). `extractOutsideManagedRegion` returns
    // `{before: whole-body, after: ""}` in this case, so the trim guard
    // skips the merge. A regression that fell back to "the whole existing
    // body is preservable trailing content" would dump the entire foreign
    // page after our new content and double customer surprise.
    const existingBody = `<p>Some entirely unfenced legacy content the customer hand-wrote</p>\n<p>More of it</p>`;
    const { fetch, calls } = setupForUpdate(existingBody);
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    const stored = putStorage(calls);
    expect(stored).not.toContain("entirely unfenced legacy content");
    expect(stored).not.toContain("More of it");
    expect(stored).toContain("A quick test");
  });

  it("falls back to the new storage when the existing page response has no body.storage.value", async () => {
    // Existing page object returned by Confluence with no `body` key (the
    // expand parameter was dropped, or the API stripped it, or the page was
    // marked archived without body). The early `if (!existingBody) return
    // newStorageWithBanner` guard at confluence.ts:643 fires first; the
    // function never touches `extractOutsideManagedRegion`. Pin to ensure a
    // regression that read `existing.body!.storage.value` directly would
    // throw before we caught it.
    const { fetch, calls } = setupForUpdate(undefined);
    const pub = new ConfluencePublisher(CFG, { fetch });
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("updated");
    const stored = putStorage(calls);
    expect(stored).toContain("A quick test");
  });
});

describe("ConfluencePublisher.publish, ensureParallelParent (parallel mode)", () => {
  // ensureParallelParent is not exported; exercise it through publish() with
  // coexistence.mode='parallel'. The helper resolves the parent once before
  // the per-page loop and threads its id into createPage as ancestorId, so
  // assertions watch:
  //   (a) the parent-side findByTitle/POST traffic via the captured cql/title,
  //   (b) the customer-side createPage POST's body.ancestors[0].id.
  // The previous-iteration test at L144 covered ONLY the failure branch
  // (all-pages-skipped); the success branches (default segment / custom
  // segment / leading-slash strip / pre-set parentPageId short-circuit /
  // operator-pre-created reuse / titlePrefix-not-applied-to-parent) had zero
  // direct coverage despite being the ADR-016 parallel-mode contract every
  // parallel-mode customer hits on their first publish.

  // Build a parallel-mode fetch that:
  //   - returns the operator's existing parent page (or null) on the title
  //     search for `parentSearchTitle`,
  //   - returns null for every other findByTitle (collision check) and every
  //     findExistingPage (no managed customer page exists yet),
  //   - returns a freshly-created page record on each POST /rest/api/content,
  //     keying the returned id off the body.title so the test can tell
  //     parent-create apart from customer-create.
  function buildParallelFetch(opts: {
    existingParent?: { id: string; title: string } | null;
  }) {
    const existingParent = opts.existingParent ?? null;
    return mockFetch(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) {
        const cql = new URL(url).searchParams.get("cql") ?? "";
        // findByTitle for the parent: cql contains `title="<segment>"`. Match
        // by checking that cql carries title= AND NOT label= (findExistingPage
        // uses `label="c2w-..."`).
        if (existingParent && cql.includes(`title="${existingParent.title}"`)) {
          return {
            status: 200,
            body: {
              results: [
                {
                  id: existingParent.id,
                  type: "page",
                  title: existingParent.title,
                  version: { number: 3 },
                  metadata: { labels: { results: [] } }, // no c2w-* → kept
                },
              ],
            },
          };
        }
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        const title = (body as { title: string } | undefined)?.title ?? "(unknown)";
        // Stable, derivable id so assertions can pin the ancestor.
        const id = `created-${title.replace(/[^a-zA-Z0-9]/g, "-")}`;
        return {
          status: 200,
          body: {
            id,
            type: "page",
            title,
            version: { number: 1 },
            _links: { webui: `/spaces/DOCS/pages/${id}`, base: CFG.baseUrl },
          },
        };
      }
      return { status: 404, body: {} };
    });
  }

  // Pull out the parent-create POST from the captured calls: the customer
  // pages' POSTs have body.metadata.labels[0].name === "c2w-<customer-id>";
  // the parent's is `c2w-parallel-parent-<segment>`.
  function parentCreatePost(calls: RecordedCall[]): RecordedCall | undefined {
    return calls.find((c) => {
      if (c.method !== "POST" || !c.url.endsWith("/rest/api/content")) {
        return false;
      }
      const labels = (c.body as { metadata?: { labels?: { name: string }[] } } | undefined)
        ?.metadata?.labels;
      return labels?.some((l) => l.name.startsWith("c2w-parallel-parent-")) ?? false;
    });
  }

  function customerCreatePost(calls: RecordedCall[], code2wikiId: string): RecordedCall | undefined {
    return calls.find((c) => {
      if (c.method !== "POST" || !c.url.endsWith("/rest/api/content")) {
        return false;
      }
      const labels = (c.body as { metadata?: { labels?: { name: string }[] } } | undefined)
        ?.metadata?.labels;
      return labels?.some((l) => l.name === `c2w-${code2wikiId}`) ?? false;
    });
  }

  it("default slugPrefix → searches for parent titled 'code2wiki', creates it, parents the customer page under the new parent's id", async () => {
    // The default slugPrefix is "code2wiki/" → firstSegment = "code2wiki".
    // Pin (1) the search title, (2) the parent-create POST title equals the
    // raw firstSegment (NO titlePrefix even if one is configured, covered in
    // the dedicated case below), (3) the parent's code2wiki_id is the exact
    // synthetic id `parallel-parent-code2wiki` (downstream consumers may
    // dedupe on this), (4) the customer page POST carries ancestors[0].id
    // matching the parent-create response. A regression flipping the
    // default segment (e.g. to the customer's slug, or to the customer's
    // first slug segment) would silently re-parent every customer's docs
    // under a moving target.
    const { fetch, calls } = buildParallelFetch({ existingParent: null });
    const pub = new ConfluencePublisher(
      { ...CFG, coexistence: { mode: "parallel" } },
      { fetch },
    );
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("created");

    // Parent search: cql contains title="code2wiki".
    const parentSearch = calls.find(
      (c) =>
        c.url.includes("/rest/api/content/search") &&
        (new URL(c.url).searchParams.get("cql") ?? "").includes('title="code2wiki"'),
    );
    expect(parentSearch).toBeDefined();

    // Parent create: body.title === "code2wiki", labels include the synthetic id.
    const parentPost = parentCreatePost(calls);
    expect(parentPost).toBeDefined();
    const parentBody = parentPost!.body as {
      title: string;
      metadata: { labels: { name: string }[] };
      ancestors?: unknown;
    };
    expect(parentBody.title).toBe("code2wiki");
    expect(parentBody.metadata.labels.some((l) => l.name === "c2w-parallel-parent-code2wiki")).toBe(true);
    // Parent is created top-level (no ancestors), so it actually shows up in
    // the space root for the operator to find.
    expect(parentBody.ancestors).toBeUndefined();

    // Customer page POST: ancestors[0].id is the parent's created id.
    const customerPost = customerCreatePost(calls, SAMPLE_PAGE.code2wiki_id);
    expect(customerPost).toBeDefined();
    const customerBody = customerPost!.body as {
      ancestors?: { id: string }[];
    };
    expect(customerBody.ancestors?.[0]?.id).toBe("created-code2wiki");
  });

  it("custom slugPrefix 'auto/docs/' → firstSegment is 'auto' (only the first segment, NOT the full prefix)", async () => {
    // Pin the `prefix.split("/").filter(Boolean)[0]` semantic. A regression
    // joining the segments back (e.g. taking the whole 'auto/docs') would
    // produce a parent titled "auto/docs" which Confluence accepts as a
    // literal title, silently surprising the operator who'd expect a
    // simple "auto" parent.
    const { fetch, calls } = buildParallelFetch({ existingParent: null });
    const pub = new ConfluencePublisher(
      { ...CFG, coexistence: { mode: "parallel", slugPrefix: "auto/docs/" } },
      { fetch },
    );
    await pub.publish([SAMPLE_PAGE]);

    const parentPost = parentCreatePost(calls);
    expect(parentPost).toBeDefined();
    const parentBody = parentPost!.body as { title: string; metadata: { labels: { name: string }[] } };
    expect(parentBody.title).toBe("auto");
    expect(parentBody.metadata.labels.some((l) => l.name === "c2w-parallel-parent-auto")).toBe(true);
  });

  it("leading-slash slugPrefix '/foo/bar/' → leading slashes stripped, firstSegment is 'foo'", async () => {
    // Pin the `replace(/^\/+/, "")` strip step. A regression dropping the
    // strip would feed an empty first segment after split, fall through to
    // the `?? "code2wiki"` default, and silently parent customer pages
    // under "code2wiki" rather than the operator's intended "foo" hierarchy.
    const { fetch, calls } = buildParallelFetch({ existingParent: null });
    const pub = new ConfluencePublisher(
      { ...CFG, coexistence: { mode: "parallel", slugPrefix: "/foo/bar/" } },
      { fetch },
    );
    await pub.publish([SAMPLE_PAGE]);

    const parentPost = parentCreatePost(calls);
    expect(parentPost).toBeDefined();
    const parentBody = parentPost!.body as { title: string };
    expect(parentBody.title).toBe("foo");
  });

  it("cfg.parentPageId pre-set short-circuits: no parent title search, no parent POST, customer page parented to the configured id", async () => {
    // ensureParallelParent has two `if (cfg.parentPageId) return ...` checks
    //, the first under `!prefix` (slash-only after strip), the second after
    // firstSegment is resolved. Pin both by setting parentPageId alongside a
    // non-empty slugPrefix: the second guard fires BEFORE findByTitle runs.
    // A regression dropping the short-circuit would issue a redundant title
    // search every publish AND potentially create a duplicate parent if the
    // operator's preferred parent didn't match the firstSegment title.
    const { fetch, calls } = buildParallelFetch({ existingParent: null });
    const pub = new ConfluencePublisher(
      { ...CFG, parentPageId: "OPERATOR-PARENT-42", coexistence: { mode: "parallel" } },
      { fetch },
    );
    await pub.publish([SAMPLE_PAGE]);

    // No parent title search, the only searches should be the per-page
    // label search (findExistingPage by `c2w-<id>`). Decode each cql and
    // assert NONE contains title="code2wiki".
    const titleSearches = calls.filter(
      (c) =>
        c.url.includes("/rest/api/content/search") &&
        (new URL(c.url).searchParams.get("cql") ?? "").includes('title="'),
    );
    expect(titleSearches).toHaveLength(0);

    // No parent POST.
    expect(parentCreatePost(calls)).toBeUndefined();

    // Customer page parented to the pre-set id, not to a created parent.
    const customerPost = customerCreatePost(calls, SAMPLE_PAGE.code2wiki_id);
    expect(customerPost).toBeDefined();
    const customerBody = customerPost!.body as { ancestors?: { id: string }[] };
    expect(customerBody.ancestors?.[0]?.id).toBe("OPERATOR-PARENT-42");
  });

  it("operator-pre-created parent (matching title, no c2w-* labels) is reused: NO parent POST, customer page parented to the existing id", async () => {
    // Pin the findByTitle-returns-existing branch. The operator manually
    // created a "code2wiki" page in the space before turning on parallel
    // mode; the parent search returns it; ensureParallelParent reuses the
    // id and skips POST. A regression that ignored the existing result
    // would create a duplicate "code2wiki" page on the SAME space root
    // every publish, polluting the operator's space. (Re-use only works
    // when the existing page has NO c2w-* labels, findByTitle filters
    // c2w-* labeled results since those are managed pages, NOT containers.)
    const { fetch, calls } = buildParallelFetch({
      existingParent: { id: "OPERATOR-CREATED-99", title: "code2wiki" },
    });
    const pub = new ConfluencePublisher(
      { ...CFG, coexistence: { mode: "parallel" } },
      { fetch },
    );
    await pub.publish([SAMPLE_PAGE]);

    expect(parentCreatePost(calls)).toBeUndefined();
    const customerPost = customerCreatePost(calls, SAMPLE_PAGE.code2wiki_id);
    expect(customerPost).toBeDefined();
    const customerBody = customerPost!.body as { ancestors?: { id: string }[] };
    expect(customerBody.ancestors?.[0]?.id).toBe("OPERATOR-CREATED-99");
  });

  it("second-run reuse: parent labeled c2w-parallel-parent-<segment> from a prior parallel publish is reused via findExistingPage, NO parent POST", async () => {
    // Regression guard against the silent-duplicate-parent bug: on the FIRST
    // parallel publish ensureParallelParent creates the parent and labels it
    // with c2w-parallel-parent-<segment> + code2wiki. On EVERY subsequent
    // publish, the helper must find that same labeled parent and reuse it.
    // findByTitle filters out c2w-* labeled results (since they're managed
    // pages, not containers), so the title-only lookup never sees our own
    // parent; a label-keyed findExistingPage MUST run first. A regression
    // dropping the label lookup would create a fresh "code2wiki" sibling
    // every publish; Confluence rejects same-title siblings and fails
    // parent setup, skipping every page in the batch on the second-onward
    // publishes.
    const calls: RecordedCall[] = [];
    const fn = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (url.includes("/rest/api/content/search")) {
        const cql = new URL(url).searchParams.get("cql") ?? "";
        // findExistingPage by the parent's synthetic label: return the
        // previously-created parent.
        if (cql.includes('label="c2w-parallel-parent-code2wiki"')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: "PRIOR-RUN-PARENT-77",
                  type: "page",
                  title: "code2wiki",
                  version: { number: 4 },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Every other lookup (per-page findExistingPage, any title search)
        // returns empty so the customer page goes through the create path
        // and we'd notice if a stray findByTitle for "code2wiki" leaked
        // through (a title= search would NOT match the labeled branch
        // above and would fall here).
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        const title = (body as { title: string } | undefined)?.title ?? "(unknown)";
        const id = `created-${title.replace(/[^a-zA-Z0-9]/g, "-")}`;
        return new Response(
          JSON.stringify({
            id,
            type: "page",
            title,
            version: { number: 1 },
            _links: { webui: `/spaces/DOCS/pages/${id}`, base: CFG.baseUrl },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const pub = new ConfluencePublisher(
      { ...CFG, coexistence: { mode: "parallel" } },
      { fetch: fn },
    );
    const [result] = await pub.publish([SAMPLE_PAGE]);
    expect(result?.outcome).toBe("created");

    // The label-keyed lookup ran (defended against by the bug fix).
    const labeledSearch = calls.find(
      (c) =>
        c.url.includes("/rest/api/content/search") &&
        (new URL(c.url).searchParams.get("cql") ?? "").includes(
          'label="c2w-parallel-parent-code2wiki"',
        ),
    );
    expect(labeledSearch).toBeDefined();

    // NO parent POST; labeled lookup hit and we reused.
    expect(parentCreatePost(calls)).toBeUndefined();

    // Customer page parented to the previously-created parent's id.
    const customerPost = customerCreatePost(calls, SAMPLE_PAGE.code2wiki_id);
    expect(customerPost).toBeDefined();
    const customerBody = customerPost!.body as { ancestors?: { id: string }[] };
    expect(customerBody.ancestors?.[0]?.id).toBe("PRIOR-RUN-PARENT-77");

    // Label lookup short-circuits BEFORE findByTitle, so a redundant title
    // search MUST NOT fire; a regression order-flipping the two lookups
    // would issue an extra round trip per publish and (worse) re-create
    // the parent if findByTitle returned null first.
    const titleSearch = calls.find(
      (c) =>
        c.url.includes("/rest/api/content/search") &&
        (new URL(c.url).searchParams.get("cql") ?? "").includes('title="code2wiki"'),
    );
    expect(titleSearch).toBeUndefined();
  });

  it("titlePrefix NEVER applies to the parent (only the customer page), protects parent-find continuity across runs", async () => {
    // The createPage invocation for the parent passes `{ ...cfg, coexistence: undefined }`
    // explicitly so effectiveTitle returns the raw firstSegment. A regression
    // dropping the `coexistence: undefined` spread would title-prefix the
    // parent, and worse, on the NEXT publish, findByTitle would search for
    // the un-prefixed firstSegment "code2wiki" and not find the prefixed
    // "[DOCS] code2wiki" parent, creating yet another parent every run.
    // Customer page title MUST still be prefixed as the companion pin,
    // otherwise we'd be regressing the titlePrefix feature wholesale.
    const { fetch, calls } = buildParallelFetch({ existingParent: null });
    const pub = new ConfluencePublisher(
      {
        ...CFG,
        coexistence: { mode: "parallel", titlePrefix: "[DOCS]" },
      },
      { fetch },
    );
    await pub.publish([SAMPLE_PAGE]);

    // Parent search uses un-prefixed segment.
    const parentSearch = calls.find(
      (c) =>
        c.url.includes("/rest/api/content/search") &&
        (new URL(c.url).searchParams.get("cql") ?? "").includes('title="code2wiki"'),
    );
    expect(parentSearch).toBeDefined();
    // No search for the prefixed parent title.
    const prefixedParentSearch = calls.find(
      (c) =>
        c.url.includes("/rest/api/content/search") &&
        (new URL(c.url).searchParams.get("cql") ?? "").includes('title="[DOCS] code2wiki"'),
    );
    expect(prefixedParentSearch).toBeUndefined();

    // Parent-create title is the un-prefixed segment.
    const parentPost = parentCreatePost(calls);
    expect(parentPost).toBeDefined();
    expect((parentPost!.body as { title: string }).title).toBe("code2wiki");

    // Customer page IS title-prefixed (companion regression guard).
    const customerPost = customerCreatePost(calls, SAMPLE_PAGE.code2wiki_id);
    expect(customerPost).toBeDefined();
    expect((customerPost!.body as { title: string }).title).toBe("[DOCS] Foo Bar Use Case");
  });
});

// createPage's POST body carries metadata.labels which Confluence stores on the
// new page. The label set is the upsert key for every subsequent publish (via
// findExistingPage's `label="c2w-<id>"` CQL) and is also how tag-faceted search
// works in the customer's space. The composition is load-bearing:
//   (1) `c2w-<code2wiki_id>`: the canonical upsert key
//   (2) `cfg.label ?? "code2wiki"`: tenant-style marker, configurable per
//       installation so multi-team customers can co-exist
//   (3) optional `c2w-tag-<lowercase>` per tag, gated by `/^[a-z0-9-]+$/i`
//
// Failure modes a regression would surface to customers:
// - Sending a tag with a space / dot / underscore / non-ASCII char would 400
//   the Confluence label API and skip the entire publish for the page (label
//   validation is server-side and strict); the regex is the gate.
// - Forgetting toLowerCase() would let a customer's "Java" tag and "java" tag
//   create two siblings in the label index, fragmenting tag-facet search.
// - Dropping cfg.label override would re-tag every page in a multi-team
//   installation under "code2wiki" and break the team's existing label-based
//   page filters.
describe("ConfluencePublisher.createPage label payload", () => {
  // Capture metadata.labels[] from the create POST body for a single-page
  // publish. Search returns empty -> publish() falls into the createPage
  // branch -> the POST to /rest/api/content carries the labels we want to pin.
  function captureCreatePost() {
    let createBody: unknown = null;
    const { fetch } = mockFetch(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) {
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        createBody = body;
        return {
          status: 200,
          body: {
            id: "new-1",
            type: "page",
            title: "captured",
            version: { number: 1 },
            _links: { webui: "/spaces/DOCS/pages/new-1", base: CFG.baseUrl },
          },
        };
      }
      return { status: 404, body: {} };
    });
    return {
      fetch,
      getLabels: () => {
        const b = createBody as { metadata?: { labels?: { name: string }[] } } | null;
        return b?.metadata?.labels?.map((l) => l.name) ?? [];
      },
    };
  }

  it("default config emits exactly [c2w-<id>, 'code2wiki'] when tags array is empty", async () => {
    // Two-label minimum: a regression dropping either base label silently
    // breaks upsert (the c2w-<id> label is the entire mechanism findExistingPage
    // looks for) or breaks tenant attribution (the second label is how
    // operators identify code2wiki-managed pages in their label browser).
    const { fetch, getLabels } = captureCreatePost();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([{ ...SAMPLE_PAGE, tags: [] }]);
    expect(getLabels()).toEqual(["c2w-java-foo-bar-v1", "code2wiki"]);
  });

  it("cfg.label override replaces 'code2wiki' on the second label slot", async () => {
    // A multi-team customer running `code2wiki` for two products will pass
    // cfg.label = "team-payments" on one install and "team-billing" on the
    // other so each team's label browser shows only their own managed pages.
    // A regression hardcoding "code2wiki" instead of `cfg.label ?? "code2wiki"`
    // would collapse the two installs back to a single shared label.
    const cfg = { ...CFG, label: "team-payments" };
    const { fetch, getLabels } = captureCreatePost();
    const pub = new ConfluencePublisher(cfg, { fetch });
    await pub.publish([{ ...SAMPLE_PAGE, tags: [] }]);
    expect(getLabels()).toEqual(["c2w-java-foo-bar-v1", "team-payments"]);
    expect(getLabels()).not.toContain("code2wiki");
  });

  it("valid tags become c2w-tag-<lowercased>, mixed case input collapses to one canonical label", async () => {
    // "Java", "JAVA", "java" are the same tag semantically. Confluence labels
    // are case-insensitive at lookup but case-preserving at storage; without
    // toLowerCase() three callers could create three siblings in the label
    // index (`c2w-tag-Java`, `c2w-tag-JAVA`, `c2w-tag-java`), fragmenting
    // tag-facet search in the operator's space.
    const { fetch, getLabels } = captureCreatePost();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([{ ...SAMPLE_PAGE, tags: ["Java", "Spring-Boot"] }]);
    expect(getLabels()).toEqual([
      "c2w-java-foo-bar-v1",
      "code2wiki",
      "c2w-tag-java",
      "c2w-tag-spring-boot",
    ]);
  });

  it("tags with disallowed characters are filtered out, not sent to the label API", async () => {
    // Confluence's label endpoint rejects spaces, dots, slashes, underscores,
    // @-signs, and non-ASCII characters server-side with a 400. The regex
    // `/^[a-z0-9-]+$/i` is the client-side gate that prevents one bad tag
    // from killing the whole publish for the page. Underscore is NOT in the
    // allow-set: if Confluence ever relaxes its server-side rule, dropping a
    // valid customer tag is the safer side of the trade than 400-ing the
    // entire publish. Empty string is also caught by the `+` quantifier.
    const tags = [
      "foo bar",   // space
      "foo.bar",   // dot
      "foo/bar",   // slash
      "foo_bar",   // underscore (NOT in [a-z0-9-])
      "foo@bar",   // @-sign
      "café",      // non-ASCII (é fails [a-z0-9-] even with /i)
      "",          // empty
    ];
    const { fetch, getLabels } = captureCreatePost();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([{ ...SAMPLE_PAGE, tags }]);
    // Only the two base labels survive; no c2w-tag-* labels emitted.
    expect(getLabels()).toEqual(["c2w-java-foo-bar-v1", "code2wiki"]);
    expect(getLabels().some((l) => l.startsWith("c2w-tag-"))).toBe(false);
  });

  it("hyphens, digits, and digit-only tags are preserved verbatim (besides toLowerCase)", async () => {
    // "java-17", "v2", "123" are all valid label segments. A regression
    // tightening the regex to `/^[a-z]+$/i` (alphabetical-only) would drop
    // every versioned tag, the single most common kind of tag in a Java/CFML
    // codebase's docs ("java-17", "node-20", "spring-boot-3").
    const tags = ["java-17", "v2", "123", "a-b-c", "x"];
    const { fetch, getLabels } = captureCreatePost();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([{ ...SAMPLE_PAGE, tags }]);
    expect(getLabels()).toEqual([
      "c2w-java-foo-bar-v1",
      "code2wiki",
      "c2w-tag-java-17",
      "c2w-tag-v2",
      "c2w-tag-123",
      "c2w-tag-a-b-c",
      "c2w-tag-x",
    ]);
  });

  it("mixed valid + invalid tags preserves input order of valid ones and drops invalid ones", async () => {
    // Order preservation matters because operators eyeball the label browser
    // for primary classification. A regression sorting or reversing the tags
    // would shuffle the most-significant-first convention the renderer emits.
    // Mixed-case still toLowerCase'd; the filter does NOT short-circuit on
    // the first invalid (every tag is independently tested).
    const tags = ["valid-one", "INVALID TAG", "Valid-Two", "bad.tag", "x", "y_z", "Z"];
    const { fetch, getLabels } = captureCreatePost();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([{ ...SAMPLE_PAGE, tags }]);
    expect(getLabels()).toEqual([
      "c2w-java-foo-bar-v1",
      "code2wiki",
      "c2w-tag-valid-one",
      "c2w-tag-valid-two",
      "c2w-tag-x",
      "c2w-tag-z",
    ]);
  });
});

describe("ConfluencePublisher.updatePage PUT body", () => {
  // Capture the body + URL of the PUT that follows a label-search hit. The
  // update path is the regenerate hot loop: every customer's existing managed
  // pages flow through PUT on every publish, so contract drift here silently
  // breaks every regenerate.
  function captureUpdatePut(opts: {
    existingId?: string;
    existingTitle?: string;
    existingVersion?: number;
  } = {}) {
    const existingId = opts.existingId ?? "existing-1";
    const existingTitle = opts.existingTitle ?? "Foo Bar Use Case";
    const existingVersion = opts.existingVersion ?? 7;
    let putBody: unknown = null;
    let putUrl: string | null = null;
    let putMethod: string | null = null;
    const { fetch } = mockFetch(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) {
        return {
          status: 200,
          body: {
            results: [
              {
                id: existingId,
                type: "page",
                title: existingTitle,
                version: { number: existingVersion },
              },
            ],
          },
        };
      }
      if (method === "PUT" && url.includes(`/rest/api/content/${existingId}`)) {
        putBody = body;
        putUrl = url;
        putMethod = method;
        return {
          status: 200,
          body: { id: existingId, type: "page", title: existingTitle, version: { number: existingVersion + 1 } },
        };
      }
      return { status: 404, body: {} };
    });
    return {
      fetch,
      getBody: () => putBody as Record<string, unknown> | null,
      getUrl: () => putUrl,
      getMethod: () => putMethod,
    };
  }

  it("PUT body has NO labels field at any level", async () => {
    // The update path intentionally does NOT carry labels in the PUT body:
    // labels are set ONCE at createPage time (and at claim time via a separate
    // addLabel POST). A regression that re-added metadata.labels here would
    // either 400 on duplicate label submission, or silently double-write the
    // label set on every regenerate, polluting the label index. Pin against
    // labels appearing at the top level, under metadata, or nested under body.
    const { fetch, getBody } = captureUpdatePut();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    const body = getBody();
    expect(body).not.toBeNull();
    expect(body).not.toHaveProperty("labels");
    expect(body).not.toHaveProperty("metadata");
    const bodyField = body?.body as { metadata?: unknown } | undefined;
    expect(bodyField?.metadata).toBeUndefined();
  });

  it("version.number is exactly existing.version.number + 1", async () => {
    // Confluence requires monotonic version increments; a stale or off-by-one
    // value rejects the PUT with 409 Conflict and surfaces as a publish error
    // for every customer on first re-publish after the regression lands.
    // Use a non-trivial starting version (7) so a regression that hard-coded
    // version 1 or 2 wouldn't accidentally pass.
    const { fetch, getBody } = captureUpdatePut({ existingVersion: 7 });
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect((getBody()?.version as { number: number }).number).toBe(8);
  });

  it("PUT URL routes to /rest/api/content/<existing.id>, not <page.code2wiki_id>", async () => {
    // The URL must use Confluence's internal page id (from the search result),
    // NOT our code2wiki_id. A regression deriving the URL from page.code2wiki_id
    // would 404 on every regenerate because Confluence has no knowledge of our
    // synthetic id. existing-1 is the search-result id; SAMPLE_PAGE.code2wiki_id
    // is "java-foo-bar-v1", divergent enough that a slip is unambiguous.
    const { fetch, getUrl, getMethod } = captureUpdatePut({ existingId: "existing-1" });
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect(getMethod()).toBe("PUT");
    expect(getUrl()).toBe(`${CFG.baseUrl}/rest/api/content/existing-1`);
    expect(getUrl()).not.toContain("java-foo-bar-v1");
  });

  it("body.storage.representation is exactly 'storage' (not 'wiki' or 'view')", async () => {
    // Confluence accepts three representations: storage (XHTML; what we emit),
    // wiki (legacy markup), and view (rendered HTML; read-only on PUT). A
    // regression slipping to "wiki" would render every page as literal escaped
    // XHTML; a slip to "view" would 400-fail the PUT outright.
    const { fetch, getBody } = captureUpdatePut();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    const storage = (getBody()?.body as { storage: { representation: string; value: string } }).storage;
    expect(storage.representation).toBe("storage");
    expect(typeof storage.value).toBe("string");
    expect(storage.value.length).toBeGreaterThan(0);
  });

  it("title respects coexistence.titlePrefix on the UPDATE path, not just on create", async () => {
    // The createPage and updatePage paths each call effectiveTitle independently.
    // The existing happy-path PUT test (L89 "updates an existing page") asserts
    // title equality but only with the bare page.title, never with titlePrefix.
    // A refactor that inlined `page.title` directly into the PUT body (while
    // keeping effectiveTitle on createPage) would freeze every existing page
    // at its pre-prefix title the moment a customer enabled titlePrefix; new
    // pages would get the prefix, existing pages would not (visible drift).
    const cfg = { ...CFG, coexistence: { mode: "greenfield" as const, titlePrefix: "[DOCS]" } };
    const { fetch, getBody } = captureUpdatePut();
    const pub = new ConfluencePublisher(cfg, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect(getBody()?.title).toBe("[DOCS] Foo Bar Use Case");
  });

  it("space.key tracks cfg.spaceKey, not hardcoded", async () => {
    // The PUT body carries space.key from cfg.spaceKey, not a hardcoded
    // value. A regression hardcoding "DOCS" (the test CFG value) would
    // silently pass every test in this file while breaking every customer
    // whose space key happens to differ. Pin against a literal "DOCS" slip
    // by configuring a clearly distinct space key here.
    const cfg = { ...CFG, spaceKey: "TEAM-PAYMENTS" };
    const { fetch, getBody } = captureUpdatePut();
    const pub = new ConfluencePublisher(cfg, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    expect((getBody()?.space as { key: string }).key).toBe("TEAM-PAYMENTS");
  });
});

describe("ConfluencePublisher.buildStorageWithBanner composition", () => {
  // buildStorageWithBanner (confluence.ts:147) composes every page Confluence
  // sees: `${banner}\n${body}`. Banner-first, single newline separator, marked
  // body verbatim. The helper itself is not exported, but the composition is
  // observable via body.storage.value on the POST that createPage emits. Pin
  // the contract here so a regression silently re-ordering or re-escaping the
  // composition (any of which would visibly corrupt every customer's pages)
  // surfaces as a unit failure, not a production incident.
  function captureCreatePostStorage() {
    let createBody: unknown = null;
    const { fetch } = mockFetch(({ url, method, body }) => {
      if (url.includes("/rest/api/content/search")) {
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        createBody = body;
        return {
          status: 200,
          body: {
            id: "new-1",
            type: "page",
            title: "captured",
            version: { number: 1 },
            _links: { webui: "/spaces/DOCS/pages/new-1", base: CFG.baseUrl },
          },
        };
      }
      return { status: 404, body: {} };
    });
    return {
      fetch,
      getStorageValue: () => {
        const b = createBody as
          | { body?: { storage?: { value?: string } } }
          | null;
        return b?.body?.storage?.value ?? null;
      },
    };
  }

  it("storage.value starts with the banner's <ac:structured-macro ...>, not the body's <h2>", async () => {
    // ADR-016 requires the attribution banner to be the FIRST thing a reader
    // sees on the page. A regression that flipped the composition to
    // `${body}\n${banner}` would push attribution below the use-case content,
    // and customers (BAs, auditors) would read the use case before realizing
    // it was generated. Defensive negative against starting with the body's
    // leading <h2> tag.
    const { fetch, getStorageValue } = captureCreatePostStorage();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    const value = getStorageValue();
    expect(value).not.toBeNull();
    expect(value!.startsWith(
      '<ac:structured-macro ac:name="info" ac:schema-version="1">',
    )).toBe(true);
    expect(value!.startsWith("<h2")).toBe(false);
  });

  it("storage.value ends with the marked body's last block, not a trailing banner", async () => {
    // SAMPLE_PAGE.markdown ends `A quick test.\n`, which marked renders into
    // `<p>A quick test.</p>\n` as the final byte run. A regression appending
    // a banner footer, a signature, or any boilerplate after the body would
    // leak hidden content into every customer page. Defensive negative against
    // ending with `</ac:structured-macro>` (banner-after-body regression).
    const { fetch, getStorageValue } = captureCreatePostStorage();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    const value = getStorageValue();
    expect(value!.endsWith("<p>A quick test.</p>\n")).toBe(true);
    expect(value!.endsWith("</ac:structured-macro>")).toBe(false);
  });

  it("exactly one '\\n' between banner close and body open, not '\\n\\n' or no separator", async () => {
    // Single-newline separator is the literal template (`${banner}\n${body}`).
    // A slip to `\n\n` would inject an empty paragraph in Confluence's rendered
    // output (visible vertical gap above the heading). Dropping the separator
    // entirely would either fuse banner+body into a single block or fail
    // Confluence's storage parser depending on the adjacent tags. Pin both via
    // strict regex; the explicit </ac:structured-macro>\n<h2 substring is the
    // strongest ordering+separator+boundary check available without exact-
    // string-equality (which would be brittle to marked's exact output shape).
    const { fetch, getStorageValue } = captureCreatePostStorage();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    const value = getStorageValue()!;
    expect(value).toMatch(/<\/ac:structured-macro>\n<h2/);
    expect(value).not.toMatch(/<\/ac:structured-macro>\n\n/);
    expect(value).not.toMatch(/<\/ac:structured-macro><h2/);
  });

  it("body is the verbatim marked output, NOT XML-escaped", async () => {
    // The banner uses escapeXml() because its repoName / sourceLink / iso are
    // interpolated as text into XHTML attribute values. The body, in contrast,
    // is already XHTML (marked.parse output) and must pass through unescaped
    // or Confluence will render every page as literal `&lt;h2&gt;Summary&lt;/h2&gt;`
    // back to the user; the page would look like raw source code. A regression
    // that copy-pasted the banner's escapeXml call onto the body would surface
    // here. Pin both the positive (raw <h2> appears) and the negative (escaped
    // forms do NOT appear, including the doubled `&amp;lt;` form a careless
    // double-escape would produce).
    const { fetch, getStorageValue } = captureCreatePostStorage();
    const pub = new ConfluencePublisher(CFG, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    const value = getStorageValue()!;
    expect(value).toContain("<h2");
    expect(value).toContain("Summary");
    expect(value).toContain("<p>A quick test.</p>");
    expect(value).not.toContain("&lt;h2");
    expect(value).not.toContain("&lt;p&gt;");
    expect(value).not.toContain("&amp;lt;");
  });

  it("banner repoName flows from coexistence config, NOT the publish() 'your-repo' fallback", async () => {
    // publish() resolves repoName as `this.cfg.coexistence?.banner?.repoName ?? "your-repo"`
    // (confluence.ts:392). The fallback exists so the banner is never empty,
    // but in any real customer setup the cfg should override it. A regression
    // that dropped the config-derived repoName (e.g., a refactor extracting a
    // helper that ignored cfg.coexistence) would silently brand every customer's
    // banner as "your-repo"; visibly wrong attribution. Pin the cfg value
    // appears AND "your-repo" does NOT (since SAMPLE_PAGE.markdown contains no
    // "your-repo" substring, the negative is a clean defensive negative).
    const cfg = {
      ...CFG,
      coexistence: {
        mode: "greenfield" as const,
        banner: {
          repoName: "team-payments-monolith",
          now: () => "2024-01-15T10:00:00.000Z",
        },
      },
    };
    const { fetch, getStorageValue } = captureCreatePostStorage();
    const pub = new ConfluencePublisher(cfg, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    const value = getStorageValue()!;
    expect(value).toContain("team-payments-monolith");
    expect(value).not.toContain("your-repo");
    expect(value).toContain("Last synced: 2024-01-15T10:00:00.000Z");
  });

  it("commitUrlTemplate + commit resolves to permalink, NOT to repoUrl fallback", async () => {
    // resolveBannerInputs picks the sourceLink via: commitUrlTemplate + commit
    // wins (commit permalink, immutable); else repoUrl (mutable repo root);
    // else "https://example.invalid/${repoName}" placeholder. The first branch
    // is the load-bearing one for replay / forensics: operators need to know
    // which commit a wiki page was generated from. A regression that flipped
    // the branch order (or ignored commitUrlTemplate) would point every "View
    // source" link at the repo root, losing the commit hash. Pin: the resolved
    // permalink appears in the banner href; the repoUrl-fallback string and
    // the example.invalid placeholder do NOT.
    const cfg = {
      ...CFG,
      coexistence: {
        mode: "greenfield" as const,
        banner: {
          repoName: "team-payments-monolith",
          repoUrl: "https://github.com/acme/team-payments-monolith",
          commitUrlTemplate:
            "https://github.com/acme/team-payments-monolith/commit/{commit}",
          commit: "abc123def456",
          now: () => "2024-01-15T10:00:00.000Z",
        },
      },
    };
    const { fetch, getStorageValue } = captureCreatePostStorage();
    const pub = new ConfluencePublisher(cfg, { fetch });
    await pub.publish([SAMPLE_PAGE]);
    const value = getStorageValue()!;
    expect(value).toContain(
      'href="https://github.com/acme/team-payments-monolith/commit/abc123def456"',
    );
    // The href is on the permalink, not the repoUrl fallback. Both URLs share
    // a prefix, so the bare repoUrl quoted as an href would be a regression:
    // the slash-closed `commit/...` form must win.
    expect(value).not.toMatch(
      /href="https:\/\/github\.com\/acme\/team-payments-monolith"/,
    );
    expect(value).not.toContain("example.invalid");
  });
});

// Pins the constructor wiring that wraps opts.fetch with withRetry(...) AND
// forwards opts.retry verbatim. The retry helper itself is unit-tested in
// retry.test.ts (23 cases); these tests pin that ConfluencePublisher actually
// applies the wrapper at the seam every publish() goes through, and that the
// `retry` option exposed for tests/operator-tuning is reachable.
//
// Two regression surfaces:
//
//   A. Drop withRetry entirely (e.g. `this.fetchImpl = opts.fetch ?? fetch`).
//      Every 429 on findExistingPage / createPage / updatePage / findByTitle
//      throws on the first attempt and surfaces as outcome="skipped". Customers
//      hitting a transient Atlassian rate-limit would lose the whole batch.
//
//   B. Drop the opts.retry forwarding (e.g. `withRetry(opts.fetch ?? fetch)`).
//      Default 5 attempts + setTimeout-based sleep would still work in prod,
//      but the test seam disappears: tests can no longer inject deterministic
//      jitter/sleep, and an operator-supplied `retry.maxAttempts` knob would
//      silently no-op.
describe("ConfluencePublisher: 429 retry wiring", () => {
  it("retries 429 on findExistingPage via withRetry, then succeeds (pins constructor wrap + sleep/jitter forwarding)", async () => {
    // Sequence: search 429 -> search 200 (empty) -> POST 200 (created).
    // Without the constructor wrap, the first 429 throws and the publish
    // outcome flips from "created" to "skipped".
    let searchCalls = 0;
    const sleepDelays: number[] = [];
    const { fetch, calls } = mockFetch(({ url, method }) => {
      if (url.includes("/rest/api/content/search")) {
        searchCalls++;
        if (searchCalls === 1) return { status: 429, body: {} };
        return { status: 200, body: { results: [] } };
      }
      if (method === "POST" && url.endsWith("/rest/api/content")) {
        return {
          status: 200,
          body: {
            id: "new-page-retry-1",
            type: "page",
            title: "Foo Bar Use Case",
            version: { number: 1 },
            _links: { webui: "/spaces/DOCS/pages/new-page-retry-1", base: CFG.baseUrl },
          },
        };
      }
      return { status: 404, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, {
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
    // Wrap fired: retry succeeded, outcome is "created" not "skipped".
    expect(result?.outcome).toBe("created");
    expect(result?.externalId).toBe("new-page-retry-1");
    // Two search calls (first 429, second 200) prove withRetry hit the
    // injected fetch on retry, not the global fetch.
    expect(searchCalls).toBe(2);
    // Sleep was called exactly once between the two attempts. With jitter=0
    // and baseDelayMs=0 the delay computes to 0ms; a regression dropping the
    // opts.retry forwarding would default to setTimeout-based sleep and our
    // tracker would stay empty.
    expect(sleepDelays).toEqual([0]);
    // POST fired exactly once (create path); no double-create from a stray
    // 429 retry leaking into the mutation endpoint.
    const posts = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/rest/api/content"),
    );
    expect(posts).toHaveLength(1);
  });

  it("opts.retry.maxAttempts=1 is forwarded: a sustained 429 hard-fails without retry (pins maxAttempts forwarding)", async () => {
    // Sequence: search 429 always. With maxAttempts=1 the wrapper makes one
    // attempt, returns the 429, and findExistingPage throws.
    let searchCalls = 0;
    const sleepDelays: number[] = [];
    const { fetch } = mockFetch(({ url }) => {
      if (url.includes("/rest/api/content/search")) {
        searchCalls++;
        return { status: 429, body: { message: "rate limited" } };
      }
      return { status: 500, body: {} };
    });
    const pub = new ConfluencePublisher(CFG, {
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
    // Exactly ONE call to the upstream. A regression dropping the
    // opts.retry forwarding would default to maxAttempts=5 and we'd see 5.
    expect(searchCalls).toBe(1);
    // No sleeps fire when maxAttempts=1 (sleeps go BETWEEN attempts).
    expect(sleepDelays).toEqual([]);
    // The final 429 from the wrapper surfaces through the existing error
    // path verbatim, an operator log scraper depending on "Confluence search
    // failed: 429" still works after the wrap was added.
    expect(result?.message).toContain("Confluence search failed: 429");
  });
});
