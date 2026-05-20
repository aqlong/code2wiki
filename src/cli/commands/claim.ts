import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { loadConfig } from "../../core/config.js";
import {
  ConfluencePublisher,
  type ConfluenceConfig,
} from "../../core/publishers/confluence.js";
import {
  NotionPublisher,
  type NotionConfig,
} from "../../core/publishers/notion.js";
import type {
  CoexistenceConfig,
  PageInput,
} from "../../core/publishers/types.js";
import { appendAuditEntry } from "../../core/audit.js";
import { currentCommit } from "../../core/git.js";
import type { PublishTargetConfig } from "../../core/types.js";

export interface ClaimOptions {
  cwd: string;
  /** Provider page ID OR full URL. */
  pageRef: string;
  target: "confluence" | "notion";
  mapTo: string;
  placement?: "above" | "below";
}

/** Resolve a Confluence URL or raw page id → page id. */
function resolveConfluencePageId(ref: string): string {
  // URL forms:
  //   https://acme.atlassian.net/wiki/spaces/DOCS/pages/123456789/Title
  //   https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=123456789
  if (/^\d+$/.test(ref)) return ref;
  const m1 = ref.match(/\/pages\/(\d+)(?:\/|$|\?)/);
  if (m1?.[1]) return m1[1];
  const m2 = ref.match(/[?&]pageId=(\d+)/);
  if (m2?.[1]) return m2[1];
  throw new Error(
    `Could not parse a Confluence page id from '${ref}'. Pass either a numeric pageId or a /pages/<id>/... URL.`,
  );
}

/** Resolve a Notion URL or page id → page id. */
function resolveNotionPageId(ref: string): string {
  // Notion page IDs are 32-char hex (with or without dashes).
  // URL form: https://www.notion.so/My-Page-Title-<32hex>?...
  const cleaned = ref.replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(cleaned)) {
    // Re-insert dashes in the standard 8-4-4-4-12 layout for the API.
    return `${cleaned.slice(0, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}-${cleaned.slice(16, 20)}-${cleaned.slice(20)}`;
  }
  const m = ref.match(/([0-9a-f]{32})/i);
  if (m?.[1]) {
    const id = m[1];
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  }
  throw new Error(
    `Could not parse a Notion page id from '${ref}'. Pass either a 32-char id or a notion.so URL.`,
  );
}

async function loadGeneratedPage(
  outDir: string,
  code2wiki_id: string,
): Promise<PageInput | null> {
  let files: string[];
  try {
    files = (await fs.readdir(outDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }
  for (const file of files) {
    const raw = await fs.readFile(path.join(outDir, file), "utf-8");
    const fm = matter(raw);
    if (fm.data["code2wiki_id"] === code2wiki_id) {
      return {
        code2wiki_id,
        title: (fm.data["title"] as string) ?? "",
        slug: (fm.data["slug"] as string) ?? "",
        markdown: raw,
        tags: (fm.data["tags"] as string[] | undefined) ?? [],
      };
    }
  }
  return null;
}

async function listAvailableIds(outDir: string): Promise<string[]> {
  const ids: string[] = [];
  let files: string[];
  try {
    files = (await fs.readdir(outDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return ids;
  }
  for (const file of files) {
    const raw = await fs.readFile(path.join(outDir, file), "utf-8");
    const fm = matter(raw);
    const id = fm.data["code2wiki_id"] as string | undefined;
    if (id) ids.push(id);
  }
  return ids.sort();
}

function buildCoexistence(
  targetCfg: PublishTargetConfig | undefined,
  commit: string,
): CoexistenceConfig {
  const banner = targetCfg?.banner;
  return {
    mode: "claim",
    slugPrefix: targetCfg?.slugPrefix,
    titlePrefix: targetCfg?.titlePrefix,
    banner: {
      repoName: banner?.repoName ?? path.basename(process.cwd()),
      repoUrl: banner?.repoUrl,
      commitUrlTemplate: banner?.commitUrlTemplate,
      commit,
    },
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `[code2wiki claim] Missing required env var ${name}. Add it to .env and re-run.`,
    );
    process.exit(1);
  }
  return v;
}

function confluenceConfigFromEnv(
  targetCfg: PublishTargetConfig | undefined,
  coexistence: CoexistenceConfig,
): ConfluenceConfig {
  return {
    baseUrl: requireEnv("CONFLUENCE_BASE_URL"),
    email: requireEnv("CONFLUENCE_EMAIL"),
    apiToken: requireEnv("CONFLUENCE_API_TOKEN"),
    spaceKey: requireEnv("CONFLUENCE_SPACE_KEY"),
    parentPageId: targetCfg?.parentPageId ?? process.env["CONFLUENCE_PARENT_PAGE_ID"],
    label: process.env["CONFLUENCE_LABEL"],
    coexistence,
  };
}

function notionConfigFromEnv(coexistence: CoexistenceConfig): NotionConfig {
  return {
    apiToken: requireEnv("NOTION_API_TOKEN"),
    databaseId: requireEnv("NOTION_DATABASE_ID"),
    apiVersion: process.env["NOTION_API_VERSION"],
    coexistence,
  };
}

export async function runClaim(opts: ClaimOptions): Promise<void> {
  if (!opts.mapTo) {
    console.error(
      "[code2wiki claim] --map-to is required. Pass the code2wiki_id of the generated page you're adopting.",
    );
    process.exit(1);
  }
  if (opts.target !== "confluence" && opts.target !== "notion") {
    console.error(
      `[code2wiki claim] --target must be 'confluence' or 'notion' (got '${opts.target}').`,
    );
    process.exit(1);
  }

  const config = await loadConfig(opts.cwd);
  const outDir = path.join(opts.cwd, config.output);
  const generated = await loadGeneratedPage(outDir, opts.mapTo);
  if (!generated) {
    const available = await listAvailableIds(outDir);
    console.error(
      `[code2wiki claim] No generated page with code2wiki_id='${opts.mapTo}'. ` +
        `Available IDs (${available.length}): ${available.slice(0, 10).join(", ")}${available.length > 10 ? "…" : ""}`,
    );
    process.exit(1);
  }

  const commit = await currentCommit(opts.cwd);
  const placement = opts.placement ?? "below";
  const targetCfg = config.publish[opts.target];
  const coexistence = buildCoexistence(targetCfg, commit);
  const repoName = coexistence.banner?.repoName ?? "your-repo";

  let result: { external_id: string; pre_claim_content_hash: string; url?: string };
  try {
    if (opts.target === "confluence") {
      const pageId = resolveConfluencePageId(opts.pageRef);
      const cfg = confluenceConfigFromEnv(targetCfg, coexistence);
      const pub = new ConfluencePublisher(cfg);
      result = await pub.claim({
        pageId,
        code2wiki_id: opts.mapTo,
        placement,
        title: generated.title,
        repoName,
        commit,
      });
    } else {
      const pageId = resolveNotionPageId(opts.pageRef);
      const cfg = notionConfigFromEnv(coexistence);
      const pub = new NotionPublisher(cfg);
      result = await pub.claim({
        pageId,
        code2wiki_id: opts.mapTo,
        placement,
        title: generated.title,
        repoName,
        commit,
      });
    }
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === "CLAIM_ABORTED") {
      const audit = await appendAuditEntry(opts.cwd, {
        operation: "claim_aborted",
        commit,
        page: opts.mapTo,
        outcome: "error",
        details: {
          target: opts.target,
          page_ref: opts.pageRef,
          error: err.message,
        },
      });
      console.error(
        `[code2wiki claim] ✗ aborted: ${err.message}\n` +
          `  audit entry: ${audit.entry_hash}`,
      );
      process.exit(2);
    }
    console.error(`[code2wiki claim] ✗ ${err.message}`);
    process.exit(2);
  }

  const audit = await appendAuditEntry(opts.cwd, {
    operation: "claim",
    commit,
    page: opts.mapTo,
    outcome: "updated",
    details: {
      target: opts.target,
      external_id: result.external_id,
      url: result.url,
      placement,
      pre_claim_content_hash: result.pre_claim_content_hash,
    },
  });
  console.log(
    `[code2wiki claim] ✓ adopted ${opts.target}:${result.external_id} → ${opts.mapTo} (placement=${placement})`,
  );
  if (result.url) console.log(`  ${result.url}`);
  console.log(`  audit entry: ${audit.entry_hash}`);
  console.log(
    `  Run \`code2wiki publish ${opts.target}\` to populate the managed region.`,
  );
}
