import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { changedFilesSince, currentCommit } from "./git.js";

const execAsync = promisify(exec);

/** Spin up a throwaway git repo so we can exercise changedFilesSince
 *  against a real git history without polluting any user-facing project. */
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-git-"));
  await execAsync("git init -q -b main", { cwd: dir });
  await execAsync('git config user.email "test@example.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  return dir;
}

async function commit(dir: string, file: string, content: string, msg: string) {
  await fs.writeFile(path.join(dir, file), content, "utf-8");
  await execAsync("git add -A", { cwd: dir });
  await execAsync(`git commit -q -m "${msg}"`, { cwd: dir });
}

describe("changedFilesSince", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await makeRepo();
    await commit(repo, "a.txt", "alpha\n", "initial");
    await commit(repo, "b.txt", "beta\n", "add b");
    await commit(repo, "a.txt", "alpha v2\n", "update a");
  });
  afterAll(async () => {
    if (repo) await fs.rm(repo, { recursive: true, force: true });
  });

  it("returns files changed between a ref and HEAD", async () => {
    const changed = await changedFilesSince(repo, "HEAD~1");
    expect(changed).toEqual(["a.txt"]);
  });

  it("returns all files changed across multiple commits", async () => {
    const changed = await changedFilesSince(repo, "HEAD~2");
    expect(changed).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
  });

  it("returns null when the ref is invalid (caller falls back to full regen)", async () => {
    const changed = await changedFilesSince(repo, "no-such-ref");
    expect(changed).toBeNull();
  });

  it("currentCommit returns a non-empty short SHA", async () => {
    const sha = await currentCommit(repo);
    expect(sha).toMatch(/^[0-9a-f]{6,12}$/);
  });

  it("currentCommit returns 'unknown' outside a git repo", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-nogit-"));
    try {
      const sha = await currentCommit(tmp);
      expect(sha).toBe("unknown");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // currentCommit pipes `git rev-parse --short HEAD` through .trim(); without
  // .trim(), the trailing "\n" from exec would propagate into the audit log's
  // commit field and into banner URLs (e.g. .../commit/abc1234\n). Pinned so
  // a refactor that swaps to spawn() / drops .trim() trips here.
  it("currentCommit strips the trailing newline from rev-parse output", async () => {
    const sha = await currentCommit(repo);
    expect(sha.includes("\n")).toBe(false);
    expect(sha.includes("\r")).toBe(false);
    expect(sha).toBe(sha.trim());
  });
});

// `--since uncommitted` is a user-facing CLI option (src/cli/index.ts:54).
// The implementation runs `git diff --name-only HEAD`, which has subtle
// semantics worth pinning so a future refactor that swaps in
// `git status --porcelain` doesn't silently change what gets regenerated.
describe("changedFilesSince: uncommitted (working-tree) ref", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await makeRepo();
    await commit(repo, "tracked.txt", "v1\n", "initial tracked");
    await commit(repo, "to-delete.txt", "doomed\n", "add to-delete");
  });
  afterAll(async () => {
    if (repo) await fs.rm(repo, { recursive: true, force: true });
  });

  it("returns [] on a clean working tree (no uncommitted changes)", async () => {
    const changed = await changedFilesSince(repo, "uncommitted");
    expect(changed).toEqual([]);
  });

  it("returns unstaged working-tree modifications", async () => {
    await fs.writeFile(path.join(repo, "tracked.txt"), "v2\n", "utf-8");
    try {
      const changed = await changedFilesSince(repo, "uncommitted");
      expect(changed).toEqual(["tracked.txt"]);
    } finally {
      await execAsync("git checkout -- tracked.txt", { cwd: repo });
    }
  });

  it("returns staged-but-uncommitted changes (git add'd files)", async () => {
    await fs.writeFile(path.join(repo, "staged.txt"), "added\n", "utf-8");
    await execAsync("git add staged.txt", { cwd: repo });
    try {
      const changed = await changedFilesSince(repo, "uncommitted");
      expect(changed).toEqual(["staged.txt"]);
    } finally {
      await execAsync("git reset -q HEAD staged.txt", { cwd: repo });
      await fs.rm(path.join(repo, "staged.txt"), { force: true });
    }
  });

  // Documented surprise: `git diff --name-only HEAD` excludes UNTRACKED files,
  // so `code2wiki generate --since uncommitted` silently skips brand-new files
  // until the user `git add`s them. Pinned so a future change that swaps in
  // `git status --porcelain` (which DOES include `?? new-file`) ships as an
  // intentional semantic change, not an accidental one.
  it("does NOT include untracked files (only tracked diff vs HEAD)", async () => {
    await fs.writeFile(path.join(repo, "untracked.txt"), "new\n", "utf-8");
    try {
      const changed = await changedFilesSince(repo, "uncommitted");
      expect(changed).toEqual([]);
    } finally {
      await fs.rm(path.join(repo, "untracked.txt"), { force: true });
    }
  });

  // A working-tree deletion shows up in `git diff --name-only HEAD` as the
  // deleted path. Pinned so the `--since uncommitted` flow regenerates (or
  // at least surfaces) deletions, not just modifications.
  it("includes working-tree deletions of tracked files", async () => {
    await fs.rm(path.join(repo, "to-delete.txt"));
    try {
      const changed = await changedFilesSince(repo, "uncommitted");
      expect(changed).toEqual(["to-delete.txt"]);
    } finally {
      await execAsync("git checkout -- to-delete.txt", { cwd: repo });
    }
  });

  // Both staged + unstaged paths surface together in one call; `git diff
  // --name-only HEAD` unions the index and the working tree. Pinned so a
  // refactor that splits the diff into two `git diff --staged` / `git diff`
  // calls would have to combine + dedupe explicitly.
  it("returns BOTH staged and unstaged changes in a single call", async () => {
    await fs.writeFile(path.join(repo, "tracked.txt"), "v2\n", "utf-8");
    await fs.writeFile(path.join(repo, "staged2.txt"), "added\n", "utf-8");
    await execAsync("git add staged2.txt", { cwd: repo });
    try {
      const changed = await changedFilesSince(repo, "uncommitted");
      expect(changed?.sort()).toEqual(["staged2.txt", "tracked.txt"]);
    } finally {
      await execAsync("git reset -q HEAD staged2.txt", { cwd: repo });
      await execAsync("git checkout -- tracked.txt", { cwd: repo });
      await fs.rm(path.join(repo, "staged2.txt"), { force: true });
    }
  });

  // Single-file modify-twice (stage v1, then modify working tree to v2)
  // surfaces the file ONCE; git diff de-dupes by path. A regression that
  // concatenated two `git diff` outputs without dedupe would return the
  // same path twice and cause downstream scanProject to process it twice.
  it("dedupes a file that has both staged + unstaged edits to once", async () => {
    await fs.writeFile(path.join(repo, "tracked.txt"), "v2-staged\n", "utf-8");
    await execAsync("git add tracked.txt", { cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "v3-unstaged\n", "utf-8");
    try {
      const changed = await changedFilesSince(repo, "uncommitted");
      expect(changed).toEqual(["tracked.txt"]);
    } finally {
      await execAsync("git reset -q HEAD tracked.txt", { cwd: repo });
      await execAsync("git checkout -- tracked.txt", { cwd: repo });
    }
  });

  // Non-git directory must yield null (same fallback path as the named-ref
  // failure case), so the caller can fall back to full regen rather than an
  // incorrect empty list. Pinned because the try/catch in git.ts wraps BOTH
  // branches (uncommitted + named-ref); a refactor that narrows the catch
  // could regress the uncommitted branch silently.
  it("returns null when the cwd is not a git repo (uncommitted branch)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-nogit-"));
    try {
      const changed = await changedFilesSince(tmp, "uncommitted");
      expect(changed).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
