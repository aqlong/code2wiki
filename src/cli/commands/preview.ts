import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { loadConfig } from "../../core/config.js";
import {
  markdownToConfluenceStorage,
} from "../../core/publishers/confluence.js";
import { markdownToNotionBlocks } from "../../core/publishers/notion.js";
import {
  buildConfluenceBanner,
  buildNotionBannerBlock,
  resolveBannerInputs,
  type BannerInputs,
} from "../../core/publishers/types.js";

export interface PreviewOptions {
  cwd: string;
  /** Where to write the preview directory. Default: `<cwd>/.code2wiki/preview/`. */
  out?: string;
  /** If set, open the generated index in the default browser. */
  open?: boolean;
}

/**
 * Render every generated use-case under the configured output dir as a
 * browsable preview of what Confluence and Notion would receive at publish
 * time. Three artifacts per page under `<out>/<slug>/`:
 *
 *   - confluence.html  Confluence-style preview (chrome + info macro banner).
 *   - notion.html      Notion-style preview (callout banner + narrow column).
 *   - confluence.xhtml The raw storage-format payload the publisher would POST.
 *   - notion.json      The raw Notion block JSON the publisher would POST.
 *
 * Top-level `index.html` links every page.
 *
 * No network calls; nothing is published.
 */
export async function runPreview(opts: PreviewOptions): Promise<void> {
  const config = await loadConfig(opts.cwd);
  const outDir = path.join(opts.cwd, config.output);
  const previewDir =
    opts.out ?? path.join(opts.cwd, ".code2wiki", "preview");

  let files: string[];
  try {
    files = (await fs.readdir(outDir)).filter((f) => f.endsWith(".md"));
  } catch {
    console.error(
      `[code2wiki preview] output dir not found: ${outDir}\n` +
        `Run \`code2wiki generate\` first.`,
    );
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(
      `[code2wiki preview] no markdown files in ${outDir}. ` +
        `Run \`code2wiki generate\` first.`,
    );
    process.exit(1);
  }

  await fs.rm(previewDir, { recursive: true, force: true });
  await fs.mkdir(previewDir, { recursive: true });

  const banner = resolveBannerInputs(config.publish?.confluence, {
    repoName: path.basename(opts.cwd),
    commit: "preview",
  });

  // Pass 1: read every page's slug, title, body, confidence, and
  // last_generated so we can render badges and timestamps in pass 2.
  interface PageEntry {
    slug: string;
    title: string;
    confidence: string;
    lastGenerated: string;
    content: string;
    group?: string;
  }
  const allPages: PageEntry[] = [];
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    const raw = await fs.readFile(path.join(outDir, f), "utf-8");
    const fm = matter(raw);
    const title = (fm.data["title"] as string | undefined) ?? slug;
    const confidence = fm.data["confidence"]
      ? String(fm.data["confidence"])
      : "unknown";
    // gray-matter parses unquoted YAML timestamps into Date objects;
    // normalize back to ISO so <time datetime=""> stays machine-readable.
    const rawGenerated = fm.data["last_generated"];
    const lastGenerated =
      rawGenerated instanceof Date
        ? rawGenerated.toISOString()
        : rawGenerated
          ? String(rawGenerated)
          : "";
    // Derive a grouping hint from the first source_file path so the
    // index can mirror the codebase layout (e.g. "Reports", "Time", root).
    let group: string | undefined;
    const sources = fm.data["source_files"] as Array<{ path?: string }> | undefined;
    const firstPath = Array.isArray(sources) && sources[0]?.path;
    if (typeof firstPath === "string") {
      const parts = firstPath.split(/[\\/]/);
      group = parts.length > 1 ? parts[0] : "(root)";
    }
    allPages.push({ slug, title, confidence, lastGenerated, content: fm.content, group });
  }

  // Pass 2: render and write all artifacts, now that allPages is complete.
  for (const { slug, title, confidence, lastGenerated, content } of allPages) {
    const pageDir = path.join(previewDir, slug);
    await fs.mkdir(pageDir, { recursive: true });

    // Confluence: storage XHTML payload + a browsable HTML lookalike.
    const cfPayload = renderConfluenceLookalikePayload(content, banner);
    await fs.writeFile(
      path.join(pageDir, "confluence.xhtml"),
      wrapConfluenceForBrowser(cfPayload),
      "utf-8",
    );
    await fs.writeFile(
      path.join(pageDir, "confluence.html"),
      renderConfluenceHtml(title, confidence, lastGenerated, content, banner, slug, allPages),
      "utf-8",
    );

    // Notion: blocks JSON + a browsable HTML lookalike.
    const ntBlocks = [
      buildNotionBannerBlock(banner),
      ...markdownToNotionBlocks(content),
    ];
    await fs.writeFile(
      path.join(pageDir, "notion.json"),
      JSON.stringify(ntBlocks, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      path.join(pageDir, "notion.html"),
      renderNotionHtml(title, confidence, lastGenerated, content, banner),
      "utf-8",
    );
  }

  // Top-level index.
  await fs.writeFile(
    path.join(previewDir, "index.html"),
    renderIndex(allPages, banner.repoName),
    "utf-8",
  );

  const indexPath = path.join(previewDir, "index.html");
  console.log(
    `[code2wiki preview] wrote ${allPages.length} page(s) to ${previewDir}`,
  );
  console.log(`[code2wiki preview] open: file://${indexPath}`);

  if (opts.open) {
    const { spawn } = await import("node:child_process");
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    spawn(opener, [`file://${indexPath}`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
}

// =========================== render helpers ============================
//
// These mirror the standalone CLI script at
// `tools/scripts/local-wiki-preview.ts` and the dashboard library at
// `apps/dashboard/src/lib/preview/lookalikes.ts`. Three copies sounds
// duplicative; the alternatives (cross-package import, workspace pkg)
// add real complexity for limited benefit on a young project. If drift
// surfaces, extract to a workspace pkg.

function escapeHtml(s: unknown): string {
  const str = s == null ? "" : String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderConfluenceLookalikePayload(
  body: string,
  banner: BannerInputs,
): string {
  return (
    buildConfluenceBanner(banner) + "\n" + markdownToConfluenceStorage(body)
  );
}

function wrapConfluenceForBrowser(payload: string): string {
  // Self-close HTML void elements so the document parses as XML; declare
  // the Atlassian namespaces so `<ac:...>` macros don't fail XML parsing.
  const voids = [
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "source", "track", "wbr",
  ];
  let out = payload;
  for (const tag of voids) {
    const re = new RegExp(`<${tag}(\\s[^>]*?)?(?<!/)>`, "gi");
    out = out.replace(re, (_, attrs) => `<${tag}${attrs ?? ""}/>`);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<root xmlns:ac="http://atlassian.com/content" ` +
    `xmlns:ri="http://atlassian.com/resource/identifier">\n` +
    out +
    `\n</root>\n`
  );
}

function confidenceBadge(level: string, prefix = "cf"): string {
  const text = escapeHtml(level);
  const suffix =
    level === "high"
      ? "high"
      : level === "medium"
        ? "medium"
        : "low";
  return `<span class="${prefix}-confidence ${prefix}-confidence-${suffix}">${text}</span>`;
}

function renderConfluenceHtml(
  title: string,
  confidence: string,
  lastGenerated: string,
  bodyMarkdown: string,
  banner: BannerInputs,
  currentSlug: string,
  allPages: Array<{ slug: string; title: string }>,
): string {
  const bodyHtml = markdownToConfluenceStorage(bodyMarkdown);
  const sidebarItems = allPages
    .map((p) =>
      p.slug === currentSlug
        ? `<li class="cf-active">${escapeHtml(p.title)}</li>`
        : `<li><a href="../${p.slug}/confluence.html">${escapeHtml(p.title)}</a></li>`,
    )
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>${escapeHtml(title)} (Confluence preview)</title>
<style>
  :root { --cf-text:#172b4d; --cf-text-subtle:#5e6c84; --cf-link:#0052cc; --cf-border:#dfe1e6; --cf-info-bg:#deebff; --cf-info-border:#4c9aff; --cf-code-bg:#f4f5f7; --cf-nav-bg:#f4f5f7; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif; color:var(--cf-text); background:#fff; }
  .cf-shell { display:grid; grid-template-columns:240px 1fr; min-height:100vh; }
  .cf-sidebar { background:var(--cf-nav-bg); border-right:1px solid var(--cf-border); padding:1.5em 1em; font-size:0.9em; }
  .cf-sidebar .cf-space { font-weight:700; margin-bottom:0.4em; }
  .cf-sidebar .cf-space-key { color:var(--cf-text-subtle); font-size:0.8em; margin-bottom:1.2em; }
  .cf-sidebar ul { list-style:none; padding:0; margin:0; }
  .cf-sidebar li { padding:0.3em 0.6em; border-radius:3px; color:var(--cf-text-subtle); }
  .cf-sidebar li.cf-active { background:#e9f2ff; color:var(--cf-link); font-weight:600; }
  .cf-sidebar li a { color:inherit; text-decoration:none; }
  .cf-sidebar li a:hover { color:var(--cf-link); }
  .cf-main { max-width:880px; padding:2.5em 3em 4em; }
  .cf-crumbs { font-size:0.85em; color:var(--cf-text-subtle); margin-bottom:1em; }
  h1.cf-title { font-size:28px; font-weight:600; margin:0 0 0.2em; line-height:1.25; }
  .cf-confidence { display:inline-block; padding:0.1em 0.5em; border-radius:3px; font-size:0.7em; font-weight:600; vertical-align:middle; margin-left:0.5em; }
  .cf-confidence-high { background:#e3fcef; color:#006644; }
  .cf-confidence-medium { background:#fff0b3; color:#7a5d00; }
  .cf-confidence-low { background:#ffebe6; color:#bf2600; }
  .cf-meta { font-size:0.85em; color:var(--cf-text-subtle); margin:0 0 1.2em; }
  .cf-info { background:var(--cf-info-bg); border-left:4px solid var(--cf-info-border); padding:0.9em 1.1em; margin:0 0 1.6em; border-radius:3px; }
  .cf-info p { margin:0; }
  .cf-info a { color:var(--cf-link); }
  .cf-body h1,.cf-body h2,.cf-body h3 { font-weight:600; margin:1.6em 0 0.6em; }
  .cf-body h2 { border-bottom:1px solid var(--cf-border); padding-bottom:0.3em; }
  .cf-body p { margin:0.8em 0; }
  .cf-body ul,.cf-body ol { padding-left:1.8em; }
  .cf-body code { background:var(--cf-code-bg); padding:0.1em 0.35em; border-radius:3px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:0.92em; }
  .cf-body pre { background:var(--cf-code-bg); padding:0.9em 1.1em; border-radius:3px; overflow-x:auto; }
  .cf-body pre code { background:none; padding:0; }
  .cf-body a { color:var(--cf-link); }
  .cf-body hr { border:none; border-top:1px solid var(--cf-border); margin:1.6em 0; }
  .cf-body details { background:#fafbfc; border:1px solid var(--cf-border); border-radius:3px; padding:0.4em 0.8em; margin:0.8em 0; }
  .cf-body summary { cursor:pointer; font-weight:600; }
</style></head><body>
<div class="cf-shell">
  <aside class="cf-sidebar"><div class="cf-space">Auto-generated docs</div><div class="cf-space-key">Space PREVIEW</div><ul>${sidebarItems}</ul></aside>
  <main class="cf-main">
    <div class="cf-crumbs"><a href="../index.html">Spaces</a> / <a href="../index.html">Auto-generated docs</a> / ${escapeHtml(title)}</div>
    <h1 class="cf-title">${escapeHtml(title)} ${confidenceBadge(confidence)}</h1>
    ${lastGenerated ? `<div class="cf-meta">Generated <time data-c2w-localize datetime="${escapeHtml(lastGenerated)}" title="${escapeHtml(lastGenerated)}">${escapeHtml(lastGenerated)}</time></div>` : ""}
    <div class="cf-info"><p>${bannerHtml(banner)}</p></div>
    <div class="cf-body">${bodyHtml}</div>
  </main>
</div>${LOCALIZE_TIME_SCRIPT}</body></html>`;
}

function renderNotionHtml(
  title: string,
  confidence: string,
  lastGenerated: string,
  bodyMarkdown: string,
  banner: BannerInputs,
): string {
  const bodyHtml = markdownToConfluenceStorage(bodyMarkdown);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>${escapeHtml(title)} (Notion preview)</title>
<style>
  :root { --nt-text:#37352f; --nt-callout-bg:#f1f1ef; --nt-code-bg:#f7f6f3; --nt-link:#2382e2; --nt-divider:#e9e9e7; }
  * { box-sizing:border-box; }
  body { margin:0; font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; color:var(--nt-text); background:#fff; }
  .nt-shell { max-width:720px; margin:0 auto; padding:4em 1.5em 6em; }
  h1.nt-title { font-size:40px; font-weight:700; line-height:1.2; margin:0 0 1em; letter-spacing:-0.01em; }
  .nt-confidence { display:inline-block; padding:0.1em 0.5em; border-radius:3px; font-size:0.6em; font-weight:600; vertical-align:middle; margin-left:0.6em; }
  .nt-confidence-high { background:#deece6; color:#0f7b49; }
  .nt-confidence-medium { background:#f5edcf; color:#8f6d00; }
  .nt-confidence-low { background:#f0d2cd; color:#b53b2c; }
  .nt-meta { font-size:0.85em; color:var(--nt-text); opacity:0.6; margin:-0.5em 0 1.4em; }
  .nt-callout { display:flex; gap:0.9em; background:var(--nt-callout-bg); border-radius:4px; padding:1em 1.2em; margin:0 0 1.4em; font-size:0.95em; }
  .nt-callout .nt-emoji { font-size:1.2em; line-height:1.4; }
  .nt-body h1,.nt-body h2,.nt-body h3 { font-weight:700; margin:1.6em 0 0.4em; }
  .nt-body h1 { font-size:30px; }
  .nt-body h2 { font-size:24px; }
  .nt-body h3 { font-size:20px; }
  .nt-body p { margin:0.4em 0; }
  .nt-body ul,.nt-body ol { padding-left:1.7em; }
  .nt-body code { background:var(--nt-code-bg); padding:0.15em 0.4em; border-radius:4px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:0.88em; color:#eb5757; }
  .nt-body pre { background:var(--nt-code-bg); padding:1em 1.2em; border-radius:4px; overflow-x:auto; }
  .nt-body pre code { background:none; padding:0; color:var(--nt-text); }
  .nt-body a { color:var(--nt-link); }
  .nt-body hr { border:none; border-top:1px solid var(--nt-divider); margin:1.4em 0; }
  .nt-body details { background:var(--nt-callout-bg); border-radius:4px; padding:0.6em 1em; margin:0.8em 0; }
</style></head><body>
<div class="nt-shell">
  <h1 class="nt-title">${escapeHtml(title)} ${confidenceBadge(confidence)}</h1>
  ${lastGenerated ? `<div class="nt-meta">Generated <time data-c2w-localize datetime="${escapeHtml(lastGenerated)}" title="${escapeHtml(lastGenerated)}">${escapeHtml(lastGenerated)}</time></div>` : ""}
  <div class="nt-callout"><div class="nt-emoji">📝</div><div class="nt-callout-text">${bannerHtml(banner)}</div></div>
  <div class="nt-body">${bodyHtml}</div>
</div>${LOCALIZE_TIME_SCRIPT}</body></html>`;
}

function bannerHtml(banner: BannerInputs): string {
  const iso = escapeHtml(banner.lastSyncedIso);
  return (
    `📝 <strong>This page is auto-generated by code2wiki</strong> from ${escapeHtml(banner.repoName)}. ` +
    `Edits inside the managed region will be overwritten on the next sync: ` +
    `make changes outside the marked region or in the source code. ` +
    `Last synced: <time data-c2w-localize datetime="${iso}" title="${iso}">${iso}</time>. ` +
    `<a href="${escapeHtml(banner.sourceLink)}">View source</a>.`
  );
}

/**
 * Inline script injected at the END of every preview page's <body>.
 * Rewrites any <time data-c2w-localize datetime="...Z"> to the viewer's
 * local time with their IANA / abbreviated timezone, while preserving the
 * original ISO value as the `title` tooltip for traceability.
 *
 * Also scans the rendered document body for bare ISO-8601 UTC timestamps
 * (produced by the LLM in YAML frontmatter rendering or footers) and
 * localizes them too, so reviewers never see raw `2026-06-01T15:09:22.047Z`.
 * Text inside <code>/<pre> is exempt: code samples (example payloads,
 * fixture JSON) must display exactly what the source shows.
 *
 * Placement is load-bearing: a synchronous script in <head> runs before
 * the body is parsed and silently rewrites nothing.
 */
const LOCALIZE_TIME_SCRIPT = `<script>
(function(){
  var tzName = "";
  try {
    tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (e) { tzName = ""; }
  function tzAbbr(d){
    try {
      var parts = new Intl.DateTimeFormat(undefined,{timeZoneName:"short"}).formatToParts(d);
      var p = parts.find(function(x){return x.type==="timeZoneName";});
      return p ? p.value : "";
    } catch(e){ return ""; }
  }
  function fmt(d){
    var local = d.toLocaleString(undefined, {
      year:"numeric", month:"short", day:"2-digit",
      hour:"2-digit", minute:"2-digit", second:"2-digit"
    });
    var abbr = tzAbbr(d);
    return local + (abbr ? " " + abbr : "") + (tzName ? " (" + tzName + ")" : "");
  }
  document.querySelectorAll("time[data-c2w-localize][datetime]").forEach(function(el){
    var d = new Date(el.getAttribute("datetime"));
    if (isNaN(d.getTime())) return;
    el.setAttribute("title", el.getAttribute("datetime"));
    el.textContent = fmt(d);
  });
  var isoRe = /\\b(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z)\\b/g;
  var bodies = document.querySelectorAll(".cf-body, .nt-body");
  bodies.forEach(function(body){
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = walker.nextNode())) {
      if (n.parentElement && n.parentElement.closest("code,pre")) continue;
      if (isoRe.test(n.nodeValue)) { isoRe.lastIndex = 0; nodes.push(n); }
    }
    nodes.forEach(function(node){
      var frag = document.createDocumentFragment();
      var last = 0, text = node.nodeValue, m;
      isoRe.lastIndex = 0;
      while ((m = isoRe.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var d = new Date(m[1]);
        if (!isNaN(d.getTime())) {
          var t = document.createElement("time");
          t.setAttribute("datetime", m[1]);
          t.setAttribute("title", m[1]);
          t.textContent = fmt(d);
          frag.appendChild(t);
        } else {
          frag.appendChild(document.createTextNode(m[1]));
        }
        last = m.index + m[1].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  });
})();
</script>`;

function renderIndex(
  entries: Array<{ slug: string; title: string; confidence: string; lastGenerated: string; group?: string }>,
  repoName?: string,
): string {
  const name = repoName ? escapeHtml(repoName) : "this project";
  const grouped = new Map<string, typeof entries>();
  for (const e of entries) {
    const g = e.group || "(root)";
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g)!.push(e);
  }
  const sections = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, items]) => {
      const lis = items
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map(
          (e) =>
            `<li>
  <strong>${escapeHtml(e.title)} ${confidenceBadge(e.confidence, "ix")}</strong>
  <div class="links">
    <a href="${e.slug}/confluence.html">Confluence preview</a> ·
    <a href="${e.slug}/notion.html">Notion preview</a>
    <span class="raw">raw: <a href="${e.slug}/confluence.xhtml">.xhtml</a> <a href="${e.slug}/notion.json">.json</a></span>
  </div>
</li>`,
        )
        .join("\n");
      return `<h2>${escapeHtml(group)} <span class="count">(${items.length})</span></h2>\n<ul>${lis}</ul>`;
    })
    .join("\n");
  const nowIso = new Date().toISOString();
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>code2wiki preview: ${name}</title>
<style>
  body { font:14px/1.55 -apple-system,system-ui,sans-serif; max-width:880px; margin:2em auto; padding:0 1em; }
  h1 { font-size:1.6em; border-bottom:1px solid #ddd; padding-bottom:0.3em; }
  h2 { font-size:1.1em; margin-top:1.6em; color:#444; border-bottom:1px solid #eee; padding-bottom:0.2em; }
  h2 .count { color:#999; font-weight:400; font-size:0.9em; }
  .preamble { color:#555; margin-bottom:0.5em; }
  .preamble .count { font-weight:600; }
  ul { padding-left:0; list-style:none; }
  li { margin:0.6em 0; padding:0.6em 0.8em; background:#f9f9f9; border-radius:4px; }
  li strong { display:block; margin-bottom:0.2em; }
  .links { font-size:0.9em; color:#555; }
  .links a { color:#06c; text-decoration:none; margin-right:0.4em; }
  .links a:hover { text-decoration:underline; }
  .raw { color:#999; margin-left:1em; font-size:0.9em; }
  .raw a { color:#888; }
  .ix-confidence { display:inline-block; padding:0.05em 0.4em; border-radius:3px; font-size:0.65em; font-weight:600; vertical-align:middle; margin-left:0.4em; }
  .ix-confidence-high { background:#e3fcef; color:#006644; }
  .ix-confidence-medium { background:#fff0b3; color:#7a5d00; }
  .ix-confidence-low { background:#ffebe6; color:#bf2600; }
</style></head><body>
<h1>code2wiki local preview</h1>
<p class="preamble">Browsable preview for <strong>${name}</strong>: <span class="count">${entries.length}</span> page(s). Generated <time data-c2w-localize datetime="${nowIso}" title="${nowIso}">${nowIso}</time>. No network calls; nothing was published.</p>
${sections}
${LOCALIZE_TIME_SCRIPT}
</body></html>`;
}
