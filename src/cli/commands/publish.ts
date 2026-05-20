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
  PageInput,
  Publisher,
  CoexistenceConfig,
  PublishMode,
} from "../../core/publishers/types.js";
import {
  hasCollisions,
  writePreflight,
  type PreflightResult,
  type Preflighter,
} from "../../core/publishers/preflight.js";
import { appendAuditEntry, hashContent } from "../../core/audit.js";
import { currentCommit } from "../../core/git.js";
import type { PublishTargetConfig } from "../../core/types.js";

export interface PublishOptions {
  cwd: string;
  /** "confluence" or "notion" */
  target: string;
  dryRun?: boolean;
  /** Override mode from CLI; takes precedence over config. */
  mode?: PublishMode;
  /** Proceed past collisions in claim mode. */
  ignoreCollisions?: boolean;
}

const VALID_MODES: ReadonlyArray<PublishMode> = [
  "greenfield",
  "claim",
  "parallel",
];

export async function runPublish(opts: PublishOptions): Promise<void> {
  if (opts.mode && !VALID_MODES.includes(opts.mode)) {
    console.error(
      `[code2wiki publish] Invalid --mode '${opts.mode}'. Allowed: ${VALID_MODES.join(", ")}.`,
    );
    process.exit(1);
  }

  const config = await loadConfig(opts.cwd);
  const outDir = path.join(opts.cwd, config.output);

  let files: string[];
  try {
    files = (await fs.readdir(outDir)).filter((f) => f.endsWith(".md"));
  } catch {
    console.error(
      `[code2wiki publish] Output directory ${config.output} does not exist. Run \`code2wiki generate\` first.`,
    );
    process.exit(1);
  }
  if (!files.length) {
    console.error(
      `[code2wiki publish] No Markdown files in ${config.output}. Run \`code2wiki generate\` first.`,
    );
    process.exit(1);
  }

  const pages: PageInput[] = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(outDir, file), "utf-8");
    const fm = matter(raw);
    const id = fm.data["code2wiki_id"] as string | undefined;
    const title = fm.data["title"] as string | undefined;
    const slug = fm.data["slug"] as string | undefined;
    if (!id || !title || !slug) {
      console.error(`  ⚠ ${file}: missing frontmatter, skipping`);
      continue;
    }
    pages.push({
      code2wiki_id: id,
      title,
      slug,
      markdown: raw,
      tags: (fm.data["tags"] as string[] | undefined) ?? [],
    });
  }

  // Resolve target-specific config (mode, slug prefix, banner).
  const targetCfg = config.publish[opts.target as "confluence" | "notion"];
  const mode = opts.mode ?? targetCfg?.mode ?? "greenfield";
  const commit = await currentCommit(opts.cwd);
  const coexistence = buildCoexistence(targetCfg, mode, commit);

  let publisher: Publisher & Partial<Preflighter>;
  if (opts.target === "confluence") {
    const cfg = confluenceConfigFromEnv(targetCfg, coexistence);
    publisher = new ConfluencePublisher(cfg, { dryRun: opts.dryRun });
  } else if (opts.target === "notion") {
    const cfg = notionConfigFromEnv(coexistence);
    publisher = new NotionPublisher(cfg, { dryRun: opts.dryRun });
  } else {
    console.error(
      `[code2wiki publish] Unknown target '${opts.target}'. Supported: confluence, notion.`,
    );
    process.exit(1);
  }

  console.log(
    `[code2wiki publish] ${opts.dryRun ? "(dry run) " : ""}publishing ${pages.length} page(s) to ${publisher.name} (mode=${mode})…`,
  );

  // Preflight is read-only; always run unless dry-run AND no preflighter.
  if (!opts.dryRun && publisher.preflight) {
    const pre = await publisher.preflight(pages);
    await writePreflight(opts.cwd, pre);
    printPreflightSummary(pre);
    if (mode === "claim" && hasCollisions(pre) && !opts.ignoreCollisions) {
      console.error(
        `[code2wiki publish] claim mode: ${pre.summary.collision} collision(s) detected. ` +
          `Run \`code2wiki claim …\` for each, or pass --ignore-collisions to override.`,
      );
      process.exit(2);
    }
  }

  const results = await publisher.publish(pages);
  let created = 0,
    updated = 0,
    skipped = 0;
  for (const r of results) {
    if (r.outcome === "created") created++;
    else if (r.outcome === "updated") updated++;
    else if (r.outcome === "skipped") skipped++;
    const symbol =
      r.outcome === "created"
        ? "+"
        : r.outcome === "updated"
          ? "~"
          : r.outcome === "skipped"
            ? "✗"
            : "·";
    const url = r.url ? ` ${r.url}` : "";
    const reason = r.message ? `  (${r.message})` : "";
    console.log(`  ${symbol} ${r.page.slug}${url}${reason}`);
    if (!opts.dryRun) {
      await appendAuditEntry(opts.cwd, {
        operation: "publish",
        commit,
        page: r.page.slug,
        outcome: r.outcome === "skipped" ? "error" : r.outcome,
        contentHash: hashContent(r.page.markdown),
        details: {
          target: publisher.name,
          mode,
          externalId: r.externalId,
          url: r.url,
          message: r.message,
        },
      });
    }
  }
  console.log(
    `[code2wiki publish] done: ${created} created, ${updated} updated, ${skipped} skipped`,
  );
  if (skipped > 0 && !opts.dryRun) process.exit(2);
}

function printPreflightSummary(p: PreflightResult): void {
  const s = p.summary;
  console.log(
    `[preflight] target=${p.target} mode=${p.mode}: ` +
      `clean:${s.clean} managed:${s.managed} collision:${s.collision} renamed:${s.renamed}`,
  );
  for (const e of p.entries) {
    if (e.outcome === "collision" || e.outcome === "renamed") {
      const url = e.existing?.url ? ` ${e.existing.url}` : "";
      const action = e.suggested_action ? `   suggested: ${e.suggested_action}` : "";
      console.log(`  ! ${e.outcome.padEnd(9)} ${e.title}${url}${action}`);
    }
  }
}

function buildCoexistence(
  targetCfg: PublishTargetConfig | undefined,
  mode: PublishMode,
  commit: string,
): CoexistenceConfig {
  const banner = targetCfg?.banner;
  const repoName =
    banner?.repoName ?? path.basename(process.cwd()) ?? "your-repo";
  return {
    mode,
    slugPrefix: targetCfg?.slugPrefix ?? (mode === "parallel" ? "code2wiki/" : undefined),
    titlePrefix: targetCfg?.titlePrefix,
    banner: {
      repoName,
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
      `[code2wiki publish] Missing required env var ${name}. Add it to .env and re-run.`,
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
