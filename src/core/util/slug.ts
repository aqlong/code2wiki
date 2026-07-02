/**
 * Convert a human-readable title into a stable, URL-safe slug.
 * "Register a New Pet Owner" -> "register-a-new-pet-owner"
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80)
    // Trim leading/trailing dashes AFTER the cap: a slice that lands on a
    // dash boundary (e.g. a long "word word word ..." title where the 80th
    // char is a dash separator) would otherwise leave a trailing "-" in
    // the slug. That dash bleeds into stableId's
    // `${language}-${path}-${fn}-v1` template, producing a visible "--v1"
    // double dash on the upsert key.
    .replace(/^-+|-+$/g, "");
}

/**
 * Stable hash from a (relativePath, name) pair, suitable for use as code2wiki_id.
 * Deterministic; same input always produces same output.
 */
export function stableId(language: string, relativePath: string, name: string): string {
  // Cheap deterministic hash, no crypto needed for an identifier.
  // Format: <lang>-<sanitized-path>-<sanitized-name>-v1
  const path = relativePath
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  const fn = slugify(name);
  // Collapse any dash run in the assembled id. `path` or `fn` can be empty
  // (a file literally named ".cfc" sanitizes its stem to "", and a name with
  // no ASCII-alphanumerics slugifies to ""); an empty component at a join
  // boundary would otherwise emit the exact "--v1"/"--" double dash the
  // slugify 80-char-cap fix already guards against on the slug side, and the
  // same failure follows (a publisher fails the upsert or creates a
  // duplicate page). This is a no-op for every well-formed id, none contain
  // a dash run, so existing upsert keys never rotate.
  return `${language}-${path}-${fn}-v1`.replace(/-{2,}/g, "-");
}
