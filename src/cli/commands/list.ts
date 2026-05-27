import { loadConfig } from "../../core/config.js";
import { scanProject } from "../../core/scan.js";

export async function runList(opts: { cwd: string }): Promise<void> {
  const config = await loadConfig(opts.cwd);
  const candidates = await scanProject(opts.cwd, config);

  if (candidates.length === 0) {
    console.log("No candidates found. Adjust include/exclude in your config.");
    return;
  }

  console.log(
    `Found ${candidates.length} candidate use cases (showing all):\n`,
  );
  for (const c of candidates) {
    const route =
      c.hints.httpRoute && c.hints.httpRoute.method
        ? ` [${c.hints.httpRoute.method}]`
        : "";
    console.log(
      `  ${c.language.padEnd(4)} ${c.kind.padEnd(20)} ${c.name}${route}`,
    );
    console.log(`       ${c.relativePath}:${c.lineStart}-${c.lineEnd}`);
    if (c.companionFile) {
      const handlers = c.handlerNames?.join(", ") ?? "";
      console.log(
        `       companion: ${c.companionFile}${handlers ? `  handlers: ${handlers}` : ""}`,
      );
    }
    if (c.hints.databaseTables?.length) {
      console.log(`       tables: ${c.hints.databaseTables.join(", ")}`);
    }
    if (c.hints.notes?.length) {
      console.log(`       notes: ${c.hints.notes.join("; ")}`);
    }
  }
}
