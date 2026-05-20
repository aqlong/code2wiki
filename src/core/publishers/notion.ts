import { transformFootnotes } from "./footnotes.js";
import {
  type PageInput,
  type PublishResult,
  type Publisher,
  type CoexistenceConfig,
  type PublishMode,
  buildNotionBannerBlock,
  resolveBannerInputs,
} from "./types.js";
import {
  type Preflighter,
  type PreflightResult,
  type PreflightEntry,
  summarize,
  suggestClaim,
} from "./preflight.js";
import { withRetry, type RetryOptions } from "./retry.js";

export interface NotionConfig {
  /** Internal integration token from notion.so/my-integrations. */
  apiToken: string;
  /** Database ID where pages will be created. The integration must
   *  be shared with this database. */
  databaseId: string;
  /** Notion API version, e.g. "2022-06-28". Defaults to a recent stable. */
  apiVersion?: string;
  /** ADR-016 coexistence configuration. */
  coexistence?: CoexistenceConfig;
}

const NOTION_API = "https://api.notion.com/v1";
const DEFAULT_API_VERSION = "2022-06-28";

interface NotionPage {
  id: string;
  url: string;
  archived: boolean;
  properties?: Record<string, unknown>;
}

interface NotionQueryResponse {
  results: NotionPage[];
}

interface NotionBlock {
  id: string;
  type: string;
  archived?: boolean;
  has_children?: boolean;
  // Block payload (callout, paragraph, etc.) varies by type.
  [key: string]: unknown;
}

function authHeaders(cfg: NotionConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.apiToken}`,
    "Notion-Version": cfg.apiVersion ?? DEFAULT_API_VERSION,
    "Content-Type": "application/json",
  };
}

function effectiveMode(cfg: NotionConfig): PublishMode {
  return cfg.coexistence?.mode ?? "greenfield";
}

function effectiveTitle(cfg: NotionConfig, page: PageInput): string {
  const prefix = cfg.coexistence?.titlePrefix?.trim();
  return prefix ? `${prefix} ${page.title}` : page.title;
}

/** First segment of "auto/docs/" -> "auto"; "code2wiki/" -> "code2wiki". */
function sectionForParallel(cfg: NotionConfig): string | null {
  if (effectiveMode(cfg) !== "parallel") return null;
  const prefix = (cfg.coexistence?.slugPrefix ?? "code2wiki/").replace(
    /^\/+/,
    "",
  );
  // For Notion, we surface the FULL slug-prefix path as the Section
  // property's value (no parent-page hierarchy concept here).
  return prefix.replace(/\/+$/, "") || "code2wiki";
}

/**
 * Find an existing page by code2wiki_id.
 *
 * The Notion database must have a Rich Text property named
 * "code2wiki_id": `code2wiki publish` checks this on first run and
 * helpfully prints the schema if it's missing.
 */
async function findByCode2wikiId(
  cfg: NotionConfig,
  code2wikiId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotionPage | null> {
  const res = await fetchImpl(
    `${NOTION_API}/databases/${cfg.databaseId}/query`,
    {
      method: "POST",
      headers: authHeaders(cfg),
      body: JSON.stringify({
        filter: {
          property: "code2wiki_id",
          rich_text: { equals: code2wikiId },
        },
        page_size: 1,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Notion query failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as NotionQueryResponse;
  return data.results[0] ?? null;
}

/** Find by exact title in the configured database. */
async function findByTitle(
  cfg: NotionConfig,
  title: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotionPage | null> {
  const res = await fetchImpl(
    `${NOTION_API}/databases/${cfg.databaseId}/query`,
    {
      method: "POST",
      headers: authHeaders(cfg),
      body: JSON.stringify({
        filter: {
          property: "Name",
          title: { equals: title },
        },
        page_size: 5,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Notion title query failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as NotionQueryResponse;
  // Filter out pages that already have a code2wiki_id (those are managed).
  for (const page of data.results) {
    const props = page.properties ?? {};
    const idProp = props["code2wiki_id"] as
      | { rich_text?: Array<{ plain_text?: string }> }
      | undefined;
    const text = idProp?.rich_text?.[0]?.plain_text ?? "";
    if (!text.trim()) return page;
  }
  return null;
}

/**
 * Convert Markdown to Notion blocks. Implements a pragmatic subset:
 * headings (h1-h3), paragraphs, bullet lists, numbered lists, code
 * fences, and quotes. Everything else degrades to paragraph text.
 */
export function markdownToNotionBlocks(markdown: string): unknown[] {
  // Pandoc-style footnotes pre-transform: convert `[^id]` to plain `[N]`
  // and collect definitions into a `## Footnotes` section at the end.
  // The block converter is line-based and doesn't understand GFM footnotes;
  // without this transform, `[^step1]: ...` lines became their own paragraph
  // blocks and refs leaked into the body as literal `[^step1]`.
  let transformed = transformFootnotes(markdown);

  // HTML comments are invisible in Confluence's storage XHTML but Notion's
  // rich_text has no comment concept, so without stripping them they leak
  // into customer-visible page text. The fence markers
  // (`<!-- code2wiki:managed:start … -->` / `… end -->`) are NOT load-bearing
  // for Notion (per ADR-013 the Notion update strategy is archive-children-
  // then-append, no fence-based boundary detection). Safe to drop entirely.
  transformed = transformed.replace(/<!--[\s\S]*?-->/g, "");

  // `<details><summary>X</summary>Y</details>` is valid HTML that Confluence
  // renders as a collapsible block. Notion has no native equivalent, so
  // without rewriting we'd render `<details>` and `<summary>` as literal
  // text. Convert to a heading_3 (the summary text) + the inner content,
  // which renders cleanly in both Notion and Confluence (Confluence sees
  // the rewritten markdown via marked).
  transformed = transformed.replace(
    /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g,
    (_, summary: string, inner: string) =>
      `\n### ${summary.trim()}\n${inner.trim()}\n`,
  );

  const blocks: unknown[] = [];
  const lines = transformed.split("\n");
  let i = 0;

  const richText = (text: string) => [{ type: "text", text: { content: text } }];

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("# ")) {
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: { rich_text: richText(line.slice(2)) },
      });
      i++;
    } else if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: richText(line.slice(3)) },
      });
      i++;
    } else if (line.startsWith("### ")) {
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: richText(line.slice(4)) },
      });
      i++;
    } else if (/^- /.test(line)) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: richText(line.slice(2)) },
      });
      i++;
    } else if (/^\d+\. /.test(line)) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: richText(line.replace(/^\d+\.\s+/, "")) },
      });
      i++;
    } else if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "plain text";
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++; // consume closing fence
      blocks.push({
        object: "block",
        type: "code",
        code: {
          rich_text: richText(code.join("\n")),
          language: lang,
        },
      });
    } else if (line.startsWith("> ")) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: richText(line.slice(2)) },
      });
      i++;
    } else if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      // Markdown horizontal rule -> Notion divider block.
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++;
    } else if (line.trim() === "") {
      i++;
    } else {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: richText(line) },
      });
      i++;
    }
  }
  return blocks;
}

/** Strip frontmatter from the markdown body. */
function bodyMarkdown(page: PageInput): string {
  return page.markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** Properties payload for create / update. */
function propertiesFor(
  cfg: NotionConfig,
  page: PageInput,
): Record<string, unknown> {
  const title = effectiveTitle(cfg, page);
  const props: Record<string, unknown> = {
    Name: { title: [{ text: { content: title } }] },
    code2wiki_id: { rich_text: [{ text: { content: page.code2wiki_id } }] },
  };
  const section = sectionForParallel(cfg);
  if (section) {
    props["Section"] = { rich_text: [{ text: { content: section } }] };
  }
  return props;
}

async function createPage(
  cfg: NotionConfig,
  page: PageInput,
  bannerBlock: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<NotionPage> {
  const blocks = markdownToNotionBlocks(bodyMarkdown(page));
  const res = await fetchImpl(`${NOTION_API}/pages`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({
      parent: { database_id: cfg.databaseId },
      properties: propertiesFor(cfg, page),
      // Banner is the first block. The rest are the generated content.
      children: [bannerBlock, ...blocks],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Notion create failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as NotionPage;
}

async function listChildren(
  cfg: NotionConfig,
  parentId: string,
  fetchImpl: typeof fetch,
): Promise<NotionBlock[]> {
  const all: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`${NOTION_API}/blocks/${parentId}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);
    const res = await fetchImpl(url.toString(), {
      headers: authHeaders(cfg),
    });
    if (!res.ok) {
      throw new Error(
        `Notion list-children failed: ${res.status} ${await res.text()}`,
      );
    }
    const data = (await res.json()) as {
      results: NotionBlock[];
      has_more?: boolean;
      next_cursor?: string;
    };
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

async function archiveBlock(
  cfg: NotionConfig,
  blockId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  await fetchImpl(`${NOTION_API}/blocks/${blockId}`, {
    method: "DELETE",
    headers: authHeaders(cfg),
  });
}

async function appendChildren(
  cfg: NotionConfig,
  parentId: string,
  children: unknown[],
  fetchImpl: typeof fetch,
  after?: string,
): Promise<void> {
  const body: Record<string, unknown> = { children };
  if (after) body["after"] = after;
  const res = await fetchImpl(`${NOTION_API}/blocks/${parentId}/children`, {
    method: "PATCH",
    headers: authHeaders(cfg),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Notion append failed: ${res.status} ${await res.text()}`,
    );
  }
}

/**
 * Detect a claimed-style page: structure is [banner callout, ..generated.., divider, ..originals..].
 * If a divider exists at root, treat it as the claim separator and preserve
 * everything from the divider onward.
 */
function findClaimSeparator(children: NotionBlock[]): {
  bannerIdx: number;
  separatorIdx: number;
} | null {
  // We expect: banner at 0 (callout with our emoji), then blocks, then divider.
  if (!children.length) return null;
  const bannerIdx = children.findIndex(
    (b) =>
      b.type === "callout" &&
      ((b.callout as { icon?: { emoji?: string } } | undefined)?.icon?.emoji ===
        "📝"),
  );
  if (bannerIdx < 0) return null;
  const separatorIdx = children.findIndex(
    (b, i) => i > bannerIdx && b.type === "divider",
  );
  if (separatorIdx < 0) return null;
  return { bannerIdx, separatorIdx };
}

/**
 * Update an existing page's body. Two paths:
 *  - Greenfield: archive all children, append [banner, ...generated].
 *  - Claimed (divider exists): archive blocks between banner and divider,
 *    PATCH the banner block in place, append new generated content with
 *    `after: banner_id` so it goes BETWEEN banner and divider.
 */
async function replacePageBody(
  cfg: NotionConfig,
  existing: NotionPage,
  page: PageInput,
  bannerBlock: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const blocks = markdownToNotionBlocks(bodyMarkdown(page));
  const children = await listChildren(cfg, existing.id, fetchImpl);
  const claimed = findClaimSeparator(children);

  if (claimed) {
    // Archive old generated content (banner stays; will be PATCHed).
    const banner = children[claimed.bannerIdx]!;
    for (let i = claimed.bannerIdx + 1; i < claimed.separatorIdx; i++) {
      await archiveBlock(cfg, children[i]!.id, fetchImpl);
    }
    // PATCH the banner block in place with new banner content.
    await fetchImpl(`${NOTION_API}/blocks/${banner.id}`, {
      method: "PATCH",
      headers: authHeaders(cfg),
      body: JSON.stringify({
        callout: (bannerBlock as { callout: unknown }).callout,
      }),
    });
    // Insert new generated blocks after the banner (so they sit before the
    // divider). Per Notion docs, `after` inserts AFTER the named block.
    if (blocks.length) {
      await appendChildren(cfg, existing.id, blocks, fetchImpl, banner.id);
    }
  } else {
    // Greenfield path: nuke + repaint.
    for (const child of children) {
      await archiveBlock(cfg, child.id, fetchImpl);
    }
    await appendChildren(
      cfg,
      existing.id,
      [bannerBlock, ...blocks],
      fetchImpl,
    );
  }

  // Always update properties (title may have changed; titlePrefix may apply).
  await fetchImpl(`${NOTION_API}/pages/${existing.id}`, {
    method: "PATCH",
    headers: authHeaders(cfg),
    body: JSON.stringify({ properties: propertiesFor(cfg, page) }),
  });
}

export class NotionPublisher implements Publisher, Preflighter {
  readonly name = "notion";
  readonly dryRun: boolean;
  private fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: NotionConfig,
    opts: {
      dryRun?: boolean;
      fetch?: typeof fetch;
      /** Override retry behaviour. Test-only; production callers
       *  should accept the defaults (5 attempts, 500ms base, 60s cap,
       *  respect Retry-After). */
      retry?: RetryOptions;
    } = {},
  ) {
    this.dryRun = opts.dryRun ?? false;
    // Wrap once at construction so every fetchImpl-bearing helper
    // (queryDatabase, listChildren, archiveBlock, appendChildren,
    // createPage, etc.) automatically gets 429 backoff with zero
    // call-site changes. Single wiring point matches confluence.ts.
    this.fetchImpl = withRetry(opts.fetch ?? fetch, opts.retry);
  }

  /** Preflight scan. */
  async preflight(pages: PageInput[]): Promise<PreflightResult> {
    const mode = effectiveMode(this.cfg);
    const entries: PreflightEntry[] = [];
    for (const page of pages) {
      const title = effectiveTitle(this.cfg, page);
      const labeled = await findByCode2wikiId(
        this.cfg,
        page.code2wiki_id,
        this.fetchImpl,
      );
      if (labeled) {
        // Title-drift detection: compare title-property to expected title.
        const props = labeled.properties ?? {};
        const titleProp = props["Name"] as
          | { title?: Array<{ plain_text?: string }> }
          | undefined;
        const labeledTitle = titleProp?.title?.[0]?.plain_text ?? "";
        const drift =
          labeledTitle && labeledTitle.toLowerCase() !== title.toLowerCase();
        entries.push({
          code2wiki_id: page.code2wiki_id,
          title,
          slug: page.slug,
          outcome: drift ? "renamed" : "managed",
          existing: {
            external_id: labeled.id,
            url: labeled.url,
            title: labeledTitle || undefined,
            match_reason: "label",
          },
        });
        continue;
      }
      const collision = await findByTitle(this.cfg, title, this.fetchImpl);
      if (collision) {
        entries.push({
          code2wiki_id: page.code2wiki_id,
          title,
          slug: page.slug,
          outcome: "collision",
          existing: {
            external_id: collision.id,
            url: collision.url,
            match_reason: "title_exact_ci",
          },
          suggested_action: suggestClaim(
            this.name,
            page.code2wiki_id,
            collision.id,
          ),
        });
        continue;
      }
      entries.push({
        code2wiki_id: page.code2wiki_id,
        title,
        slug: page.slug,
        outcome: "clean",
      });
    }
    return {
      generated_at: new Date().toISOString(),
      target: this.name,
      mode,
      summary: summarize(entries),
      entries,
    };
  }

  async publish(pages: PageInput[]): Promise<PublishResult[]> {
    const results: PublishResult[] = [];
    const repoName = this.cfg.coexistence?.banner?.repoName ?? "your-repo";
    const commit = this.cfg.coexistence?.banner?.commit;

    for (const page of pages) {
      try {
        if (this.dryRun) {
          const existing = await findByCode2wikiId(
            this.cfg,
            page.code2wiki_id,
            this.fetchImpl,
          );
          results.push({
            page,
            outcome: existing ? "updated" : "created",
            externalId: existing?.id,
            message: "(dry run; no changes made)",
          });
          continue;
        }

        const bannerBlock = buildNotionBannerBlock(
          resolveBannerInputs(this.cfg.coexistence, { repoName, commit }),
        );
        const existing = await findByCode2wikiId(
          this.cfg,
          page.code2wiki_id,
          this.fetchImpl,
        );
        if (existing) {
          await replacePageBody(
            this.cfg,
            existing,
            page,
            bannerBlock,
            this.fetchImpl,
          );
          results.push({
            page,
            outcome: "updated",
            externalId: existing.id,
            url: existing.url,
          });
        } else {
          const created = await createPage(
            this.cfg,
            page,
            bannerBlock,
            this.fetchImpl,
          );
          results.push({
            page,
            outcome: "created",
            externalId: created.id,
            url: created.url,
          });
        }
      } catch (e) {
        results.push({
          page,
          outcome: "skipped",
          message: (e as Error).message,
        });
      }
    }
    return results;
  }

  /**
   * Claim an existing Notion page. Archives all current children, then
   * appends [banner, ...empty managed region marker, divider, ...replays
   * of original blocks]. Sets the code2wiki_id property.
   *
   * Returns SHA-256 of the pre-claim children JSON (informational; not
   * part of audit-chain integrity).
   */
  async claim(input: {
    pageId: string;
    code2wiki_id: string;
    placement: "above" | "below";
    title: string;
    repoName: string;
    commit?: string;
    now?: () => string;
  }): Promise<{ external_id: string; pre_claim_content_hash: string; url?: string }> {
    const fetchImpl = this.fetchImpl;
    // Get the page to check it isn't already managed.
    const pageRes = await fetchImpl(`${NOTION_API}/pages/${input.pageId}`, {
      headers: authHeaders(this.cfg),
    });
    if (!pageRes.ok) {
      throw new Error(
        `Notion get-page failed: ${pageRes.status} ${await pageRes.text()}`,
      );
    }
    const page = (await pageRes.json()) as NotionPage;
    const props = page.properties ?? {};
    const idProp = props["code2wiki_id"] as
      | { rich_text?: Array<{ plain_text?: string }> }
      | undefined;
    const idText = idProp?.rich_text?.[0]?.plain_text ?? "";
    if (idText.trim()) {
      throw new Error(
        `page already managed (code2wiki_id=${idText}); use 'code2wiki audit show' to inspect history`,
      );
    }

    // Capture pre-claim children for the hash + replay.
    const originalChildren = await listChildren(this.cfg, input.pageId, fetchImpl);
    const replays = originalChildren.map(stripReadonlyBlock);
    const crypto = await import("node:crypto");
    const preClaimHash =
      "sha256:" +
      crypto
        .createHash("sha256")
        .update(JSON.stringify(originalChildren), "utf-8")
        .digest("hex");

    // Archive every existing child.
    for (const child of originalChildren) {
      await archiveBlock(this.cfg, child.id, fetchImpl);
    }

    const bannerBlock = buildNotionBannerBlock(
      resolveBannerInputs(this.cfg.coexistence, {
        repoName: input.repoName,
        commit: input.commit,
      }),
    );
    const separator = { object: "block", type: "divider", divider: {} };
    const newChildren =
      input.placement === "above"
        ? [bannerBlock, ...replays, separator]
        : [bannerBlock, separator, ...replays];

    try {
      await appendChildren(this.cfg, input.pageId, newChildren, fetchImpl);
      // Set the code2wiki_id property (this is the "label" for Notion).
      const setProps = await fetchImpl(`${NOTION_API}/pages/${input.pageId}`, {
        method: "PATCH",
        headers: authHeaders(this.cfg),
        body: JSON.stringify({
          properties: {
            code2wiki_id: {
              rich_text: [{ text: { content: input.code2wiki_id } }],
            },
          },
        }),
      });
      if (!setProps.ok) {
        throw new Error(
          `Notion set-property failed: ${setProps.status} ${await setProps.text()}`,
        );
      }
    } catch (claimErr) {
      const err = new Error(
        `claim aborted: ${(claimErr as Error).message}. Original blocks were archived; recover via Notion's trash if needed.`,
      );
      (err as Error & { code?: string }).code = "CLAIM_ABORTED";
      throw err;
    }

    return {
      external_id: page.id,
      pre_claim_content_hash: preClaimHash,
      url: page.url,
    };
  }
}

/**
 * Strip read-only fields from a Notion block so it can be re-POSTed as a
 * new child. Notion's API rejects fields like id, created_time, parent,
 * archived, has_children, last_edited_*. Some block types (`unsupported`,
 * `child_database`, `child_page`) cannot be recreated this way; we drop
 * them with an inline note.
 */
function stripReadonlyBlock(block: NotionBlock): unknown {
  const type = block.type;
  if (
    type === "unsupported" ||
    type === "child_database" ||
    type === "child_page"
  ) {
    return {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: `[code2wiki claim could not preserve a '${type}' block; see Notion trash for the original]`,
            },
          },
        ],
      },
    };
  }
  const payload = block[type] as Record<string, unknown> | undefined;
  return {
    object: "block",
    type,
    ...(payload ? { [type]: payload } : {}),
  };
}
