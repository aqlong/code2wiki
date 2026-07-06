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
      // Strip a leading UTF-8 BOM (U+FEFF) before parsing. Node's "utf-8"
      // decoder preserves the BOM, and JSON.parse then rejects it with an
      // opaque "Unexpected token '\uFEFF'" SyntaxError. Editors and shells that
      // write "UTF-8 with BOM" are a common source of this — notably Windows
      // PowerShell 5.1's `Set-Content -Encoding UTF8`, which always prepends a
      // BOM — so tolerate it instead of failing with a cryptic error.
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
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
