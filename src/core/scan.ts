import path from "node:path";
import fg from "fast-glob";
import type { Candidate, Config } from "./types.js";
import { parseFile } from "./parsers/index.js";
import { filterConstantReturns } from "./parsers/triviality.js";

/** Walk the project, run parsers on every matching file, and return all candidates. */
export async function scanProject(
  projectRoot: string,
  config: Config,
): Promise<Candidate[]> {
  const files = await fg(config.include, {
    cwd: projectRoot,
    ignore: config.exclude,
    absolute: true,
    onlyFiles: true,
    dot: false,
  });

  const all: Candidate[] = [];
  for (const file of files) {
    try {
      const candidates = await parseFile(file, projectRoot, {
        javaSurfaceMode: config.javaSurfaceMode,
        includeJmhBenchmarks: config.includeJmhBenchmarks,
      });
      all.push(...candidates);
    } catch (e) {
      // Skip individual file failures rather than aborting the whole scan.
      console.error(
        `[code2wiki] Skipping ${path.relative(projectRoot, file)}: ${
          (e as Error).message
        }`,
      );
    }
  }

  // Stable ordering: by file then by line.
  all.sort((a, b) => {
    if (a.relativePath !== b.relativePath) {
      return a.relativePath.localeCompare(b.relativePath);
    }
    return a.lineStart - b.lineStart;
  });

  return filterConstantReturns(all, config.includeConstantReturns);
}
