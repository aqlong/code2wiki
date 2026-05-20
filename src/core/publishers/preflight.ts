import fs from "node:fs/promises";
import path from "node:path";
import type { PageInput, PublishMode } from "./types.js";

/**
 * Preflight conflict detection (ADR-016 §3.2).
 *
 * Each publisher implements `Preflighter.preflight(pages)` and returns a
 * `PreflightResult` whose entries categorize each generated page against
 * the destination space:
 *
 *   - clean   , no collision, will create
 *   - managed , already labeled by us, will update
 *   - collision, same title/slug exists, no label
 *   - renamed , labeled by us, but the title drifted
 *
 * The CLI prints a human-readable summary and writes the JSON to
 * `.code2wiki/preflight.json` so dashboards / CI can inspect it later.
 */

export type PreflightOutcome = "clean" | "managed" | "collision" | "renamed";

export interface PreflightExisting {
  external_id: string;
  url?: string;
  title?: string;
  /** Why this counts as a match. */
  match_reason: "label" | "title_exact_ci" | "slug_exact";
}

export interface PreflightEntry {
  code2wiki_id: string;
  title: string;
  slug: string;
  outcome: PreflightOutcome;
  existing?: PreflightExisting;
  suggested_action?: string;
}

export interface PreflightResult {
  generated_at: string;
  target: string; // "confluence" | "notion"
  mode: PublishMode;
  summary: {
    clean: number;
    managed: number;
    collision: number;
    renamed: number;
  };
  entries: PreflightEntry[];
}

export interface Preflighter {
  preflight(pages: PageInput[]): Promise<PreflightResult>;
}

const PREFLIGHT_DIR = ".code2wiki";
const PREFLIGHT_FILE = "preflight.json";

export function preflightPath(projectRoot: string): string {
  return path.join(projectRoot, PREFLIGHT_DIR, PREFLIGHT_FILE);
}

export async function writePreflight(
  projectRoot: string,
  result: PreflightResult,
): Promise<void> {
  const file = preflightPath(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(result, null, 2) + "\n", "utf-8");
}

/** Compute the summary block from the entries, in case the publisher wants
 *  to delegate that detail. */
export function summarize(entries: PreflightEntry[]): PreflightResult["summary"] {
  const summary = { clean: 0, managed: 0, collision: 0, renamed: 0 };
  for (const e of entries) summary[e.outcome] += 1;
  return summary;
}

/** Helper used by both publishers: build a "code2wiki claim --map-to=…"
 *  suggestion string from a colliding entry. */
export function suggestClaim(
  target: string,
  code2wiki_id: string,
  externalId: string,
): string {
  return `claim --target=${target} --map-to=${code2wiki_id} --page-id=${externalId}`;
}

/** Split `summary: { … }` and per-entry counts vs. flat counters. */
export function hasCollisions(result: PreflightResult): boolean {
  return result.summary.collision > 0;
}
