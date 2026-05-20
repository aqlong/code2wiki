/**
 * Audit-replay slug match: does an audit entry's page slug plausibly
 * belong to the candidate with this `name`?
 *
 * Used by `runReplay` (src/cli/commands/replay.ts) to bind an audit-log
 * `generate` entry to one of the candidates the parser found in the
 * current source tree. Multiple candidates can share a file (e.g. each
 * <cffunction> in a .cfc), so the replay walker filters by
 * `relativePath` first, then disambiguates with this matcher.
 *
 * Why a fuzzy match? Candidate does not carry a pre-computed slug,
 * the canonical slug is derived later by the extractor from the LLM's
 * title. Reproducing the renderer's slug logic here would require a
 * round-trip through the LLM, which defeats the purpose of replay's
 * read-only walk. Instead we kebab-case the candidate's `name` and
 * accept a suffix / first-segment containment match against the slug.
 * Tighter matching becomes available if/when the audit entry stores
 * the candidate name explicitly (v2 audit schema candidate).
 *
 * Trade-offs of the loose form:
 *   - false positives possible when one file has two functions whose
 *     kebabed names share a prefix (e.g. `register` and `registerNew`)
 *     and the slug is short, caller mitigates by filtering relativePath
 *     first AND by the LLM-derived title usually disambiguating in the
 *     slug.
 *   - false negatives possible when a customer renames a function
 *     after publish, replay reports `skipped: candidate not found`
 *     rather than confidently mis-matching, which is the safer side.
 */
export function slugLooksLike(name: string, slug: string): boolean {
  const namePart = name
    .replace(/^.*\./, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  if (!namePart) return false;
  return slug.includes(namePart) || namePart.includes(slug.split("-")[0] ?? "");
}
