/**
 * PROMPT_VERSION comparison helpers shared between the replay command
 * and any future audit-log filter that wants to gate on prompt version.
 *
 * The format is `v<integer>` (see PROMPT_VERSION in core/llm/prompts.ts).
 * Comparison is numeric on the integer suffix, NOT lexicographic, lex
 * order would put "v10" between "v1" and "v2", which silently breaks
 * `--since-version v9` when v10 lands. Falls back to lex compare for
 * malformed inputs so we don't throw on legacy / hand-edited audit
 * entries; sane monotonic inputs always hit the numeric branch.
 */
export function promptVersionLte(a: string, b: string): boolean {
  const numA = /^v(\d+)$/.exec(a)?.[1];
  const numB = /^v(\d+)$/.exec(b)?.[1];
  if (numA !== undefined && numB !== undefined) {
    return Number(numA) <= Number(numB);
  }
  return a <= b;
}
