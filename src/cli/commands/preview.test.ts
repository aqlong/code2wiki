import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPreview } from "./preview.js";

/**
 * Pins the `code2wiki preview` CLI contract shipped 1a47065 (2026-05-13).
 * Customers run `code2wiki preview` as a pre-publish smoke; the four
 * per-page artifacts AND the top-level index are the entire surface
 * the dashboard's `/dashboard/runs/[id]/[slug]?as=...` proxy keys off,
 * so a rename or path-shape regression would silently break both the
 * CLI demo and the hosted preview tab.
 *
 * Each test isolates one load-bearing branch:
 *   1. output-dir-not-found  -> error + exit(1) (catch at L48-53)
 *   2. empty output dir       -> error + exit(1) (guard at L54-60)
 *   3. happy path single page -> all 4 artifacts + index.html exist
 *   4. opts.out               -> custom dir wins over default
 *   5. re-run wipes preview   -> fs.rm at L62 deletes stale slug dirs
 *   6. multi-page index       -> every slug + title appears in index.html
 *   7. banner repoName fallback -> basename(cwd) flows through to HTML
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-preview-cli-"));
  await fs.writeFile(
    path.join(dir, "code2wiki.config.json"),
    JSON.stringify({
      output: "./docs/use-cases",
      include: ["src/**/*.cfc"],
    }),
    "utf-8",
  );
});

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureConsole(): { log: string[]; error: string[] } {
  const log: string[] = [];
  const error: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => {
    log.push(s);
  });
  vi.spyOn(console, "error").mockImplementation((s: string) => {
    error.push(s);
  });
  return { log, error };
}

function spyExit(): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(process, "exit")
    .mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${String(code ?? 0)}`);
    });
}

const SAMPLE_PAGE = (slug: string, title: string): string => `---
code2wiki_id: ${slug}-v1
title: ${title}
slug: ${slug}
actor: An internal application caller
status: active
last_generated: 2026-05-13T00:00:00Z
last_commit: 0000000
confidence: high
source_files:
  - path: src/${slug}.cfc
    lines: 1-3
tags:
  - sample
---

<!-- code2wiki:managed:start id=${slug}-v1 -->

## Summary

A short summary line.

## Actor and triggers

- **Actor:** An internal application caller.

<!-- code2wiki:managed:end -->
`;

describe("runPreview", () => {
  // Output-dir-not-found: a customer who runs `code2wiki preview` BEFORE
  // `code2wiki generate` should see the actionable error pointing them
  // at the missing step. A regression that swallowed the readdir catch
  // would produce an empty preview dir with no signal; one that exited
  // 0 would break shell pipelines that gate on the exit code.
  it("exits 1 with an actionable error when the output dir is missing", async () => {
    const { error } = captureConsole();
    const exit = spyExit();

    await expect(runPreview({ cwd: dir })).rejects.toThrow("exit:1");

    expect(exit).toHaveBeenCalledWith(1);
    expect(error.join("\n")).toMatch(/output dir not found/);
    expect(error.join("\n")).toMatch(/Run `code2wiki generate` first/);
    const missingOutDir = path.join(dir, "docs", "use-cases");
    expect(error.join("\n")).toContain(missingOutDir);
  });

  // Empty output dir is the second user-confusion mode (generate ran
  // but produced nothing, e.g. all candidates filtered out). Same
  // exit+error contract; the error MUST reference the path so the
  // operator can `ls` it without re-deriving from config.output.
  it("exits 1 with an actionable error when the output dir has no markdown", async () => {
    await fs.mkdir(path.join(dir, "docs", "use-cases"), { recursive: true });
    // Drop a non-md file to confirm the .md filter is what's empty, not
    // the dir-listing, a regression dropping the `.endsWith(".md")`
    // filter would falsely "find" pages here.
    await fs.writeFile(
      path.join(dir, "docs", "use-cases", "README.txt"),
      "not a use case",
      "utf-8",
    );
    const { error } = captureConsole();
    const exit = spyExit();

    await expect(runPreview({ cwd: dir })).rejects.toThrow("exit:1");

    expect(exit).toHaveBeenCalledWith(1);
    expect(error.join("\n")).toMatch(/no markdown files in/);
    expect(error.join("\n")).toContain(path.join(dir, "docs", "use-cases"));
  });

  // Happy path: every page must produce exactly the four artifacts the
  // dashboard proxy + the CLI index reference. A rename ("preview.html"
  // → "preview.htm"; "confluence.json" → "confluence-storage.json")
  // would compile clean, pass typecheck, and break every customer's
  // bookmark + the dashboard's tab switcher. Pin each path explicitly,
  // not via a glob: globs hide rename regressions inside their match.
  it("writes confluence.html + confluence.xhtml + notion.html + notion.json per page + index.html", async () => {
    const outDir = path.join(dir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, "page-one.md"),
      SAMPLE_PAGE("page-one", "Page One"),
      "utf-8",
    );
    captureConsole();

    await runPreview({ cwd: dir });

    const previewDir = path.join(dir, ".code2wiki", "preview");
    const pageDir = path.join(previewDir, "page-one");
    await expect(fs.access(path.join(pageDir, "confluence.html")))
      .resolves.toBeUndefined();
    await expect(fs.access(path.join(pageDir, "confluence.xhtml")))
      .resolves.toBeUndefined();
    await expect(fs.access(path.join(pageDir, "notion.html")))
      .resolves.toBeUndefined();
    await expect(fs.access(path.join(pageDir, "notion.json")))
      .resolves.toBeUndefined();
    await expect(fs.access(path.join(previewDir, "index.html")))
      .resolves.toBeUndefined();

    // notion.json MUST be JSON.parse-able: a regression writing raw
    // markdown there would still create the file but break every
    // downstream consumer.
    const notionRaw = await fs.readFile(
      path.join(pageDir, "notion.json"),
      "utf-8",
    );
    const blocks = JSON.parse(notionRaw) as unknown[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);

    // Confluence HTML preview must carry the page title (escaped) AND
    // the body, defensive against a regression that wrote an empty
    // shell when markdownToConfluenceStorage threw.
    const cfHtml = await fs.readFile(
      path.join(pageDir, "confluence.html"),
      "utf-8",
    );
    expect(cfHtml).toContain("Page One");
    expect(cfHtml).toMatch(/Summary/);
  });

  // opts.out is the dashboard's escape hatch: it preview-renders into
  // a tmpdir it owns rather than colliding with the customer's
  // `.code2wiki/preview/`. A regression hard-coding the default would
  // silently shove customer state into the dashboard's tmpdir.
  it("writes to opts.out when provided, not the default .code2wiki/preview/ dir", async () => {
    const outDir = path.join(dir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, "page-one.md"),
      SAMPLE_PAGE("page-one", "Page One"),
      "utf-8",
    );
    const customOut = path.join(dir, "custom-preview-dir");
    captureConsole();

    await runPreview({ cwd: dir, out: customOut });

    await expect(fs.access(path.join(customOut, "index.html")))
      .resolves.toBeUndefined();
    // Default location MUST be absent so a future regression that
    // ALWAYS writes to both surfaces here.
    await expect(
      fs.access(path.join(dir, ".code2wiki", "preview", "index.html")),
    ).rejects.toThrow();
  });

  // Re-run wipes preview dir (fs.rm at L62 with recursive+force). A
  // regression dropping this would let stale slug dirs accumulate from
  // pages that were removed between runs: customers would see the
  // index list ONLY the new pages but the slug dirs would still
  // contain the old artifacts, surfacing as dangling links from
  // operator-provided shells or browser bookmarks.
  it("wipes the preview dir on re-run so stale slug dirs from prior runs are removed", async () => {
    const outDir = path.join(dir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, "page-one.md"),
      SAMPLE_PAGE("page-one", "Page One"),
      "utf-8",
    );
    captureConsole();

    await runPreview({ cwd: dir });

    // Manually inject a "stale" slug dir from a hypothetical prior run.
    const previewDir = path.join(dir, ".code2wiki", "preview");
    const stalePageDir = path.join(previewDir, "old-stale-slug");
    await fs.mkdir(stalePageDir, { recursive: true });
    await fs.writeFile(
      path.join(stalePageDir, "confluence.html"),
      "<!doctype html><!-- stale content from prior run -->",
      "utf-8",
    );

    await runPreview({ cwd: dir });

    // The stale dir MUST be gone. The current run's page-one dir MUST
    // still exist.
    await expect(fs.access(stalePageDir)).rejects.toThrow();
    await expect(
      fs.access(path.join(previewDir, "page-one", "confluence.html")),
    ).resolves.toBeUndefined();
  });

  // index.html lists every page: a regression that built the entries
  // array correctly but rendered only the first slug (a `entries[0]`
  // typo for `entries.map`) would silently hide all but one preview
  // from the operator's first browser visit.
  it("index.html lists every page's slug + title in a multi-page run", async () => {
    const outDir = path.join(dir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, "alpha-page.md"),
      SAMPLE_PAGE("alpha-page", "Alpha Heading"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(outDir, "beta-page.md"),
      SAMPLE_PAGE("beta-page", "Beta Heading"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(outDir, "gamma-page.md"),
      SAMPLE_PAGE("gamma-page", "Gamma Heading"),
      "utf-8",
    );
    captureConsole();

    await runPreview({ cwd: dir });

    const indexHtml = await fs.readFile(
      path.join(dir, ".code2wiki", "preview", "index.html"),
      "utf-8",
    );
    // Each slug appears as the relative link prefix; each title as the
    // <strong> label. Pin both: a regression dropping the title leaves
    // an empty <strong>; a regression dropping the slug breaks the
    // href.
    for (const [slug, title] of [
      ["alpha-page", "Alpha Heading"],
      ["beta-page", "Beta Heading"],
      ["gamma-page", "Gamma Heading"],
    ]) {
      expect(indexHtml).toContain(`href="${slug}/confluence.html"`);
      expect(indexHtml).toContain(`href="${slug}/notion.html"`);
      expect(indexHtml).toContain(title);
    }
  });

  // Banner config pulls repoName + sourceLink from
  // publish.confluence.banner when present. A regression that
  // forgot to wire config.publish?.confluence into resolveBannerInputs
  // would silently fall back to the basename + example.invalid
  // placeholder even when the customer set a real repo url.
  it("uses publish.confluence.banner.repoName + repoUrl when configured", async () => {
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({
        output: "./docs/use-cases",
        include: ["src/**/*.cfc"],
        publish: {
          confluence: {
            banner: {
              repoName: "configured-customer-repo",
              repoUrl: "https://example.com/configured-customer-repo",
            },
          },
        },
      }),
      "utf-8",
    );
    const outDir = path.join(dir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, "page-one.md"),
      SAMPLE_PAGE("page-one", "Page One"),
      "utf-8",
    );
    captureConsole();

    await runPreview({ cwd: dir });

    const cfHtml = await fs.readFile(
      path.join(dir, ".code2wiki", "preview", "page-one", "confluence.html"),
      "utf-8",
    );
    expect(cfHtml).toContain("configured-customer-repo");
    expect(cfHtml).toContain("https://example.com/configured-customer-repo");
    // The basename of the tmpdir (random suffix) MUST NOT appear, that
    // would mean the config was ignored and the basename fallback fired.
    expect(cfHtml).not.toContain(path.basename(dir));
  });

  // Banner source-link fallback. When the config supplies no banner,
  // resolveBannerInputs writes the explicit `https://example.invalid/...`
  // placeholder, intentionally chosen so the operator sees an obviously
  // broken link in the preview and remembers to set publish.confluence.banner.repoUrl
  // before going live. A regression that swallowed the fallback (empty
  // href, "#") would ship preview pages with subtly broken View source
  // links the operator wouldn't notice until publish-time.
  it("uses the example.invalid placeholder sourceLink when config has no banner", async () => {
    const outDir = path.join(dir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, "page-one.md"),
      SAMPLE_PAGE("page-one", "Page One"),
      "utf-8",
    );
    captureConsole();

    await runPreview({ cwd: dir });

    const cfHtml = await fs.readFile(
      path.join(dir, ".code2wiki", "preview", "page-one", "confluence.html"),
      "utf-8",
    );
    expect(cfHtml).toMatch(/https:\/\/example\.invalid\//);
  });

  // Pandoc-style footnotes in the body MUST round-trip through the
  // publisher's transformFootnotes pipeline into a `## Footnotes`
  // section in the rendered HTML. A regression bypassing
  // markdownToConfluenceStorage in either renderConfluenceHtml or
  // renderNotionHtml (both use it today) would leave raw `[^id]`
  // tokens in the output, confusing operators reading the preview.
  it("renders pandoc-style footnotes into a Footnotes section in the per-page HTML", async () => {
    const outDir = path.join(dir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    const pageWithFootnotes = `---
code2wiki_id: footnote-page-v1
title: Footnote Page
slug: footnote-page
actor: An internal application caller
status: active
last_generated: 2026-05-13T00:00:00Z
last_commit: 0000000
confidence: high
source_files:
  - path: src/footnote-page.cfc
    lines: 1-3
tags: []
---

<!-- code2wiki:managed:start id=footnote-page-v1 -->

## Summary

The auth step delegates to the legacy checker. [^auth]

[^auth]: Lines 42-47 of legacyAuth.cfc

<!-- code2wiki:managed:end -->
`;
    await fs.writeFile(
      path.join(outDir, "footnote-page.md"),
      pageWithFootnotes,
      "utf-8",
    );
    captureConsole();

    await runPreview({ cwd: dir });

    const cfHtml = await fs.readFile(
      path.join(
        dir,
        ".code2wiki",
        "preview",
        "footnote-page",
        "confluence.html",
      ),
      "utf-8",
    );
    expect(cfHtml).toContain("Footnotes");
    expect(cfHtml).toContain("Lines 42-47 of legacyAuth.cfc");
    // The inline ref MUST be replaced with the numeric token; a raw
    // `[^auth]` leaking through means transformFootnotes was skipped.
    expect(cfHtml).not.toContain("[^auth]");
    expect(cfHtml).toContain("[1]");

    const ntHtml = await fs.readFile(
      path.join(
        dir,
        ".code2wiki",
        "preview",
        "footnote-page",
        "notion.html",
      ),
      "utf-8",
    );
    expect(ntHtml).toContain("Footnotes");
    expect(ntHtml).not.toContain("[^auth]");
  });

  // Em-dash regression guard. The codebase was scrubbed clean of U+2014
  // 2026-05-13; the LLM prompt v3 carries the same rule. The publisher-
  // owned banner copy is one of the few places code2wiki injects its
  // own prose into customer-facing output, so an em dash sneaking into
  // bannerHtml() / buildConfluenceBanner / buildNotionBannerBlock would
  // bypass `tools/scripts/strip-em-dashes.py` (which only scans source).
  // Pin every generated artifact.
  it("renders zero em dashes (U+2014) in any generated preview artifact", async () => {
    const outDir = path.join(dir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, "page-one.md"),
      SAMPLE_PAGE("page-one", "Page One"),
      "utf-8",
    );
    captureConsole();

    await runPreview({ cwd: dir });

    const previewDir = path.join(dir, ".code2wiki", "preview");
    const pageDir = path.join(previewDir, "page-one");
    const artifacts = [
      path.join(pageDir, "confluence.html"),
      path.join(pageDir, "confluence.xhtml"),
      path.join(pageDir, "notion.html"),
      path.join(pageDir, "notion.json"),
      path.join(previewDir, "index.html"),
    ];
    const EM_DASH = "\u2014";
    for (const file of artifacts) {
      const content = await fs.readFile(file, "utf-8");
      expect(
        content,
        `em dash leaked into ${path.basename(file)}`,
      ).not.toContain(EM_DASH);
    }
  });

  // 3-page Confluence UX: sidebar cross-links + breadcrumb navigation.
  // Pins the two defects fixed in the preview command:
  //   (1) breadcrumb <a href='#'> → <a href='../index.html'>
  //   (2) sidebar lists every page; active page gets cf-active, others
  //       get a relative link to ../<slug>/confluence.html
  // The test asserts these properties on EVERY page so a regression that
  // only fixes one page (e.g. the last one iterated) fails immediately.
  it("3-page Confluence preview: one cf-active per page, cross-links in sidebar, breadcrumbs at ../index.html, zero href='#'", async () => {
    const outDir = path.join(dir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    for (const [slug, title] of [
      ["alpha", "Alpha Page"],
      ["beta", "Beta Page"],
      ["gamma", "Gamma Page"],
    ]) {
      await fs.writeFile(
        path.join(outDir, `${slug}.md`),
        SAMPLE_PAGE(slug, title),
        "utf-8",
      );
    }
    captureConsole();

    await runPreview({ cwd: dir });

    const previewDir = path.join(dir, ".code2wiki", "preview");
    const pages = [
      { slug: "alpha", title: "Alpha Page", others: ["beta", "gamma"] },
      { slug: "beta", title: "Beta Page", others: ["alpha", "gamma"] },
      { slug: "gamma", title: "Gamma Page", others: ["alpha", "beta"] },
    ];

    for (const { slug, title, others } of pages) {
      const html = await fs.readFile(
        path.join(previewDir, slug, "confluence.html"),
        "utf-8",
      );

      // Exactly one cf-active in the sidebar.
      const activeMatches = html.match(/class="cf-active"/g);
      expect(activeMatches, `${slug}: expected exactly one cf-active`).toHaveLength(1);
      // Active item contains this page's title and is NOT wrapped in <a>.
      expect(html).toContain(`class="cf-active">${title}`);

      // Each other page appears as a relative cross-link.
      for (const otherSlug of others) {
        expect(html).toContain(`href="../${otherSlug}/confluence.html"`);
      }

      // Breadcrumbs point at ../index.html, not '#'.
      expect(html).toContain('href="../index.html"');

      // Zero href='#' anywhere in the document.
      expect(html).not.toContain('href="#"');
    }
  });

  // Banner repoName falls back to path.basename(opts.cwd) when the
  // config doesn't override it. A regression resolving repoName from a
  // mutable input (e.g. process.cwd() or a hardcoded "your-repo") would
  // silently mislabel every customer's preview. The basename flows
  // into both bannerHtml() ("from <repoName>") and resolveBannerInputs'
  // sourceLink derivation, so pinning the visible string in
  // confluence.html catches both paths.
  it("derives banner repoName from path.basename(cwd) when config doesn't override it", async () => {
    // Re-mkdtemp into a name we control so we can assert on the
    // basename without coupling to the global tmpdir prefix.
    const customParent = await fs.mkdtemp(
      path.join(os.tmpdir(), "code2wiki-pv-parent-"),
    );
    const namedDir = path.join(customParent, "my-customer-repo");
    await fs.mkdir(namedDir, { recursive: true });
    await fs.writeFile(
      path.join(namedDir, "code2wiki.config.json"),
      JSON.stringify({ output: "./docs/use-cases", include: ["src/**/*.cfc"] }),
      "utf-8",
    );
    const outDir = path.join(namedDir, "docs", "use-cases");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, "page-one.md"),
      SAMPLE_PAGE("page-one", "Page One"),
      "utf-8",
    );

    try {
      captureConsole();
      await runPreview({ cwd: namedDir });

      const cfHtml = await fs.readFile(
        path.join(
          namedDir,
          ".code2wiki",
          "preview",
          "page-one",
          "confluence.html",
        ),
        "utf-8",
      );
      expect(cfHtml).toContain("my-customer-repo");
    } finally {
      await fs.rm(customParent, { recursive: true, force: true });
    }
  });
});
