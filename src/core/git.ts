import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Best-effort: get the short SHA of HEAD. Returns 'unknown' if not in a git repo. */
export async function currentCommit(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync("git rev-parse --short HEAD", {
      cwd,
    });
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
    if (ref === "uncommitted") {
      const { stdout } = await execAsync(`git diff --name-only HEAD`, {
        cwd,
      });
      return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    }
    const { stdout } = await execAsync(
      `git diff --name-only ${ref} HEAD`,
      { cwd },
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}
