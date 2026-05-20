import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { loadConfig } from "../../core/config.js";
import type { Config } from "../../core/types.js";

/**
 * Validate the config file and inspect the output directory for sanity.
 * Returns non-zero exit code on failure.
 */
export async function runValidate(opts: { cwd: string }): Promise<void> {
  let failed = false;
  let config: Config | undefined;

  try {
    config = await loadConfig(opts.cwd);
    console.log("✓ Config loaded and validated");
  } catch (e) {
    console.error(`✗ Config invalid: ${(e as Error).message}`);
    failed = true;
  }

  const outDir = path.join(opts.cwd, config?.output ?? "./docs/use-cases");
  try {
    const entries = await fs.readdir(outDir);
    const mdFiles = entries.filter((e) => e.endsWith(".md"));
    if (!mdFiles.length) {
      console.log(`  (no generated docs yet under ${outDir})`);
    } else {
      let okCount = 0;
      for (const f of mdFiles) {
        const raw = await fs.readFile(path.join(outDir, f), "utf-8");
        const fm = matter(raw);
        if (
          fm.data["code2wiki_id"] &&
          fm.data["title"] &&
          fm.data["slug"]
        ) {
          okCount++;
        } else {
          console.error(`  ✗ ${f}: missing required frontmatter`);
          failed = true;
        }
      }
      console.log(
        `✓ ${okCount}/${mdFiles.length} generated docs have valid frontmatter`,
      );
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      console.error(`✗ Could not read output dir: ${err.message}`);
      failed = true;
    }
  }

  if (failed) process.exit(1);
  console.log("All checks passed.");
}
