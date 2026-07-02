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
  // Pad the language column to the widest language in this set so the kind
  // column lines up across mixed-language scans. A fixed padEnd(4) was correct
  // when only java/cfml/ruby (all 4 chars) existed, but python + unknown (6) now
  // overflow it and shove the kind column right on those rows only. Floor at 4
  // preserves the historical minimum width for all-short-language sets.
  const langWidth = Math.max(4, ...candidates.map((c) => c.language.length));
  for (const c of candidates) {
    const route = c.hints.httpRoute?.method
      ? ` [${c.hints.httpRoute.method}${c.hints.httpRoute.path ? ` ${c.hints.httpRoute.path}` : ""}]`
      : "";
    console.log(
      `  ${c.language.padEnd(langWidth)} ${c.kind.padEnd(20)} ${c.name}${route}`,
    );
    console.log(`       ${c.relativePath}:${c.lineStart}-${c.lineEnd}`);
    if (c.hints.databaseTables?.length) {
      console.log(`       tables: ${c.hints.databaseTables.join(", ")}`);
    }
    if (c.hints.notes?.length) {
      console.log(`       notes: ${c.hints.notes.join("; ")}`);
    }
  }
}
