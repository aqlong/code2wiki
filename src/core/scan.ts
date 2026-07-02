import path from "node:path";
import fg from "fast-glob";
import type { Candidate, Config } from "./types.js";
import { parseFile } from "./parsers/index.js";
import { filterConstantReturns } from "./parsers/triviality.js";

/**
 * Return absolute paths to every source file under projectRoot that matches
 * the given extension(s), applying the same exclusion rules as scanProject.
 * Used to build a broader lookup pool for dependency resolution: a Spring
 * Data repository interface (AccountRepository.java) may produce 0 candidates
 * from the parser (no HTTP/service methods to document), yet it is still a
 * valid injection target that resolveDependencies needs to find.
 */
export async function globSourceFiles(
  projectRoot: string,
  config: Config,
  extensions: string[],
): Promise<string[]> {
  const patterns = extensions.map((ext) => `**/*${ext}`);
  return fg(patterns, {
    cwd: projectRoot,
    ignore: config.exclude,
    absolute: true,
    onlyFiles: true,
    dot: false,
  });
}

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

  // Stable, locale-INDEPENDENT ordering: by relativePath (Unicode code-unit
  // comparison, the same ordering the default Array.prototype.sort uses in
  // audit.ts + snapshot.ts), then by line. Deliberately NOT localeCompare():
  // without a fixed locale arg it uses the runtime's default ICU locale, so
  // the SAME repo could order mixed-case paths differently on the operator's
  // macOS (en_US) vs the Railway/Linux worker (C/POSIX). That non-determinism
  // would ripple into page order, cross-links, and the hash-chained audit log
  // an auditor trusts. Code-unit comparison is byte-stable everywhere.
  all.sort((a, b) => {
    if (a.relativePath !== b.relativePath) {
      return a.relativePath < b.relativePath ? -1 : 1;
    }
    return a.lineStart - b.lineStart;
  });

  return filterConstantReturns(all, config.includeConstantReturns);
}
