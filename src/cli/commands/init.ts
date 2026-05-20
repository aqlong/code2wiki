import fs from "node:fs/promises";
import path from "node:path";
import { defaultConfig } from "../../core/config.js";

export async function runInit(opts: { cwd: string }): Promise<void> {
  const target = path.join(opts.cwd, "code2wiki.config.json");
  let exists = false;
  try {
    await fs.access(target);
    exists = true;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
  }
  if (exists) {
    console.error(`code2wiki.config.json already exists at ${target}`);
    process.exit(1);
    return;
  }
  const cfg = defaultConfig();
  await fs.writeFile(target, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${target}`);
  console.log("Next: run `code2wiki list` to see candidates.");
}
