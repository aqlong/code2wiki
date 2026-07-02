import { execFile } from "node:child_process";
import { promisify } from "node:util";

// execFile (NOT exec) so git args are passed as an argv array with no shell
// in between. The `ref` in changedFilesSince comes from the operator's
// `--since <ref>` flag; a shell-string `git diff ... ${ref} ...` would let a
// ref carrying shell metacharacters (e.g. "HEAD; rm -rf ~") break out of the
// git command and execute. argv passing makes the ref a single literal
// argument git either resolves or rejects, never a command boundary.
const execFileAsync = promisify(execFile);

/** Best-effort: get the short SHA of HEAD. Returns 'unknown' if not in a git repo. */
export async function currentCommit(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--short", "HEAD"],
      { cwd },
    );
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Get the list of files changed between a ref and HEAD.
 * Returns paths relative to the repository root.
 *
 * Special handling for "uncommitted": returns files in the working tree
 * that differ from HEAD (staged + unstaged).
 *
 * Returns null if the git command fails (e.g. ref doesn't exist), so the
 * caller can fall back to "regenerate everything" rather than producing
 * an incorrect empty list.
 */
export async function changedFilesSince(
  cwd: string,
  ref: string,
): Promise<string[] | null> {
  try {
    const args =
      ref === "uncommitted"
        ? ["diff", "--name-only", "HEAD"]
        : ["diff", "--name-only", ref, "HEAD"];
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}
