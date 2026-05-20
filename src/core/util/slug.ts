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
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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
  return `${language}-${path}-${fn}-v1`;
}
