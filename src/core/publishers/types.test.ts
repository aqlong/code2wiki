import { describe, it, expect } from "vitest";
import {
  extractManagedRegion,
  extractOutsideManagedRegion,
  resolveBannerInputs,
  bannerPlainText,
  buildConfluenceBanner,
  buildNotionBannerBlock,
  stripFrontmatter,
} from "./types.js";

describe("stripFrontmatter", () => {
  it("removes a leading YAML frontmatter block", () => {
    const md = "---\ncode2wiki_id: x\ntitle: T\n---\n\n# Body\n\ntext";
    expect(stripFrontmatter(md)).toBe("\n# Body\n\ntext");
  });

  it("leaves body-only markdown unchanged", () => {
    const md = "## Summary\n\nA quick test.\n";
    expect(stripFrontmatter(md)).toBe(md);
  });

  it("is non-greedy: never strips a `---` horizontal rule in the body", () => {
    // Two `---` rules in the body must survive; only the leading
    // frontmatter block (if any) is removed.
    const md = "---\ntitle: T\n---\n\nIntro\n\n---\n\nMore\n\n---\n\nEnd";
    expect(stripFrontmatter(md)).toBe("\nIntro\n\n---\n\nMore\n\n---\n\nEnd");
  });

  it("strips a CRLF-line-ending frontmatter block (Windows-edited page)", () => {
    // `publish` reads .md files raw; a page saved with CRLF endings must not
    // leak its YAML frontmatter onto the wiki as visible text.
    const md =
      "---\r\ncode2wiki_id: x\r\ntitle: T\r\n---\r\n## Summary\r\nbody\r\n";
    const out = stripFrontmatter(md);
    expect(out).toBe("## Summary\r\nbody\r\n");
    expect(out).not.toContain("code2wiki_id");
    expect(out).not.toContain("title: T");
  });
});

// ---- resolveBannerInputs ---------------------------------------------------

describe("resolveBannerInputs: sourceLink resolution", () => {
  it("uses commitUrlTemplate with {commit} substituted when commit is a real SHA", () => {
    const b = resolveBannerInputs(
      {
        banner: {
          commitUrlTemplate: "https://github.com/org/repo/commit/{commit}",
          commit: "abc1234",
        },
      },
      { repoName: "my-repo" },
    );
    expect(b.sourceLink).toBe(
      "https://github.com/org/repo/commit/abc1234",
    );
  });

  // "unknown" is the sentinel the publish command injects when `git rev-parse`
  // fails (non-git dir, bare clone, etc.). The template must NOT fire in that
  // case because the resulting URL would contain the literal string "unknown"
  // and confuse the reader. The repoUrl fallback is the correct link.
  it("skips commitUrlTemplate when commit === 'unknown' and falls back to repoUrl", () => {
    const b = resolveBannerInputs(
      {
        banner: {
          commitUrlTemplate: "https://github.com/org/repo/commit/{commit}",
          repoUrl: "https://github.com/org/repo",
          commit: "unknown",
        },
      },
      { repoName: "my-repo" },
    );
    expect(b.sourceLink).toBe("https://github.com/org/repo");
  });

  it("uses repoUrl when no commitUrlTemplate is set", () => {
    const b = resolveBannerInputs(
      { banner: { repoUrl: "https://github.com/org/repo" } },
      { repoName: "my-repo" },
    );
    expect(b.sourceLink).toBe("https://github.com/org/repo");
  });

  it("falls back to example.invalid placeholder when neither template nor repoUrl is set", () => {
    const b = resolveBannerInputs(
      { banner: {} },
      { repoName: "my-repo" },
    );
    expect(b.sourceLink).toBe("https://example.invalid/my-repo");
  });

  it("also uses placeholder when coexistenceConfig is undefined", () => {
    const b = resolveBannerInputs(undefined, { repoName: "fallback-repo" });
    expect(b.sourceLink).toBe("https://example.invalid/fallback-repo");
  });

  it("banner.repoName overrides the defaults.repoName", () => {
    const b = resolveBannerInputs(
      { banner: { repoName: "custom-name" } },
      { repoName: "git-derived-name" },
    );
    expect(b.repoName).toBe("custom-name");
    // placeholder also uses the overridden name
    expect(b.sourceLink).toContain("custom-name");
  });

  it("uses defaults.commit as a fallback when banner.commit is not set", () => {
    const b = resolveBannerInputs(
      {
        banner: {
          commitUrlTemplate: "https://example.com/{commit}",
        },
      },
      { repoName: "repo", commit: "deadbeef" },
    );
    expect(b.sourceLink).toBe("https://example.com/deadbeef");
  });

  it("banner.now seam overrides lastSyncedIso", () => {
    const b = resolveBannerInputs(
      { banner: { now: () => "2026-01-01T00:00:00.000Z" } },
      { repoName: "r" },
    );
    expect(b.lastSyncedIso).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ---- extractManagedRegion --------------------------------------------------

const FENCE = `Before the fence.

<!-- code2wiki:managed:start id=test-v1 -->
## Generated
Body text here.
<!-- code2wiki:managed:end -->

After the fence.`;

describe("extractManagedRegion", () => {
  it("returns the trimmed body between fence delimiters", () => {
    const body = extractManagedRegion(FENCE);
    expect(body).toBe("## Generated\nBody text here.");
  });

  it("returns null when there is no fence", () => {
    expect(extractManagedRegion("no fence here")).toBeNull();
  });

  it("returns null when the open comment is not closed", () => {
    expect(extractManagedRegion("<!-- code2wiki:managed:start unclosed")).toBeNull();
  });

  it("returns null when the closing tag is missing", () => {
    const noClose = "<!-- code2wiki:managed:start id=x -->\nbody\n";
    expect(extractManagedRegion(noClose)).toBeNull();
  });

  it("returns empty string (trimmed) for an empty fence body", () => {
    const empty =
      "<!-- code2wiki:managed:start -->\n<!-- code2wiki:managed:end -->";
    expect(extractManagedRegion(empty)).toBe("");
  });
});

// ---- extractOutsideManagedRegion -------------------------------------------

describe("extractOutsideManagedRegion", () => {
  it("splits before and after the fence", () => {
    const { before, after } = extractOutsideManagedRegion(FENCE);
    expect(before.trim()).toBe("Before the fence.");
    expect(after.trim()).toBe("After the fence.");
  });

  it("returns { before: fullText, after: '' } when there is no fence", () => {
    const text = "No fence content.";
    const { before, after } = extractOutsideManagedRegion(text);
    expect(before).toBe(text);
    expect(after).toBe("");
  });

  it("returns before content and empty after when close tag is missing", () => {
    const noClose =
      "Preamble.\n<!-- code2wiki:managed:start id=x -->\nbody\n";
    const { before, after } = extractOutsideManagedRegion(noClose);
    expect(before.trim()).toBe("Preamble.");
    expect(after).toBe("");
  });

  it("after includes any human-appended text that follows the fence close", () => {
    const doc =
      "<!-- code2wiki:managed:start -->\nGenerated.\n<!-- code2wiki:managed:end -->\n\nHand-written notes here.";
    const { after } = extractOutsideManagedRegion(doc);
    expect(after).toContain("Hand-written notes here.");
    // The fence close tag itself is NOT included in after
    expect(after).not.toContain("code2wiki:managed:end");
  });
});

// ---- bannerPlainText --------------------------------------------------------

const FIXED_INPUTS = {
  repoName: "acme/repo",
  sourceLink: "https://github.com/acme/repo/commit/abc123",
  lastSyncedIso: "2026-01-15T09:00:00.000Z",
};

describe("bannerPlainText", () => {
  it("contains repo name, source link, and last-synced timestamp", () => {
    const text = bannerPlainText(FIXED_INPUTS);
    expect(text).toContain("acme/repo");
    expect(text).toContain("https://github.com/acme/repo/commit/abc123");
    expect(text).toContain("2026-01-15T09:00:00.000Z");
  });

  it("stays within 500 characters for typical inputs", () => {
    // The docstring promises ≤ 500 chars. Exceeding it would cause truncation
    // in Confluence page descriptions and some Notion text blocks.
    expect(bannerPlainText(FIXED_INPUTS).length).toBeLessThanOrEqual(500);
  });
});

// ---- buildConfluenceBanner --------------------------------------------------

describe("buildConfluenceBanner", () => {
  it("wraps content in an ac:structured-macro info block", () => {
    const html = buildConfluenceBanner(FIXED_INPUTS);
    expect(html).toContain('ac:name="info"');
    expect(html).toContain("<ac:rich-text-body>");
    expect(html).toContain("</ac:structured-macro>");
  });

  it("XML-escapes repo name and source link to prevent malformed storage XML", () => {
    // A repo name or URL with XML special chars must be escaped; unescaped
    // they break Confluence's storage format and the page fails to render.
    const dangerous = buildConfluenceBanner({
      repoName: "org/<evil>&repo",
      sourceLink: 'https://host/path?a=1&b=2"x',
      lastSyncedIso: "2026-01-15T09:00:00.000Z",
    });
    expect(dangerous).not.toContain("<evil>");
    expect(dangerous).not.toContain("&repo");
    expect(dangerous).toContain("&lt;evil&gt;");
    expect(dangerous).toContain("&amp;repo");
  });

  it("includes the source link as an href", () => {
    const html = buildConfluenceBanner(FIXED_INPUTS);
    // The escaped URL must appear inside an href so the operator can click
    // through to the commit; a plain-text link is not sufficient.
    expect(html).toContain(`href="${FIXED_INPUTS.sourceLink}"`);
  });
});

// ---- buildNotionBannerBlock -------------------------------------------------

describe("buildNotionBannerBlock", () => {
  it("returns a callout block with the 📝 emoji icon", () => {
    const block = buildNotionBannerBlock(FIXED_INPUTS) as Record<string, unknown>;
    expect(block["type"]).toBe("callout");
    const callout = block["callout"] as Record<string, unknown>;
    const icon = callout["icon"] as Record<string, unknown>;
    expect(icon["emoji"]).toBe("📝");
  });

  it("includes a 'View source' rich-text segment with the source URL as a link", () => {
    const block = buildNotionBannerBlock(FIXED_INPUTS) as Record<string, unknown>;
    const callout = block["callout"] as Record<string, unknown>;
    const richText = callout["rich_text"] as Array<Record<string, unknown>>;
    const viewSource = richText.find(
      (r) => (r["text"] as Record<string, unknown>)?.["content"] === "View source",
    );
    expect(viewSource).toBeDefined();
    const link = (viewSource!["text"] as Record<string, unknown>)["link"] as Record<string, unknown>;
    expect(link["url"]).toBe(FIXED_INPUTS.sourceLink);
  });
});
