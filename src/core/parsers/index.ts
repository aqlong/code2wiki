import path from "node:path";
import fs from "node:fs/promises";
import type { Candidate, JavaSurfaceMode } from "../types.js";
import { parseJava } from "./java.js";
import { parseCfml } from "./cfml.js";
import { parseRuby } from "./ruby.js";
import { parseDjango } from "./django.js";

export interface ParseFileOptions {
  /** Forwarded to parseJava for .java files. Ignored for other
   *  extensions. Default ('annotated') is applied in parseJava. */
  javaSurfaceMode?: JavaSurfaceMode;
  /** Forwarded to parseJava. When true, JMH benchmark classes are
   *  surfaced instead of skipped. Default false. */
  includeJmhBenchmarks?: boolean;
}

/**
 * Pick a parser by file extension, run it, and return the candidates.
 * Returns an empty array for unsupported file types.
 */
export async function parseFile(
  filePath: string,
  projectRoot: string,
  options: ParseFileOptions = {},
): Promise<Candidate[]> {
  const ext = path.extname(filePath).toLowerCase();
  const source = await fs.readFile(filePath, "utf-8");
  const relativePath = path.relative(projectRoot, filePath);

  switch (ext) {
    case ".java":
      return parseJava(filePath, relativePath, source, {
        surfaceMode: options.javaSurfaceMode,
        includeJmhBenchmarks: options.includeJmhBenchmarks,
      });
    case ".cfc":
    case ".cfm":
      return parseCfml(filePath, relativePath, source);
    case ".rb":
      return parseRuby(filePath, relativePath, source);
    case ".py":
      return parseDjango(filePath, relativePath, source);
    case ".cs":
      return [];
    case ".cshtml":
    case ".vbhtml":
      console.warn(
        `[code2wiki] ${ext} files are not yet supported (file: ${relativePath}). No candidates produced.`,
      );
      return [];
    default:
      return [];
  }
}

export { parseJava, parseCfml, parseRuby, parseDjango };
