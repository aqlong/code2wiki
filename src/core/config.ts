import fs from "node:fs/promises";
import path from "node:path";
import { ConfigSchema, type Config } from "./types.js";

const CONFIG_FILENAMES = [
  "code2wiki.config.json",
  ".code2wiki/config.json",
];

/** Load and validate the config file from a project root. */
export async function loadConfig(projectRoot: string): Promise<Config> {
  for (const name of CONFIG_FILENAMES) {
    const fullPath = path.join(projectRoot, name);
    try {
      const raw = await fs.readFile(fullPath, "utf-8");
      const parsed = JSON.parse(raw);
      return ConfigSchema.parse(parsed);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") continue;
      throw new Error(
        `Failed to load ${name}: ${err.message ?? String(e)}`,
      );
    }
  }
  return ConfigSchema.parse({});
}

/** Default config object, useful for `code2wiki init`. */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
