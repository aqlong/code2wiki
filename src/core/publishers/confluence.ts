import { Marked } from "marked";
import { transformFootnotes } from "./footnotes.js";
import {
  type PageInput,
  type PublishResult,
  type Publisher,
  type CoexistenceConfig,
  type PublishMode,
  buildConfluenceBanner,
  resolveBannerInputs,
  extractOutsideManagedRegion,
  stripFrontmatter,
  FENCE_OPEN_PREFIX,
  FENCE_CLOSE,
} from "./types.js";
import {
  type Preflighter,
  type PreflightResult,
  type PreflightEntry,
  summarize,
  suggestClaim,
} from "./preflight.js";
import { withRetry, type RetryOptions } from "./retry.js";

export interface ConfluenceConfig {
  /** e.g. https://yourorg.atlassian.net/wiki */
  baseUrl: string;
  /** Atlassian account email (used as Basic auth username). */
  email: string;
  /** Atlassian API token from id.atlassian.com/manage-profile/security/api-tokens */
  apiToken: string;
  /** Space key (e.g. "ENG", "DOCS"). */
  spaceKey: string;
  /** Optional parent page ID, if set, every code2wiki page is created
   *  under this parent. Recommended: a page literally called "code2wiki". */
  parentPageId?: string;
  /** Optional label applied to every published page (default: "code2wiki"). */
  label?: string;
  /** ADR-016 coexistence configuration. */
  coexistence?: CoexistenceConfig;
}

interface ConfluenceContentResponse {
  id: string;
  type: string;
  title: string;
  version: { number: number };
  body?: { storage?: { value?: string } };
  metadata?: { labels?: { results?: Array<{ name: string }> } };
  _links?: { webui?: string; base?: string };
}

interface ConfluenceSearchResponse {
  results: ConfluenceContentResponse[];
}

/** Build a HTTP-Basic auth header for the Atlassian REST API. */
function authHeader(cfg: ConfluenceConfig): string {
  const token = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64");
  return `Basic ${token}`;
}

function effectiveMode(cfg: ConfluenceConfig): PublishMode {
  return cfg.coexistence?.mode ?? "greenfield";
}

function effectiveTitle(cfg: ConfluenceConfig, page: PageInput): string {
  const prefix = cfg.coexistence?.titlePrefix?.trim();
  return prefix ? `${prefix} ${page.title}` : page.title;
}

/** Look up by code2wiki_id label (the existing managed-page lookup). */
async function findExistingPage(
  cfg: ConfluenceConfig,
  code2wikiId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConfluenceContentResponse | null> {
  const cql = `space="${cfg.spaceKey}" AND label="c2w-${code2wikiId}"`;
  const url = new URL(`${cfg.baseUrl}/rest/api/content/search`);
  url.searchParams.set("cql", cql);
  url.searchParams.set("expand", "version,body.storage");
  url.searchParams.set("limit", "1");
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: authHeader(cfg), Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Confluence search failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as ConfluenceSearchResponse;
  return data.results[0] ?? null;
}

/** Look up a page in the configured space by exact title (case-insensitive
 *  via Confluence's "title=" CQL, case-insensitive by default). */
async function findByTitle(
  cfg: ConfluenceConfig,
  title: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConfluenceContentResponse | null> {
  const cql = `space="${cfg.spaceKey}" AND type=page AND title="${title.replace(/"/g, '\\"')}"`;
  const url = new URL(`${cfg.baseUrl}/rest/api/content/search`);
  url.searchParams.set("cql", cql);
  url.searchParams.set("expand", "version");
  url.searchParams.set("limit", "5");
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: authHeader(cfg), Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Confluence title search failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as ConfluenceSearchResponse;
  // Filter out anything that already has a c2w-* label, those are our own
  // managed pages and are handled by findExistingPage.
  for (const r of data.results) {
    const labels = r.metadata?.labels?.results ?? [];
    const isOurs = labels.some((l) => l.name.startsWith("c2w-"));
    if (!isOurs) return r;
  }
  return null;
}

/**
 * Confluence storage format is XHTML. marked's default renderer passes raw
 * HTML through verbatim, which means an LLM-quoted `<user>` or `<cfif>` in
 * prose would emit invalid XHTML and Confluence would reject the publish
 * with a 400. We escape every raw-HTML token except for two intentional
 * shapes the rest of the pipeline depends on:
 *
 *   - HTML comments (the `<!-- code2wiki:managed:start/end -->` fence and
 *     any other balanced comment), which mergePreservedOutside scans for
 *     by literal substring.
 *   - The `<details>` / `<summary>` block emitted by renderer.ts for the
 *     collapsible "Source links" section.
 *
 * Anything else (mismatched tags, unknown tags, attribute-bearing tags) is
 * escaped to its `&lt;…&gt;` text form. Code spans and fenced code never
 * reach this path; marked tokenises them as `codespan`/`code` tokens which
 * are already entity-escaped by the default renderer.
 */
const HTML_TAG_OR_COMMENT_RE = /<!--[\s\S]*?-->|<[^>]*>/g;
const SAFE_HTML_FRAGMENT_RE =
  /^(?:<!--[\s\S]*?-->|<\/?(?:details|summary)(?:\s[^>]*)?>)$/;

function isSafeHtmlToken(text: string): boolean {
  let cursor = 0;
  for (const m of text.matchAll(HTML_TAG_OR_COMMENT_RE)) {
    const between = text.slice(cursor, m.index);
    if (/[<>]/.test(between)) return false;
    if (!SAFE_HTML_FRAGMENT_RE.test(m[0])) return false;
    cursor = m.index + m[0].length;
  }
  if (/[<>]/.test(text.slice(cursor))) return false;
  return true;
}

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHtmlTokenSafely(text: string): string {
  if (isSafeHtmlToken(text)) return text;
  return escapeHtmlText(text);
}

const confluenceMarked = new Marked({
  renderer: {
    html({ text }) {
      return renderHtmlTokenSafely(text);
    },
  },
});

/**
 * Render Markdown to a small subset of Confluence "storage" XHTML.
 * Confluence's storage format is XHTML with custom macros, but for our
 * use case (use-case docs), plain XHTML is sufficient. Code blocks and
 * tables render as standard HTML; Confluence accepts them.
 */
export function markdownToConfluenceStorage(markdown: string): string {
  // Pandoc-style footnotes pre-transform: convert `[^id]` refs to plain
  // `[N]` and collect definitions into a `## Footnotes` section at the
  // end. marked doesn't handle GFM footnotes natively. See
  // src/core/publishers/footnotes.ts for the rules.
  const html = confluenceMarked.parse(transformFootnotes(markdown), {
    async: false,
  }) as string;
  return html;
}

/**
 * Compose the storage payload the publisher actually sends:
 *   [banner]
 *   [rendered managed body, including the fence comments]
 *
 * The fence is preserved inside the storage so future publishers can find
 * the managed region; Confluence's renderer hides HTML comments so the
 * reader only sees the banner + content.
 *
 * In claim mode, the publisher will also append the preserved-original
 * "outside" region, but that only happens once at claim time and is
 * stored in the page body permanently, not re-stamped on every publish.
 */
function buildStorageWithBanner(
  cfg: ConfluenceConfig,
  page: PageInput,
  resolveDefaults: { repoName: string; commit?: string },
): string {
  const banner = buildConfluenceBanner(
    resolveBannerInputs(cfg.coexistence, resolveDefaults),
  );
  // Strip leading YAML frontmatter so its keys don't render as visible body
  // text. Mirrors the Notion publisher's bodyMarkdown(); both share
  // stripFrontmatter() so the two paths can't diverge again.
  const body = markdownToConfluenceStorage(stripFrontmatter(page.markdown));
  return `${banner}\n${body}`;
}

/** Create a brand-new page under the configured (or parallel-resolved) parent. */
async function createPage(
  cfg: ConfluenceConfig,
  page: PageInput,
  storage: string,
  ancestorId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ConfluenceContentResponse> {
  const body = {
    type: "page",
    title: effectiveTitle(cfg, page),
    space: { key: cfg.spaceKey },
    ancestors: ancestorId ? [{ id: ancestorId }] : undefined,
    body: { storage: { value: storage, representation: "storage" } },
    metadata: {
      labels: [
        { name: `c2w-${page.code2wiki_id}` },
        { name: cfg.label ?? "code2wiki" },
        ...page.tags
          .filter((t) => /^[a-z0-9-]+$/i.test(t))
          .map((name) => ({ name: `c2w-tag-${name.toLowerCase()}` })),
      ],
    },
  };
  const res = await fetchImpl(`${cfg.baseUrl}/rest/api/content`, {
    method: "POST",
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Confluence create failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as ConfluenceContentResponse;
}

/** Update an existing page in place (incrementing the version number). */
async function updatePage(
  cfg: ConfluenceConfig,
  existing: ConfluenceContentResponse,
  page: PageInput,
  storage: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConfluenceContentResponse> {
  const body = {
    id: existing.id,
    type: "page",
    title: effectiveTitle(cfg, page),
    space: { key: cfg.spaceKey },
    body: { storage: { value: storage, representation: "storage" } },
    version: { number: existing.version.number + 1 },
  };
  const res = await fetchImpl(`${cfg.baseUrl}/rest/api/content/${existing.id}`, {
    method: "PUT",
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Confluence update failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as ConfluenceContentResponse;
}

/**
 * In `parallel` mode, find or create a parent page named after the first
 * segment of the configured slug prefix (default "code2wiki"). Subsequent
 * pages are nested under it so we don't pollute the customer's space root.
 */
async function ensureParallelParent(
  cfg: ConfluenceConfig,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const prefix = (cfg.coexistence?.slugPrefix ?? "code2wiki/").replace(
    /^\/+/,
    "",
  );
  if (!prefix) return cfg.parentPageId;
  // First segment of "auto/docs/" -> "auto"; "code2wiki/" -> "code2wiki".
  const firstSegment = prefix.split("/").filter(Boolean)[0] ?? "code2wiki";
  // Reuse a directly-configured parent if the customer pinned one.
  if (cfg.parentPageId) return cfg.parentPageId;
  // A parent we created on a prior parallel publish carries the synthetic
  // `c2w-parallel-parent-<segment>` label. findByTitle filters out c2w-*
  // labeled results, so the label-based lookup MUST happen first; otherwise
  // every Nth (N≥2) parallel publish creates a duplicate parent, which
  // Confluence rejects as a same-title sibling and fails parent setup.
  const labeled = await findExistingPage(
    cfg,
    `parallel-parent-${firstSegment}`,
    fetchImpl,
  );
  if (labeled) return labeled.id;
  // Fall back to a title match for the case where an operator manually
  // created a parent BEFORE turning on parallel mode (no c2w-* labels).
  const existing = await findByTitle(cfg, firstSegment, fetchImpl);
  if (existing) return existing.id;
  const created = await createPage(
    { ...cfg, coexistence: undefined }, // don't title-prefix the parent
    {
      code2wiki_id: `parallel-parent-${firstSegment}`,
      title: firstSegment,
      slug: firstSegment,
      markdown: `<!-- code2wiki parallel-mode parent page for slug prefix '${prefix}' -->`,
      tags: [],
    },
    `<p>Auto-generated docs from code2wiki live under this page.</p>`,
    undefined,
    fetchImpl,
  );
  return created.id;
}

/** Add a label to an existing page. */
async function addLabel(
  cfg: ConfluenceConfig,
  pageId: string,
  label: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl(
    `${cfg.baseUrl}/rest/api/content/${pageId}/label`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader(cfg),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify([{ prefix: "global", name: label }]),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Confluence add-label failed: ${res.status} ${await res.text()}`,
    );
  }
}

export class ConfluencePublisher implements Publisher, Preflighter {
  readonly name = "confluence";
  readonly dryRun: boolean;
  private fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: ConfluenceConfig,
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
    // Wrap once at construction so every module helper that receives
    // `this.fetchImpl` (findExistingPage, findByTitle, createPage,
    // updatePage, ensureParallelParent, addLabel, etc.) automatically
    // benefits from 429 backoff. Single wiring point, zero call-site
    // changes, mirrors how the cache_control flag is set once at the
    // top of extractWithLLM.
    this.fetchImpl = withRetry(opts.fetch ?? fetch, opts.retry);
  }

  /**
   * Preflight scan: classify each page as clean/managed/collision/renamed
   * against the destination space. Read-only, no writes.
   */
  async preflight(pages: PageInput[]): Promise<PreflightResult> {
    const mode = effectiveMode(this.cfg);
    const entries: PreflightEntry[] = [];
    for (const page of pages) {
      const title = effectiveTitle(this.cfg, page);
      const labeled = await findExistingPage(
        this.cfg,
        page.code2wiki_id,
        this.fetchImpl,
      );
      if (labeled) {
        const drift = labeled.title.toLowerCase() !== title.toLowerCase();
        entries.push({
          code2wiki_id: page.code2wiki_id,
          title,
          slug: page.slug,
          outcome: drift ? "renamed" : "managed",
          existing: {
            external_id: labeled.id,
            title: labeled.title,
            url: confluencePageUrl(this.cfg, labeled),
            match_reason: "label",
          },
        });
        continue;
      }
      // No label, check title.
      const collision = await findByTitle(this.cfg, title, this.fetchImpl);
      if (collision) {
        entries.push({
          code2wiki_id: page.code2wiki_id,
          title,
          slug: page.slug,
          outcome: "collision",
          existing: {
            external_id: collision.id,
            title: collision.title,
            url: confluencePageUrl(this.cfg, collision),
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
    const mode = effectiveMode(this.cfg);
    const repoName = this.cfg.coexistence?.banner?.repoName ?? "your-repo";
    const commit = this.cfg.coexistence?.banner?.commit;

    let ancestor = this.cfg.parentPageId;
    if (mode === "parallel" && !this.dryRun) {
      try {
        ancestor = await ensureParallelParent(this.cfg, this.fetchImpl);
      } catch (e) {
        // Parent failure is fatal for parallel mode, return early so we
        // don't pollute the space root with un-parented pages.
        return pages.map((page) => ({
          page,
          outcome: "skipped" as const,
          message: `parallel-parent setup failed: ${(e as Error).message}`,
        }));
      }
    }

    for (const page of pages) {
      try {
        if (this.dryRun) {
          const existing = await findExistingPage(
            this.cfg,
            page.code2wiki_id,
            this.fetchImpl,
          );
          results.push({
            page,
            outcome: existing ? "updated" : "created",
            externalId: existing?.id,
            message: "(dry run, no changes made)",
          });
          continue;
        }

        const storage = buildStorageWithBanner(this.cfg, page, {
          repoName,
          commit,
        });
        const existing = await findExistingPage(
          this.cfg,
          page.code2wiki_id,
          this.fetchImpl,
        );
        if (existing) {
          // Claim path: rebuild storage to preserve any pre-claim outside
          // content that was stored in the page body.
          const merged = mergePreservedOutside(existing, storage);
          const updated = await updatePage(
            this.cfg,
            existing,
            page,
            merged,
            this.fetchImpl,
          );
          results.push({
            page,
            outcome: "updated",
            externalId: updated.id,
            url: this.urlFor(updated),
          });
        } else {
          const created = await createPage(
            this.cfg,
            page,
            storage,
            ancestor,
            this.fetchImpl,
          );
          results.push({
            page,
            outcome: "created",
            externalId: created.id,
            url: this.urlFor(created),
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
   * Claim an existing hand-written page. Rewrites the body to:
   *   [banner] [fence open] [empty] [fence close] [separator] [original]
   * (or the `above` variant) and adds the c2w-<id> label.
   *
   * Returns the SHA-256 of the pre-claim body for the audit trail and the
   * external page id.
   */
  async claim(input: {
    pageId: string;
    code2wiki_id: string;
    placement: "above" | "below";
    title: string;
    repoName: string;
    commit?: string;
    /** Test seam for deterministic banner timestamps. */
    now?: () => string;
  }): Promise<{ external_id: string; pre_claim_content_hash: string; url?: string }> {
    const fetchImpl = this.fetchImpl;
    // Fetch pre-claim body.
    const getRes = await fetchImpl(
      `${this.cfg.baseUrl}/rest/api/content/${input.pageId}?expand=body.storage,version,metadata.labels,space`,
      {
        headers: {
          Authorization: authHeader(this.cfg),
          Accept: "application/json",
        },
      },
    );
    if (!getRes.ok) {
      throw new Error(
        `Confluence get-page failed: ${getRes.status} ${await getRes.text()}`,
      );
    }
    const existing = (await getRes.json()) as ConfluenceContentResponse & {
      space?: { key: string };
    };
    // Reject if already labeled by us.
    const labels = existing.metadata?.labels?.results ?? [];
    if (labels.some((l) => l.name.startsWith("c2w-"))) {
      throw new Error(
        `page already managed (label ${labels.find((l) => l.name.startsWith("c2w-"))?.name}); use 'code2wiki audit show' to inspect history`,
      );
    }
    // Reject if not in our configured space.
    if (existing.space && existing.space.key !== this.cfg.spaceKey) {
      throw new Error(
        `page is in space '${existing.space.key}' but configured space is '${this.cfg.spaceKey}'`,
      );
    }
    const preClaimBody = existing.body?.storage?.value ?? "";
    const crypto = await import("node:crypto");
    const preClaimHash =
      "sha256:" +
      crypto.createHash("sha256").update(preClaimBody, "utf-8").digest("hex");

    const banner = buildConfluenceBanner(
      resolveBannerInputs(this.cfg.coexistence, {
        repoName: input.repoName,
        commit: input.commit,
      }),
    );
    const fence = `${FENCE_OPEN_PREFIX} id=${input.code2wiki_id} -->\n${FENCE_CLOSE}`;
    const separator = `<hr/>\n<h2>Original content (preserved)</h2>\n`;
    const newBody =
      input.placement === "above"
        ? `${banner}\n${preClaimBody}\n${separator}${fence}`
        : `${banner}\n${fence}\n${separator}${preClaimBody}`;

    // Update body (don't change title yet).
    const putRes = await fetchImpl(
      `${this.cfg.baseUrl}/rest/api/content/${input.pageId}`,
      {
        method: "PUT",
        headers: {
          Authorization: authHeader(this.cfg),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          id: existing.id,
          type: "page",
          title: existing.title,
          space: { key: this.cfg.spaceKey },
          body: { storage: { value: newBody, representation: "storage" } },
          version: { number: existing.version.number + 1 },
        }),
      },
    );
    if (!putRes.ok) {
      throw new Error(
        `Confluence claim body-write failed: ${putRes.status} ${await putRes.text()}`,
      );
    }

    // Add labels. If this fails, attempt rollback.
    try {
      await addLabel(this.cfg, input.pageId, `c2w-${input.code2wiki_id}`, fetchImpl);
      await addLabel(this.cfg, input.pageId, this.cfg.label ?? "code2wiki", fetchImpl);
    } catch (labelErr) {
      // Roll back the body write. ONLY the rollback PUT is in the inner try;
      // the "rolled back" surface error is thrown AFTER the try/catch so a
      // successful rollback never gets wrapped as CLAIM_ABORTED. CLAIM_ABORTED
      // means wiki state is inconsistent, reserve it for rollback-also-failed.
      try {
        const rollbackRes = await fetchImpl(
          `${this.cfg.baseUrl}/rest/api/content/${input.pageId}`,
          {
            method: "PUT",
            headers: {
              Authorization: authHeader(this.cfg),
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              id: existing.id,
              type: "page",
              title: existing.title,
              space: { key: this.cfg.spaceKey },
              body: {
                storage: { value: preClaimBody, representation: "storage" },
              },
              version: { number: existing.version.number + 2 },
            }),
          },
        );
        if (!rollbackRes.ok) {
          throw new Error(
            `rollback PUT failed: ${rollbackRes.status} ${await rollbackRes.text()}`,
          );
        }
      } catch (rollbackErr) {
        const aborted = new Error(
          `claim aborted, rollback also failed: ${(labelErr as Error).message} / ${(rollbackErr as Error).message}`,
        );
        (aborted as Error & { code?: string }).code = "CLAIM_ABORTED";
        throw aborted;
      }
      throw new Error(
        `claim rolled back: label-write failed (${(labelErr as Error).message})`,
      );
    }

    return {
      external_id: existing.id,
      pre_claim_content_hash: preClaimHash,
      url: this.urlFor(existing),
    };
  }

  private urlFor(content: ConfluenceContentResponse): string | undefined {
    return confluencePageUrl(this.cfg, content);
  }
}

function confluencePageUrl(
  cfg: ConfluenceConfig,
  content: ConfluenceContentResponse,
): string | undefined {
  const webui = content._links?.webui;
  const base = content._links?.base ?? cfg.baseUrl;
  return webui ? `${base}${webui}` : undefined;
}

/**
 * If the existing page body has content OUTSIDE the managed fence (set by
 * an earlier claim), preserve it on update. Otherwise, return the new
 * storage as-is.
 *
 * This is what makes "second publish AFTER claim still preserves original
 * content" work without us re-fetching the original body.
 */
function mergePreservedOutside(
  existing: ConfluenceContentResponse,
  newStorageWithBanner: string,
): string {
  const existingBody = existing.body?.storage?.value;
  if (!existingBody) return newStorageWithBanner;
  const { after } = extractOutsideManagedRegion(existingBody);
  // The "before" region in an existing managed page is just our banner,
  // it's owned by the publisher and gets rewritten in
  // newStorageWithBanner. The "after" region is the customer's content
  // (post-claim originals or hand-appended notes), which we preserve.
  if (!after.trim()) return newStorageWithBanner;
  return `${newStorageWithBanner}${after}`;
}
