#!/usr/bin/env tsx
/**
 * Render every locally-generated use-case under `references/<repo>/docs/use-cases/`
 * into a self-contained browsable preview of what Confluence and Notion would
 * receive at publish time. No network calls; no external surface.
 *
 * For each page we emit four artifacts under `<out>/<repo>/<slug>/`:
 *
 *   - `confluence.html`   Human-readable preview styled to approximate how the
 *                         page would render in Confluence Cloud (info macro,
 *                         page chrome, sidebar, body). This is the one to open
 *                         in a browser for visual review.
 *   - `notion.html`       Human-readable preview styled to approximate how the
 *                         page would render in Notion (callout block, big page
 *                         title, narrow column, body).
 *   - `confluence.xhtml`  Raw Confluence storage-format payload the publisher
 *                         would POST, wrapped in a minimal XML envelope (so
 *                         browsers can render without a namespace error). For
 *                         debugging the live publish path.
 *   - `notion.json`       Raw Notion block JSON array the publisher would POST.
 *                         First block is the attribution callout.
 *
 * Top-level `index.html` links every page.
 *
 * Usage:
 *   npx tsx tools/scripts/local-wiki-preview.ts [--refs a,b,c] [--out DIR] [--open]
 *
 * Safety:
 *   - Zero network calls.
 *   - Output dir defaults to `~/code2wiki-local-wiki-preview` (outside repo).
 *   - Banner repo links point at `https://example.invalid/<repo>` so the
 *     placeholder is obvious.
 *
 * Render functions below are exported for tests at
 * `tools/scripts/local-wiki-preview.test.ts`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { markdownToConfluenceStorage } from "../../src/core/publishers/confluence.js";
import { markdownToNotionBlocks } from "../../src/core/publishers/notion.js";
import {
  buildConfluenceBanner,
  buildNotionBannerBlock,
  resolveBannerInputs,
  FENCE_OPEN_PREFIX,
  FENCE_CLOSE,
  type BannerInputs,
} from "../../src/core/publishers/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// =========================== pure render functions ===========================
// Exported for tests. None of these touch the filesystem or process state.

/**
 * Self-close HTML void elements so the body parses as well-formed XML.
 * marked emits HTML-style `<hr>`, `<br>`, `<img>`, etc., but the XML parser
 * we use for browser preview rejects these. Confluence's REAL API accepts
 * either form, so this is preview-only sanitization.
 */
const HTML_VOID_ELEMENTS = [
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
];

function selfCloseVoidElements(html: string): string {
  let out = html;
  for (const tag of HTML_VOID_ELEMENTS) {
    // Match `<tag>` or `<tag attr="x">` but NOT `<tag/>` (already closed).
    const re = new RegExp(`<${tag}(\\s[^>]*?)?(?<!/)>`, "gi");
    out = out.replace(re, (_, attrs) => `<${tag}${attrs ?? ""}/>`);
  }
  return out;
}

/**
 * Wrap a Confluence storage-format payload in a minimal XML envelope so that
 * browsers' built-in XML parsers don't choke on the unbound `ac:` and `ri:`
 * namespace prefixes the storage format uses, AND so void HTML elements are
 * self-closed (required by XML, optional in HTML).
 *
 * The wrapper is FOR PREVIEW BROWSING ONLY. The live publisher in
 * `src/core/publishers/confluence.ts` POSTs the raw fragment (Confluence's
 * REST API accepts both forms), so this wrapping is preview-only.
 */
export function wrapConfluencePayload(payload: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<root xmlns:ac="http://atlassian.com/content" ` +
    `xmlns:ri="http://atlassian.com/resource/identifier">\n` +
    selfCloseVoidElements(payload) +
    `\n</root>\n`
  );
}

/**
 * Build the Confluence storage-format payload for one page: banner outside
 * the fence, body inside. Returns the raw fragment (no XML envelope; use
 * `wrapConfluencePayload` for that).
 */
export function renderConfluencePayload(
  body: string,
  banner: BannerInputs,
  _slug: string,
): string {
  // Shape matches the live `buildStorageWithBanner` helper exactly in
  // src/core/publishers/confluence.ts: banner outside the fence + the
  // already-rendered body. The body's source markdown contains its own
  // fence comments (added by src/core/renderer.ts during generation),
  // so we do NOT add an extra fence here. Adding one would produce a
  // double-wrapped payload that doesn't match what the live publisher
  // POSTs.
  return buildConfluenceBanner(banner) + "\n" + markdownToConfluenceStorage(body);
}

/**
 * Build the Notion block array for one page: callout banner first, then the
 * body blocks. Returned as a JS value (caller stringifies).
 */
export function renderNotionPayload(
  body: string,
  banner: BannerInputs,
): unknown[] {
  return [buildNotionBannerBlock(banner), ...markdownToNotionBlocks(body)];
}

/** Strip the managed-fence markers for the preview HTML (keep the body). */
export function bodyForPreview(body: string): string {
  const open = body.indexOf(FENCE_OPEN_PREFIX);
  const close = body.indexOf(FENCE_CLOSE);
  if (open === -1 || close === -1) return body;
  const innerStart = body.indexOf("-->", open);
  if (innerStart === -1) return body;
  return body.slice(innerStart + 3, close).trim();
}

/** Tiny markdown to HTML for the human-readable preview. */
export function md2html(md: string): string {
  let s = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  s = s.replace(
    /```([\s\S]*?)```/g,
    (_, c) => `<pre><code>${c.trim()}</code></pre>`,
  );
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  s = s.replace(/(^|\n)- (.+)/g, (_, p, t) => `${p}<li>${t}</li>`);
  s = s.replace(/((?:<li>.*<\/li>\s*)+)/g, "<ul>$1</ul>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\n{2,}/g, "</p><p>");
  return `<p>${s}</p>`;
}

export function bannerHtml(banner: BannerInputs): string {
  return (
    `📝 <strong>This page is auto-generated by code2wiki</strong> from ${banner.repoName}. ` +
    `Edits inside the managed region will be overwritten on the next sync: ` +
    `make changes outside the marked region or in the source code. ` +
    `Last synced: ${banner.lastSyncedIso}. ` +
    `<a href="${banner.sourceLink}">View source</a>.`
  );
}

// =========================== Confluence lookalike ============================

/** Escape text for safe HTML embedding. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render Confluence storage-format payload as styled HTML that approximates
 * how Confluence Cloud actually displays the page. We extract the info macro
 * body and the post-fence content from the storage XHTML and dress them with
 * Confluence-flavored CSS.
 */
export function renderConfluenceLookalike(opts: {
  title: string;
  storagePayload: string;
}): string {
  // Extract the info macro body (the banner) and remove the macro element
  // entirely from what we render as page body.
  const infoMacroRe =
    /<ac:structured-macro[^>]*ac:name="info"[^>]*>\s*<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>\s*<\/ac:structured-macro>/;
  const infoMatch = opts.storagePayload.match(infoMacroRe);
  const infoBody = infoMatch ? infoMatch[1] : "";
  const body = opts.storagePayload.replace(infoMacroRe, "").trim();

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>${escapeHtml(opts.title)} (Confluence preview)</title>
<style>
  :root {
    --cf-text: #172b4d;
    --cf-text-subtle: #5e6c84;
    --cf-link: #0052cc;
    --cf-border: #dfe1e6;
    --cf-bg: #fff;
    --cf-info-bg: #deebff;
    --cf-info-border: #4c9aff;
    --cf-code-bg: #f4f5f7;
    --cf-nav-bg: #f4f5f7;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--cf-text); background: var(--cf-bg); }
  .cf-shell { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
  .cf-sidebar { background: var(--cf-nav-bg); border-right: 1px solid var(--cf-border); padding: 1.5em 1em; font-size: 0.9em; }
  .cf-sidebar .cf-space { font-weight: 700; color: var(--cf-text); margin-bottom: 0.4em; font-size: 0.95em; }
  .cf-sidebar .cf-space-key { color: var(--cf-text-subtle); font-size: 0.8em; margin-bottom: 1.2em; }
  .cf-sidebar ul { list-style: none; padding: 0; margin: 0; }
  .cf-sidebar li { color: var(--cf-text-subtle); padding: 0.3em 0.6em; border-radius: 3px; }
  .cf-sidebar li.cf-active { background: #e9f2ff; color: var(--cf-link); font-weight: 600; }
  .cf-main { max-width: 880px; padding: 2.5em 3em 4em; }
  .cf-crumbs { font-size: 0.85em; color: var(--cf-text-subtle); margin-bottom: 1em; }
  .cf-crumbs a { color: var(--cf-text-subtle); text-decoration: none; }
  .cf-crumbs .sep { margin: 0 0.4em; opacity: 0.5; }
  h1.cf-title { font-size: 28px; font-weight: 600; margin: 0 0 0.8em; line-height: 1.25; }
  .cf-info { background: var(--cf-info-bg); border-left: 4px solid var(--cf-info-border); padding: 0.9em 1.1em; margin: 0 0 1.6em; border-radius: 3px; font-size: 0.95em; }
  .cf-info p { margin: 0; }
  .cf-info a { color: var(--cf-link); }
  .cf-body h1, .cf-body h2, .cf-body h3 { font-weight: 600; margin: 1.6em 0 0.6em; }
  .cf-body h1 { font-size: 24px; }
  .cf-body h2 { font-size: 20px; border-bottom: 1px solid var(--cf-border); padding-bottom: 0.3em; }
  .cf-body h3 { font-size: 16px; }
  .cf-body p { margin: 0.8em 0; }
  .cf-body ul, .cf-body ol { padding-left: 1.8em; margin: 0.6em 0; }
  .cf-body li { margin: 0.25em 0; }
  .cf-body code { background: var(--cf-code-bg); padding: 0.1em 0.35em; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  .cf-body pre { background: var(--cf-code-bg); padding: 0.9em 1.1em; border-radius: 3px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  .cf-body pre code { background: none; padding: 0; }
  .cf-body a { color: var(--cf-link); }
  .cf-body hr { border: none; border-top: 1px solid var(--cf-border); margin: 1.6em 0; }
  .cf-meta { margin-top: 4em; padding-top: 1em; border-top: 1px solid var(--cf-border); font-size: 0.85em; color: var(--cf-text-subtle); }
  .cf-meta a { color: var(--cf-link); }
</style>
</head><body>
<div class="cf-shell">
  <aside class="cf-sidebar">
    <div class="cf-space">Auto-generated docs</div>
    <div class="cf-space-key">Space PREVIEW</div>
    <ul>
      <li class="cf-active">${escapeHtml(opts.title)}</li>
    </ul>
  </aside>
  <main class="cf-main">
    <div class="cf-crumbs"><a href="#">Spaces</a><span class="sep">/</span><a href="#">Auto-generated docs</a><span class="sep">/</span>${escapeHtml(opts.title)}</div>
    <h1 class="cf-title">${escapeHtml(opts.title)}</h1>
    <div class="cf-info">${infoBody}</div>
    <div class="cf-body">${body}</div>
    <div class="cf-meta">
      Approximation of how this page would render in Confluence Cloud.
      Source artifacts: <a href="confluence.xhtml">confluence.xhtml</a> (raw storage-format payload).
    </div>
  </main>
</div>
</body></html>`;
}

// ============================ Notion lookalike ===============================

interface NotionRichText {
  type: string;
  text?: { content: string; link?: { url: string } };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
  };
}

interface NotionBlock {
  type: string;
  callout?: { icon?: { emoji?: string }; rich_text?: NotionRichText[] };
  paragraph?: { rich_text?: NotionRichText[] };
  heading_1?: { rich_text?: NotionRichText[] };
  heading_2?: { rich_text?: NotionRichText[] };
  heading_3?: { rich_text?: NotionRichText[] };
  bulleted_list_item?: { rich_text?: NotionRichText[] };
  numbered_list_item?: { rich_text?: NotionRichText[] };
  code?: { rich_text?: NotionRichText[]; language?: string };
  divider?: Record<string, never>;
}

/** Inline-markdown to HTML for residual markdown inside rich_text content. */
function inlineMarkdownToHtml(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
    const safeUrl = escapeHtml(u);
    return `<a href="${safeUrl}">${t}</a>`;
  });
  return s;
}

/** Render a Notion rich_text array to inline HTML. */
export function renderNotionRichText(rt: NotionRichText[] | undefined): string {
  if (!rt) return "";
  return rt
    .map((seg) => {
      let inner = inlineMarkdownToHtml(seg.text?.content ?? "");
      const a = seg.annotations ?? {};
      if (a.code) inner = `<code>${inner}</code>`;
      if (a.bold) inner = `<strong>${inner}</strong>`;
      if (a.italic) inner = `<em>${inner}</em>`;
      if (a.strikethrough) inner = `<s>${inner}</s>`;
      if (a.underline) inner = `<u>${inner}</u>`;
      const link = seg.text?.link?.url;
      if (link) inner = `<a href="${escapeHtml(link)}">${inner}</a>`;
      return inner;
    })
    .join("");
}

/**
 * Render a Notion block array as styled HTML that approximates how a Notion
 * page actually renders. Skips the first block if it's the callout banner
 * (we render that separately as the page banner so the layout matches Notion's
 * "callout above content" convention).
 */
export function renderNotionLookalike(opts: {
  title: string;
  blocks: NotionBlock[];
}): string {
  const blocks = opts.blocks;
  // The first block is conventionally the callout banner; treat it separately
  // so it gets the styled callout chrome regardless of where it sits.
  const banner = blocks[0]?.type === "callout" ? blocks[0] : null;
  const body = banner ? blocks.slice(1) : blocks;

  const bannerHtml = banner
    ? `<div class="nt-callout"><div class="nt-emoji">${escapeHtml(
        banner.callout?.icon?.emoji ?? "📝",
      )}</div><div class="nt-callout-text">${renderNotionRichText(
        banner.callout?.rich_text,
      )}</div></div>`
    : "";

  // Walk blocks; group consecutive list items into <ul>/<ol>.
  const parts: string[] = [];
  let listType: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listType) {
      parts.push(`</${listType}>`);
      listType = null;
    }
  };
  for (const b of body) {
    const wantList =
      b.type === "bulleted_list_item"
        ? "ul"
        : b.type === "numbered_list_item"
          ? "ol"
          : null;
    if (wantList !== listType) {
      closeList();
      if (wantList) {
        parts.push(`<${wantList}>`);
        listType = wantList;
      }
    }
    switch (b.type) {
      case "heading_1":
        parts.push(`<h1>${renderNotionRichText(b.heading_1?.rich_text)}</h1>`);
        break;
      case "heading_2":
        parts.push(`<h2>${renderNotionRichText(b.heading_2?.rich_text)}</h2>`);
        break;
      case "heading_3":
        parts.push(`<h3>${renderNotionRichText(b.heading_3?.rich_text)}</h3>`);
        break;
      case "paragraph":
        parts.push(
          `<p>${renderNotionRichText(b.paragraph?.rich_text)}</p>`,
        );
        break;
      case "bulleted_list_item":
        parts.push(
          `<li>${renderNotionRichText(b.bulleted_list_item?.rich_text)}</li>`,
        );
        break;
      case "numbered_list_item":
        parts.push(
          `<li>${renderNotionRichText(b.numbered_list_item?.rich_text)}</li>`,
        );
        break;
      case "code":
        parts.push(
          `<pre><code>${escapeHtml(
            (b.code?.rich_text ?? [])
              .map((r) => r.text?.content ?? "")
              .join(""),
          )}</code></pre>`,
        );
        break;
      case "divider":
        parts.push("<hr/>");
        break;
      default:
        // Unknown block: skip but leave a visible marker for debugging.
        parts.push(
          `<div class="nt-unknown">[unhandled block type: ${escapeHtml(
            b.type,
          )}]</div>`,
        );
    }
  }
  closeList();

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>${escapeHtml(opts.title)} (Notion preview)</title>
<style>
  :root {
    --nt-text: #37352f;
    --nt-text-subtle: #787774;
    --nt-link: #2382e2;
    --nt-callout-bg: #f1f1ef;
    --nt-code-bg: #f7f6f3;
    --nt-divider: #e9e9e7;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; color: var(--nt-text); background: #fff; }
  .nt-shell { max-width: 720px; margin: 0 auto; padding: 4em 1.5em 6em; }
  h1.nt-title { font-size: 40px; font-weight: 700; line-height: 1.2; margin: 0 0 1em; letter-spacing: -0.01em; }
  .nt-callout { display: flex; gap: 0.9em; background: var(--nt-callout-bg); border-radius: 4px; padding: 1em 1.2em; margin: 0 0 1.4em; font-size: 0.95em; }
  .nt-callout .nt-emoji { font-size: 1.2em; line-height: 1.4; }
  .nt-callout .nt-callout-text { flex: 1; }
  .nt-body h1, .nt-body h2, .nt-body h3 { font-weight: 700; margin: 1.6em 0 0.4em; }
  .nt-body h1 { font-size: 30px; }
  .nt-body h2 { font-size: 24px; }
  .nt-body h3 { font-size: 20px; }
  .nt-body p { margin: 0.4em 0; }
  .nt-body ul, .nt-body ol { padding-left: 1.7em; margin: 0.4em 0; }
  .nt-body li { margin: 0.15em 0; }
  .nt-body code { background: var(--nt-code-bg); padding: 0.15em 0.4em; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em; color: #eb5757; }
  .nt-body pre { background: var(--nt-code-bg); padding: 1em 1.2em; border-radius: 4px; overflow-x: auto; }
  .nt-body pre code { background: none; padding: 0; color: var(--nt-text); }
  .nt-body a { color: var(--nt-link); }
  .nt-body hr { border: none; border-top: 1px solid var(--nt-divider); margin: 1.4em 0; }
  .nt-meta { margin-top: 4em; padding-top: 1em; border-top: 1px solid var(--nt-divider); font-size: 0.85em; color: var(--nt-text-subtle); }
  .nt-meta a { color: var(--nt-link); }
  .nt-unknown { background: #fff4e5; padding: 0.4em 0.8em; border-radius: 3px; color: #b54708; font-size: 0.85em; margin: 0.4em 0; }
</style>
</head><body>
<div class="nt-shell">
  <h1 class="nt-title">${escapeHtml(opts.title)}</h1>
  ${bannerHtml}
  <div class="nt-body">${parts.join("\n")}</div>
  <div class="nt-meta">
    Approximation of how this page would render in Notion.
    Source artifacts: <a href="notion.json">notion.json</a> (raw block JSON).
  </div>
</div>
</body></html>`;
}

export interface IndexEntry {
  repo: string;
  slug: string;
  title: string;
}

export function renderIndexHtml(entries: IndexEntry[]): string {
  const byRepo = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    if (!byRepo.has(e.repo)) byRepo.set(e.repo, []);
    byRepo.get(e.repo)!.push(e);
  }
  const sections = [...byRepo.entries()]
    .map(
      ([repo, pages]) =>
        `<h2>${escapeHtml(repo)} <span style="color:#888;font-weight:normal;font-size:0.7em">(${pages.length} pages)</span></h2>
<ul>${pages
          .map(
            (p) =>
              `<li>
  <strong>${escapeHtml(p.title)}</strong>
  <div class="links">
    <a href="${repo}/${p.slug}/confluence.html">Confluence preview</a> ·
    <a href="${repo}/${p.slug}/notion.html">Notion preview</a>
    <span class="raw">raw:
      <a href="${repo}/${p.slug}/confluence.xhtml">.xhtml</a>
      <a href="${repo}/${p.slug}/notion.json">.json</a>
    </span>
  </div>
</li>`,
          )
          .join("\n")}</ul>`,
    )
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>code2wiki local wiki preview</title>
<style>
  body { font: 14px/1.55 -apple-system, system-ui, sans-serif; max-width: 880px; margin: 2em auto; padding: 0 1em; }
  h1 { font-size: 1.6em; border-bottom: 1px solid #ddd; padding-bottom: 0.3em; }
  h2 { margin-top: 1.8em; font-size: 1.15em; }
  ul { padding-left: 0; list-style: none; }
  li { margin: 0.6em 0; padding: 0.6em 0.8em; background: #f9f9f9; border-radius: 4px; }
  li strong { display: block; margin-bottom: 0.2em; }
  .links { font-size: 0.9em; color: #555; }
  .links a { color: #06c; text-decoration: none; margin-right: 0.4em; }
  .links a:hover { text-decoration: underline; }
  .raw { color: #999; margin-left: 1em; font-size: 0.9em; }
  .raw a { color: #888; }
  .preamble { color: #555; }
</style>
</head><body>
<h1>code2wiki local wiki preview</h1>
<p class="preamble">What each locally-generated use-case would look like as a Confluence or Notion publish. No network calls; nothing was actually pushed anywhere. Generated ${new Date().toISOString()}.</p>
${sections}
</body></html>`;
}

// =============================== CLI plumbing ================================

interface Flags {
  refs: string[] | null;
  out: string;
  open: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    refs: null,
    out: path.join(os.homedir(), "code2wiki-local-wiki-preview"),
    open: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--refs" && argv[i + 1]) {
      f.refs = argv[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--out" && argv[i + 1]) {
      f.out = argv[++i]!;
    } else if (a === "--open") {
      f.open = true;
    } else if (a === "-h" || a === "--help") {
      f.help = true;
    }
  }
  return f;
}

const HELP = `local-wiki-preview, render generated use-cases as browsable wiki previews.

Usage:
  npx tsx tools/scripts/local-wiki-preview.ts [options]

Options:
  --refs a,b,c   Only render these reference repos. Default: auto-discover
                 any references/<repo>/docs/use-cases/ that exists.
  --out <dir>    Output directory. Default: ~/code2wiki-local-wiki-preview.
  --open         Open the resulting index.html in your browser.
  -h, --help     Show this help.

Safe: zero network calls, no Confluence/Notion API touched, output is
outside the repo so nothing is staged for commit.`;

async function discoverRefs(): Promise<string[]> {
  const refsDir = path.join(REPO_ROOT, "references");
  let entries: string[];
  try {
    entries = await fs.readdir(refsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    try {
      const stat = await fs.stat(path.join(refsDir, e, "docs", "use-cases"));
      if (stat.isDirectory()) out.push(e);
    } catch {
      /* not a ref with output, skip */
    }
  }
  return out.sort();
}

interface PreviewPage {
  repo: string;
  slug: string;
  title: string;
  sourceMdPath: string;
  outDir: string;
}

async function listUseCases(
  repo: string,
  outRoot: string,
): Promise<PreviewPage[]> {
  const useCaseDir = path.join(
    REPO_ROOT,
    "references",
    repo,
    "docs",
    "use-cases",
  );
  let entries: string[];
  try {
    entries = await fs.readdir(useCaseDir);
  } catch {
    return [];
  }
  const out: PreviewPage[] = [];
  for (const e of entries.filter((n) => n.endsWith(".md"))) {
    const slug = e.replace(/\.md$/, "");
    const sourceMdPath = path.join(useCaseDir, e);
    const raw = await fs.readFile(sourceMdPath, "utf-8");
    const fm = matter(raw);
    const title = (fm.data["title"] as string | undefined) ?? slug;
    out.push({
      repo,
      slug,
      title,
      sourceMdPath,
      outDir: path.join(outRoot, repo, slug),
    });
  }
  return out;
}

async function openInBrowser(filePath: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(opener, [`file://${filePath}`], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const refs = flags.refs ?? (await discoverRefs());
  if (refs.length === 0) {
    console.error(
      "No reference codebases with docs/use-cases/ found. " +
        "Run `code2wiki generate` against one first, or pass --refs.",
    );
    process.exit(1);
  }

  const outRoot = flags.out;
  await fs.rm(outRoot, { recursive: true, force: true });
  await fs.mkdir(outRoot, { recursive: true });

  const allPages: PreviewPage[] = [];
  for (const repo of refs) {
    const pages = await listUseCases(repo, outRoot);
    allPages.push(...pages);
  }

  if (allPages.length === 0) {
    console.error(
      `Selected refs (${refs.join(", ")}) contain no use-case markdown files.`,
    );
    process.exit(1);
  }

  for (const p of allPages) {
    await fs.mkdir(p.outDir, { recursive: true });
    const raw = await fs.readFile(p.sourceMdPath, "utf-8");
    const fm = matter(raw);
    const body = fm.content;

    const banner = resolveBannerInputs(
      {
        banner: {
          repoName: p.repo,
          repoUrl: `https://example.invalid/${p.repo}`,
          now: () => new Date().toISOString(),
        },
      },
      { repoName: p.repo, commit: "preview" },
    );

    const confluencePayload = renderConfluencePayload(body, banner, p.slug);
    const confluenceWrapped = wrapConfluencePayload(confluencePayload);
    await fs.writeFile(
      path.join(p.outDir, "confluence.xhtml"),
      confluenceWrapped,
      "utf-8",
    );

    const notion = renderNotionPayload(body, banner);
    await fs.writeFile(
      path.join(p.outDir, "notion.json"),
      JSON.stringify(notion, null, 2),
      "utf-8",
    );

    // Human-readable preview, styled like Confluence.
    const confluenceHtml = renderConfluenceLookalike({
      title: p.title,
      storagePayload: confluencePayload,
    });
    await fs.writeFile(
      path.join(p.outDir, "confluence.html"),
      confluenceHtml,
      "utf-8",
    );

    // Human-readable preview, styled like Notion.
    const notionHtml = renderNotionLookalike({
      title: p.title,
      blocks: notion as NotionBlock[],
    });
    await fs.writeFile(
      path.join(p.outDir, "notion.html"),
      notionHtml,
      "utf-8",
    );
  }

  const indexPath = path.join(outRoot, "index.html");
  await fs.writeFile(
    indexPath,
    renderIndexHtml(
      allPages.map((p) => ({ repo: p.repo, slug: p.slug, title: p.title })),
    ),
    "utf-8",
  );

  console.log(`wrote ${allPages.length} pages to ${outRoot}`);
  console.log(`open: file://${indexPath}`);

  if (flags.open) {
    await openInBrowser(indexPath);
  }
}

// Only run main() when executed as a CLI, not when imported by tests.
const isCliRun = import.meta.url === `file://${process.argv[1]}`;
if (isCliRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
