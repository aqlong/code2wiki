/**
 * Shared types and interface for code2wiki publishers (Confluence, Notion,
 * GitHub Wiki, etc.). Every publisher is a function that takes a list of
 * already-rendered Markdown pages and idempotently upserts them into a
 * destination, preserving any human edits that live outside the
 * <!-- code2wiki:managed --> fence.
 */

export interface PageInput {
  /** Stable identifier, never changes across regenerations. */
  code2wiki_id: string;
  /** Page title shown to readers. */
  title: string;
  /** kebab-case slug used in URLs and as the idempotency key. */
  slug: string;
  /** Full Markdown body (with the managed fence). */
  markdown: string;
  /** Original parse-time tags. */
  tags: string[];
}

export type PublishOutcome = "created" | "updated" | "unchanged" | "skipped";

export interface PublishResult {
  page: PageInput;
  outcome: PublishOutcome;
  /** Destination URL when known. */
  url?: string;
  /** Provider-specific identifier (e.g. Confluence pageId). */
  externalId?: string;
  /** Error or skip reason. */
  message?: string;
}

export interface Publisher {
  readonly name: string;
  /** True if the publisher will only print the diff, not call the API. */
  readonly dryRun: boolean;
  /** Push (or dry-run) all pages and return per-page results. */
  publish(pages: PageInput[]): Promise<PublishResult[]>;
}

/**
 * The HTML comment fence that delimits a code2wiki-managed region inside
 * a wiki page. Anything OUTSIDE the fence is preserved on regeneration,
 * so a customer's BA can append their own notes/screenshots after our
 * region and they will survive the next push.
 */
export const FENCE_OPEN_PREFIX = "<!-- code2wiki:managed:start";
export const FENCE_CLOSE = "<!-- code2wiki:managed:end -->";

/** Extract just the body inside the managed fence (or the whole text if no fence). */
export function extractManagedRegion(text: string): string | null {
  const start = text.indexOf(FENCE_OPEN_PREFIX);
  if (start < 0) return null;
  const startEnd = text.indexOf("-->", start);
  if (startEnd < 0) return null;
  const close = text.indexOf(FENCE_CLOSE, startEnd);
  if (close < 0) return null;
  return text.slice(startEnd + 3, close).trim();
}

/**
 * Return the "outside" parts of a fenced document, the segments before
 * the fence open and after the fence close. Used by claim mode to
 * preserve a page's pre-claim hand-written content as a region the
 * publisher will never touch.
 *
 * If the text has no fence, the whole text is treated as "before" and
 * "after" is empty.
 */
export function extractOutsideManagedRegion(text: string): {
  before: string;
  after: string;
} {
  const start = text.indexOf(FENCE_OPEN_PREFIX);
  if (start < 0) return { before: text, after: "" };
  const startEnd = text.indexOf("-->", start);
  if (startEnd < 0) return { before: text, after: "" };
  const close = text.indexOf(FENCE_CLOSE, startEnd);
  if (close < 0) return { before: text.slice(0, start), after: "" };
  return {
    before: text.slice(0, start),
    after: text.slice(close + FENCE_CLOSE.length),
  };
}

/**
 * Strip a leading YAML frontmatter block (`---\n…\n---\n`) from rendered
 * Markdown before it reaches a publisher's renderer.
 *
 * Generated `.md` files on disk carry frontmatter (`code2wiki_id`, `title`,
 * `slug`, `tags`, `confidence`), and the `publish` command hands the whole
 * file (frontmatter included) to the publisher as `page.markdown`. marked
 * has no concept of YAML frontmatter, so without this strip those keys
 * render as a visible heading/paragraph at the top of every published page.
 *
 * The regex is anchored at the start of the string and non-greedy, so it
 * removes ONLY the leading frontmatter block, never a `---` horizontal rule
 * later in the body. If there is no frontmatter the input passes through
 * unchanged. Single source of truth so the Confluence and Notion publishers
 * can never diverge on frontmatter handling (they did: Notion stripped,
 * Confluence did not, leaking frontmatter onto every Confluence page).
 */
export function stripFrontmatter(markdown: string): string {
  // Tolerate CRLF as well as LF: `publish` reads generated `.md` files raw
  // from disk (publish.ts), and a page hand-edited in a Windows/CRLF editor
  // would otherwise slip the whole YAML block (code2wiki_id / title /
  // confidence) past this strip and render it as visible text on the wiki
  // page, the same compliance leak the LF path closed.
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

// ---- ADR-016: wiki coexistence ------------------------------------------

/** Three explicit publish modes. See docs/wiki-coexistence.md §3.4. */
export type PublishMode = "greenfield" | "claim" | "parallel";

/**
 * Per-target coexistence configuration, flowed into each publisher.
 * Defaults preserve the pre-ADR-016 behavior (greenfield, no prefix).
 */
export interface CoexistenceConfig {
  /** Default: "greenfield". */
  mode?: PublishMode;
  /** When set in parallel mode, defaults to "code2wiki/". */
  slugPrefix?: string;
  /** Opt-in title prefix (e.g. "[code2wiki]"). Default: empty. */
  titlePrefix?: string;
  /**
   * Repo identity shown in the visible attribution banner.
   * - repoName appears in the human-readable text.
   * - repoUrl is the fallback link target.
   * - commitUrl is the preferred link target (commit permalink) when
   *   available; the publisher fills in the commit hash at publish time.
   */
  banner?: {
    repoName?: string;
    repoUrl?: string;
    /** A `{commit}` token in the URL is replaced with the current commit. */
    commitUrlTemplate?: string;
    /** Explicit override of the commit hash (otherwise: git HEAD). */
    commit?: string;
    /** Test seam, overrides the generated_at timestamp. */
    now?: () => string;
  };
  /** Override the automatic --ignore-collisions=false in claim mode. */
  ignoreCollisions?: boolean;
}

/** Inputs to the banner block builders. Resolved by the publisher
 *  before calling buildConfluenceBanner / buildNotionBanner. */
export interface BannerInputs {
  repoName: string;
  /** The href the "View source" link points at. */
  sourceLink: string;
  /** ISO-8601 UTC timestamp; appears in "Last synced: ...". */
  lastSyncedIso: string;
}

const BANNER_PREFIX = "📝 **This page is auto-generated by code2wiki**";

/** Plain-text banner copy. Width-bounded ≤ 500 chars. */
export function bannerPlainText(b: BannerInputs): string {
  return (
    `${BANNER_PREFIX} from ${b.repoName}. ` +
    `Edits inside the managed region will be overwritten on the next sync: ` +
    `make changes outside the marked region or in the source code. ` +
    `Last synced: ${b.lastSyncedIso}. ` +
    `View source: ${b.sourceLink}.`
  );
}

/**
 * Resolve the inputs the banner builders need from the (possibly partial)
 * coexistence config, filling in safe fallbacks. `defaultRepoName` is the
 * git-derived project name; the config may override it.
 */
export function resolveBannerInputs(
  cfg: CoexistenceConfig | undefined,
  defaults: { repoName: string; commit?: string },
): BannerInputs {
  const banner = cfg?.banner ?? {};
  const repoName = banner.repoName ?? defaults.repoName;
  const commit = banner.commit ?? defaults.commit;
  const tpl = banner.commitUrlTemplate;
  let sourceLink: string;
  if (tpl && commit && commit !== "unknown") {
    sourceLink = tpl.replace("{commit}", commit);
  } else if (banner.repoUrl) {
    sourceLink = banner.repoUrl;
  } else {
    // Final fallback: a literal placeholder so tests and dry-runs still pass
    // and the operator notices to set repoUrl in config.
    sourceLink = `https://example.invalid/${repoName}`;
  }
  const now = banner.now ? banner.now() : new Date().toISOString();
  return { repoName, sourceLink, lastSyncedIso: now };
}

/**
 * Confluence storage-format banner block. Rendered as a non-collapsed
 * "info" macro at the top of the page, sitting OUTSIDE the managed fence
 * so the existing extractManagedRegion() helper still returns just the
 * generated body.
 *
 * The banner is publisher-owned, it is rewritten on every publish.
 */
export function buildConfluenceBanner(b: BannerInputs): string {
  const safeRepo = escapeXml(b.repoName);
  const safeIso = escapeXml(b.lastSyncedIso);
  const safeLink = escapeXml(b.sourceLink);
  return (
    `<ac:structured-macro ac:name="info" ac:schema-version="1">` +
    `<ac:rich-text-body>` +
    `<p>📝 <strong>This page is auto-generated by code2wiki</strong> from ${safeRepo}. ` +
    `Edits inside the managed region will be overwritten on the next sync: ` +
    `make changes outside the marked region or in the source code. ` +
    `Last synced: ${safeIso}. ` +
    `<a href="${safeLink}">View source</a>.</p>` +
    `</ac:rich-text-body>` +
    `</ac:structured-macro>`
  );
}

/** Notion callout block (📝). Returned as the JSON body that gets POSTed. */
export function buildNotionBannerBlock(b: BannerInputs): unknown {
  const richText = (text: string, link?: string) => ({
    type: "text" as const,
    text: link ? { content: text, link: { url: link } } : { content: text },
    annotations: undefined,
  });
  return {
    object: "block",
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: "📝" },
      rich_text: [
        { type: "text", text: { content: "This page is auto-generated by code2wiki" }, annotations: { bold: true } },
        { type: "text", text: { content: ` from ${b.repoName}. Edits inside the managed region will be overwritten on the next sync: make changes outside the marked region or in the source code. Last synced: ${b.lastSyncedIso}. ` } },
        richText("View source", b.sourceLink),
        { type: "text", text: { content: "." } },
      ],
    },
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
