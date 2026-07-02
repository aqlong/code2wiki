import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// vi.mock is hoisted. To exercise the publisher-driven half of `runPublish`
// (preflight, claim-mode collision gating, per-page audit emission, dry-run
// behaviour) without making real HTTP calls, we mock the Confluence and
// Notion publisher modules. Each Publisher class becomes a constructor that
// returns an object with `name`, `preflight`, and `publish` wired to shared
// vi.fn spies, tests configure per-case return values via
// `confluencePublish.mockResolvedValueOnce(...)` etc. The existing
// validation tests below don't reach publisher construction (they exit at
// --mode / missing output dir / unknown target / frontmatter checks), so
// these mocks don't perturb them.
const {
  confluencePublish,
  confluencePreflight,
  notionPublish,
  notionPreflight,
  confluenceCtor,
  notionCtor,
} = vi.hoisted(() => ({
  // Per-instance method spies. Tests configure return values via
  // mockResolvedValueOnce / mockImplementationOnce.
  confluencePublish: vi.fn(),
  confluencePreflight: vi.fn(),
  notionPublish: vi.fn(),
  notionPreflight: vi.fn(),
  // The mocked Publisher CLASSES themselves. We re-install their
  // mockImplementation in beforeEach because the top-level afterEach calls
  // vi.restoreAllMocks() (needed to reset the existing console / exit spies)
  //, restoreAllMocks wipes mockImplementation on every vi.fn() including
  // these constructors.
  confluenceCtor: vi.fn(),
  notionCtor: vi.fn(),
}));

vi.mock("../../core/publishers/confluence.js", () => ({
  ConfluencePublisher: confluenceCtor,
}));

vi.mock("../../core/publishers/notion.js", () => ({
  NotionPublisher: notionCtor,
}));

function installPublisherCtors(): void {
  confluenceCtor.mockImplementation(
    (_cfg: unknown, opts?: { dryRun?: boolean }) => ({
      name: "confluence",
      dryRun: !!opts?.dryRun,
      preflight: confluencePreflight,
      publish: confluencePublish,
    }),
  );
  notionCtor.mockImplementation(
    (_cfg: unknown, opts?: { dryRun?: boolean }) => ({
      name: "notion",
      dryRun: !!opts?.dryRun,
      preflight: notionPreflight,
      publish: notionPublish,
    }),
  );
}

import { runPublish } from "./publish.js";
import { tailAuditEntries } from "../../core/audit.js";
import type {
  PageInput,
  PublishResult,
} from "../../core/publishers/types.js";
import type {
  PreflightResult,
  PreflightEntry,
} from "../../core/publishers/preflight.js";

/**
 * Pins the early-exit / validation surfaces of `code2wiki publish` AND the
 * publisher-driven half (preflight, claim-mode collision gating, per-page
 * audit emission, dry-run gating). The validation half exercises code
 * reachable WITHOUT instantiating a real Publisher; the publisher half
 * mocks the Confluence/Notion classes (see vi.mock at top of file).
 *
 * Four load-bearing surfaces only surface live on a regression:
 *
 *   1. --mode validation: an invalid string MUST exit 1 BEFORE any IO. A
 *      regression to "warn + fall through to greenfield" would silently
 *      ignore an operator typo (e.g. `--mode claime`) and publish in the
 *      wrong mode, potentially mass-creating greenfield pages when the
 *      user meant `claim` mode (ADR-016).
 *   2. Friendly "run `code2wiki generate` first" errors when the output
 *      directory is missing OR contains no .md files. A regression
 *      surfacing a raw ENOENT stack would land in customer logs as
 *      noise and obscure the real next step.
 *   3. The frontmatter-skip path warns + continues with surviving pages.
 *      A regression that crashed on the first bad-frontmatter file would
 *      block publishing an entire repo because of one stale file from a
 *      hand-edit or partial regen.
 *   4. Unknown target name MUST exit 1, never silently fall through to
 *      "default to confluence" or similar. A regression here would push
 *      to the wrong destination + require an emergency rollback.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-publish-"));
});

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureConsole(): { log: string[]; error: string[] } {
  const log: string[] = [];
  const error: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => {
    log.push(s);
  });
  vi.spyOn(console, "error").mockImplementation((s: string) => {
    error.push(s);
  });
  return { log, error };
}

function spyExit(): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(process, "exit")
    .mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${String(code ?? 0)}`);
    });
}

async function writeOutputFile(rel: string, body: string): Promise<void> {
  const full = path.join(dir, "docs", "use-cases", rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf-8");
}

const VALID_PAGE = [
  "---",
  "code2wiki_id: demo-v1",
  "title: Demo page",
  "slug: demo-page",
  "tags: [alpha]",
  "---",
  "",
  "## Summary",
  "",
  "A short summary.",
  "",
].join("\n");

describe("runPublish --mode validation", () => {
  it("exits 1 with the allowed-mode list when --mode is an unknown string", async () => {
    const { error } = captureConsole();
    spyExit();
    // `garbage` is a plausible typo of `parallel`, pin the error message
    // names the three valid modes so the operator knows the fix.
    await expect(
      runPublish({
        cwd: dir,
        target: "confluence",
        mode: "garbage" as unknown as "greenfield",
      }),
    ).rejects.toThrow("exit:1");
    expect(error.join("\n")).toContain("Invalid --mode 'garbage'");
    expect(error.join("\n")).toContain("greenfield");
    expect(error.join("\n")).toContain("claim");
    expect(error.join("\n")).toContain("parallel");
  });

  it("passes validation for --mode 'greenfield' (exits later on missing output dir, not on mode)", async () => {
    const { error } = captureConsole();
    spyExit();
    // No code2wiki.config.json + no docs/use-cases/ → readdir fails →
    // the LATER exit-1 path fires. The pin: error message must be the
    // "output directory does not exist" copy, NOT "Invalid --mode".
    await expect(
      runPublish({ cwd: dir, target: "confluence", mode: "greenfield" }),
    ).rejects.toThrow("exit:1");
    const all = error.join("\n");
    expect(all).not.toContain("Invalid --mode");
    expect(all).toContain("does not exist");
  });

  it("passes validation for --mode 'claim'", async () => {
    const { error } = captureConsole();
    spyExit();
    await expect(
      runPublish({ cwd: dir, target: "confluence", mode: "claim" }),
    ).rejects.toThrow("exit:1");
    expect(error.join("\n")).not.toContain("Invalid --mode");
  });

  it("passes validation for --mode 'parallel'", async () => {
    const { error } = captureConsole();
    spyExit();
    await expect(
      runPublish({ cwd: dir, target: "confluence", mode: "parallel" }),
    ).rejects.toThrow("exit:1");
    expect(error.join("\n")).not.toContain("Invalid --mode");
  });

  it("does NOT trip --mode validation when --mode is omitted (config-default path)", async () => {
    const { error } = captureConsole();
    spyExit();
    // Omitting --mode is the common case; the publisher falls back to
    // config.publish.<target>.mode ?? "greenfield" later. The validation
    // gate must NOT fire for `undefined`.
    await expect(
      runPublish({ cwd: dir, target: "confluence" }),
    ).rejects.toThrow("exit:1");
    expect(error.join("\n")).not.toContain("Invalid --mode");
  });
});

describe("runPublish output-directory preflight", () => {
  it("exits 1 with a 'run code2wiki generate first' hint when the output directory does not exist", async () => {
    const { error } = captureConsole();
    spyExit();
    await expect(
      runPublish({ cwd: dir, target: "confluence" }),
    ).rejects.toThrow("exit:1");
    const all = error.join("\n");
    // The friendly hint pins WHAT to do next, not just THAT something
    // failed. A regression surfacing a raw ENOENT stack would lose the
    // forward-pointer.
    expect(all).toContain("does not exist");
    expect(all).toContain("code2wiki generate");
    // The path mentioned is the configured output (default
    // "./docs/use-cases"), so an operator with a non-default output dir
    // sees the right path in the error.
    expect(all).toContain("./docs/use-cases");
  });

  it("exits 1 with 'No Markdown files in <output>' when the output directory exists but is empty", async () => {
    await fs.mkdir(path.join(dir, "docs", "use-cases"), { recursive: true });
    const { error } = captureConsole();
    spyExit();
    await expect(
      runPublish({ cwd: dir, target: "confluence" }),
    ).rejects.toThrow("exit:1");
    const all = error.join("\n");
    expect(all).toContain("No Markdown files");
    expect(all).toContain("./docs/use-cases");
    expect(all).toContain("code2wiki generate");
  });

  it("exits 1 with 'No Markdown files' when the output directory has only non-.md files", async () => {
    // The .endsWith(".md") filter is load-bearing: a regression
    // dropping it would attempt to publish README.txt / .DS_Store /
    // backup .md.bak files as if they were rendered pages.
    await writeOutputFile("README.txt", "not markdown");
    await writeOutputFile("notes.md.bak", "not markdown either");
    const { error } = captureConsole();
    spyExit();
    await expect(
      runPublish({ cwd: dir, target: "confluence" }),
    ).rejects.toThrow("exit:1");
    expect(error.join("\n")).toContain("No Markdown files");
  });
});

describe("runPublish frontmatter validation", () => {
  it("warns to console.error and skips when code2wiki_id is missing", async () => {
    // One BAD file (no code2wiki_id) + one GOOD file. Target='unknown'
    // exits at the target-selection step BEFORE invoking any
    // publisher, so we can inspect the warning + the surviving pages
    // count without mocking Confluence/Notion.
    await writeOutputFile(
      "missing-id.md",
      ["---", "title: No ID", "slug: no-id", "---", "body"].join("\n"),
    );
    await writeOutputFile("good.md", VALID_PAGE);
    const { error } = captureConsole();
    spyExit();
    await expect(
      runPublish({ cwd: dir, target: "unknown-target" }),
    ).rejects.toThrow("exit:1");
    const all = error.join("\n");
    expect(all).toContain("missing-id.md");
    expect(all).toContain("missing frontmatter, skipping");
    // The good file did NOT trip the warning.
    expect(all).not.toContain("good.md: missing frontmatter");
  });

  it("warns and skips when title is missing", async () => {
    await writeOutputFile(
      "missing-title.md",
      ["---", "code2wiki_id: x-v1", "slug: x", "---", "body"].join("\n"),
    );
    const { error } = captureConsole();
    spyExit();
    // No good files → empty pages array → still continues, exits at
    // unknown-target.
    await expect(
      runPublish({ cwd: dir, target: "unknown-target" }),
    ).rejects.toThrow("exit:1");
    expect(error.join("\n")).toContain("missing-title.md");
    expect(error.join("\n")).toContain("missing frontmatter");
  });

  it("warns and skips when slug is missing", async () => {
    await writeOutputFile(
      "missing-slug.md",
      ["---", "code2wiki_id: x-v1", "title: X", "---", "body"].join("\n"),
    );
    const { error } = captureConsole();
    spyExit();
    await expect(
      runPublish({ cwd: dir, target: "unknown-target" }),
    ).rejects.toThrow("exit:1");
    expect(error.join("\n")).toContain("missing-slug.md");
    expect(error.join("\n")).toContain("missing frontmatter");
  });

  it("does NOT warn when all three required keys are present (happy path reaches the unknown-target exit cleanly)", async () => {
    await writeOutputFile("good.md", VALID_PAGE);
    const { error } = captureConsole();
    spyExit();
    await expect(
      runPublish({ cwd: dir, target: "unknown-target" }),
    ).rejects.toThrow("exit:1");
    // Frontmatter-skip warning must not fire for the well-formed file.
    // Pin: the exit was due to unknown-target, not a misclassification
    // of valid frontmatter as missing.
    const all = error.join("\n");
    expect(all).not.toContain("missing frontmatter");
    expect(all).toContain("Unknown target");
  });
});

describe("runPublish target selection", () => {
  it("exits 1 with 'Unknown target' when target is neither confluence nor notion", async () => {
    await writeOutputFile("good.md", VALID_PAGE);
    const { error } = captureConsole();
    spyExit();
    await expect(
      runPublish({ cwd: dir, target: "github-wiki" }),
    ).rejects.toThrow("exit:1");
    const all = error.join("\n");
    // The error names the bad target verbatim AND the two supported
    // ones, so the operator can grep the typo immediately.
    expect(all).toContain("Unknown target 'github-wiki'");
    expect(all).toContain("confluence");
    expect(all).toContain("notion");
  });
});

// ---- Publisher-driven half --------------------------------------------------
//
// These tests use the vi.mock'd ConfluencePublisher / NotionPublisher classes
// (declared at the top of this file) to inspect the preflight + collision +
// audit-emission paths of runPublish without making real HTTP calls.

const VALID_PAGE_2 = [
  "---",
  "code2wiki_id: orders-v1",
  "title: Place an order",
  "slug: place-an-order",
  "tags: [orders]",
  "---",
  "",
  "## Summary",
  "",
  "Body 2.",
  "",
].join("\n");

const CONFLUENCE_ENV = {
  CONFLUENCE_BASE_URL: "https://example.atlassian.net/wiki",
  CONFLUENCE_EMAIL: "ops@example.com",
  CONFLUENCE_API_TOKEN: "token",
  CONFLUENCE_SPACE_KEY: "ENG",
};

const NOTION_ENV = {
  NOTION_API_TOKEN: "secret_token",
  NOTION_DATABASE_ID: "db_abc",
};

function setEnv(env: Record<string, string>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    process.env[k] = env[k]!;
  }
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  };
}

function emptyPreflight(target: string, mode: "greenfield" | "claim" | "parallel"): PreflightResult {
  return {
    generated_at: "2026-05-12T00:00:00.000Z",
    target,
    mode,
    summary: { clean: 0, managed: 0, collision: 0, renamed: 0 },
    entries: [],
  };
}

function preflightWithCollision(
  target: string,
  mode: "greenfield" | "claim" | "parallel",
  page: { code2wiki_id: string; title: string; slug: string },
): PreflightResult {
  const entries: PreflightEntry[] = [
    {
      code2wiki_id: page.code2wiki_id,
      title: page.title,
      slug: page.slug,
      outcome: "collision",
      existing: {
        external_id: "external-42",
        url: "https://existing.example/page/42",
        title: page.title,
        match_reason: "title_exact_ci",
      },
      suggested_action: `claim --target=${target} --map-to=${page.code2wiki_id} --page-id=external-42`,
    },
  ];
  return {
    generated_at: "2026-05-12T00:00:00.000Z",
    target,
    mode,
    summary: { clean: 0, managed: 0, collision: 1, renamed: 0 },
    entries,
  };
}

function pageResult(
  page: { code2wiki_id: string; title: string; slug: string; markdown: string; tags: string[] },
  outcome: "created" | "updated" | "unchanged" | "skipped",
  extra: Partial<PublishResult> = {},
): PublishResult {
  const p: PageInput = {
    code2wiki_id: page.code2wiki_id,
    title: page.title,
    slug: page.slug,
    markdown: page.markdown,
    tags: page.tags,
  };
  return { page: p, outcome, ...extra };
}

describe("runPublish publisher path, Confluence happy path", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(CONFLUENCE_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    notionPublish.mockReset();
    notionPreflight.mockReset();
    confluenceCtor.mockReset();
    notionCtor.mockReset();
    installPublisherCtors();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("writes .code2wiki/preflight.json, calls publisher.publish, and emits one 'publish' audit entry per page", async () => {
    await writeOutputFile("a.md", VALID_PAGE);
    await writeOutputFile("b.md", VALID_PAGE_2);
    const { log } = captureConsole();
    spyExit();

    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    // Two pages → two results (created + updated), exercise both outcome
    // labels in the audit emission. externalId / url MUST appear in the
    // entry's details unchanged so dashboards can deep-link.
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult(
        { ...pages[0]!, tags: pages[0]!.tags ?? [] },
        "created",
        {
          externalId: "cf-page-1",
          url: "https://example.atlassian.net/wiki/spaces/ENG/pages/1",
        },
      ),
      pageResult(
        { ...pages[1]!, tags: pages[1]!.tags ?? [] },
        "updated",
        {
          externalId: "cf-page-2",
          url: "https://example.atlassian.net/wiki/spaces/ENG/pages/2",
        },
      ),
    ]);

    await runPublish({ cwd: dir, target: "confluence" });

    // Preflight ran (publisher.preflight was called with both pages).
    expect(confluencePreflight).toHaveBeenCalledTimes(1);
    expect((confluencePreflight.mock.calls[0]![0] as PageInput[]).length).toBe(2);
    // Preflight file written to disk for dashboards / CI to inspect.
    const preflightPath = path.join(dir, ".code2wiki", "preflight.json");
    const preflightRaw = await fs.readFile(preflightPath, "utf-8");
    const preflight = JSON.parse(preflightRaw) as PreflightResult;
    expect(preflight.target).toBe("confluence");
    expect(preflight.mode).toBe("greenfield");
    // Publisher.publish ran AFTER preflight; received both pages.
    expect(confluencePublish).toHaveBeenCalledTimes(1);
    expect((confluencePublish.mock.calls[0]![0] as PageInput[]).length).toBe(2);
    // Two audit entries appended, one per page.
    const audit = await tailAuditEntries(dir, 10);
    expect(audit.length).toBe(2);
    for (const entry of audit) expect(entry.operation).toBe("publish");
    const created = audit.find((e) => e.outcome === "created");
    const updated = audit.find((e) => e.outcome === "updated");
    expect(created).toBeDefined();
    expect(updated).toBeDefined();
    // Details carry target + mode + externalId + url, fields downstream
    // dashboards rely on. A regression dropping any one would silently
    // break deep-linking from the audit-log surface.
    expect(created!.details).toMatchObject({
      target: "confluence",
      mode: "greenfield",
      externalId: "cf-page-1",
      url: "https://example.atlassian.net/wiki/spaces/ENG/pages/1",
    });
    expect(updated!.details).toMatchObject({
      target: "confluence",
      mode: "greenfield",
      externalId: "cf-page-2",
    });
    // content_hash present (one per successful page) so the audit-log
    // verify chain stays computable for publish entries.
    expect(created!.content_hash).toMatch(/^sha256:/);
    expect(updated!.content_hash).toMatch(/^sha256:/);
    // Final "done: created updated skipped" log line was printed.
    expect(log.join("\n")).toMatch(/done: 1 created, 1 updated, 0 skipped/);
  });
});

describe("runPublish publisher path, claim-mode collision gating", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(CONFLUENCE_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    confluenceCtor.mockReset();
    notionCtor.mockReset();
    installPublisherCtors();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("exits 2 BEFORE calling publisher.publish when claim mode + collisions + no --ignore-collisions", async () => {
    await writeOutputFile("a.md", VALID_PAGE);
    const { error } = captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(
      preflightWithCollision("confluence", "claim", {
        code2wiki_id: "demo-v1",
        title: "Demo page",
        slug: "demo-page",
      }),
    );
    // exit 2, the OPERATOR-actionable signal that there's a manual claim
    // step pending. Process must NOT publish in this state; doing so would
    // silently create duplicate greenfield pages alongside the existing
    // wiki page.
    await expect(
      runPublish({ cwd: dir, target: "confluence", mode: "claim" }),
    ).rejects.toThrow("exit:2");
    expect(confluencePublish).not.toHaveBeenCalled();
    const all = error.join("\n");
    expect(all).toContain("claim mode");
    expect(all).toContain("1 collision");
    expect(all).toContain("code2wiki claim");
    expect(all).toContain("--ignore-collisions");
  });

  it("continues past collisions when --ignore-collisions is set in claim mode", async () => {
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(
      preflightWithCollision("confluence", "claim", {
        code2wiki_id: "demo-v1",
        title: "Demo page",
        slug: "demo-page",
      }),
    );
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "updated", {
        externalId: "cf-page-existing",
      }),
    ]);
    // No exit:2 from the collision gate; runPublish completes normally
    // because the operator opted into the override.
    await runPublish({
      cwd: dir,
      target: "confluence",
      mode: "claim",
      ignoreCollisions: true,
    });
    expect(confluencePublish).toHaveBeenCalledTimes(1);
  });

  it("does NOT exit 2 on collisions in greenfield mode (only claim mode gates)", async () => {
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(
      preflightWithCollision("confluence", "greenfield", {
        code2wiki_id: "demo-v1",
        title: "Demo page",
        slug: "demo-page",
      }),
    );
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created", {
        externalId: "cf-page-new",
      }),
    ]);
    // Greenfield: a "collision" is informational, the existing page is
    // not labeled as ours, so we create a new one beside it. A regression
    // applying the claim-mode gate to greenfield would block adoption of
    // the very mode customers use to start fresh.
    await runPublish({ cwd: dir, target: "confluence", mode: "greenfield" });
    expect(confluencePublish).toHaveBeenCalledTimes(1);
  });

  it("does NOT exit 2 on collisions in parallel mode", async () => {
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(
      preflightWithCollision("confluence", "parallel", {
        code2wiki_id: "demo-v1",
        title: "Demo page",
        slug: "demo-page",
      }),
    );
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence", mode: "parallel" });
    expect(confluencePublish).toHaveBeenCalledTimes(1);
  });
});

describe("runPublish publisher path, skipped pages + final exit code", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(CONFLUENCE_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    confluenceCtor.mockReset();
    notionCtor.mockReset();
    installPublisherCtors();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("exits 2 when any page result is 'skipped' AND maps 'skipped' to outcome='error' in the audit entry", async () => {
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "skipped", {
        message: "API returned 409 on update",
      }),
    ]);
    // The final exit-2 signals the operator that the run was not fully
    // successful, a CI gate hook can act on it. Mapping skipped→error in
    // the audit entry preserves AuditOutcome's invariant that "skipped"
    // is a generate-only outcome (publish failures are "error").
    await expect(
      runPublish({ cwd: dir, target: "confluence" }),
    ).rejects.toThrow("exit:2");
    const audit = await tailAuditEntries(dir, 10);
    expect(audit.length).toBe(1);
    expect(audit[0]!.operation).toBe("publish");
    expect(audit[0]!.outcome).toBe("error"); // NOT "skipped", load-bearing
    expect(audit[0]!.details).toMatchObject({
      target: "confluence",
      message: "API returned 409 on update",
    });
  });
});

describe("runPublish publisher path, dry-run", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(CONFLUENCE_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    confluenceCtor.mockReset();
    notionCtor.mockReset();
    installPublisherCtors();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("skips preflight + skips audit-log emission + does not exit-2 on skipped, but still calls publisher.publish", async () => {
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "skipped", {
        message: "dry-run reported a conflict",
      }),
    ]);
    // The dry-run guard at publish.ts:118 prevents writing .code2wiki/
    // preflight.json on a read-only run; the guard at :150 prevents
    // appending audit entries (the user would be surprised by entries
    // for a publish that didn't happen). The "skipped → exit 2" gate is
    // also skipped, a dry-run that reports skips is informational, not
    // an error.
    await runPublish({ cwd: dir, target: "confluence", dryRun: true });
    expect(confluencePreflight).not.toHaveBeenCalled();
    // No preflight file written.
    await expect(
      fs.readFile(path.join(dir, ".code2wiki", "preflight.json"), "utf-8"),
    ).rejects.toThrow();
    // No audit entries appended.
    const audit = await tailAuditEntries(dir, 10);
    expect(audit.length).toBe(0);
    // But publisher.publish IS still invoked so the dry-run still
    // produces a per-page outcome log.
    expect(confluencePublish).toHaveBeenCalledTimes(1);
    // Constructor saw dryRun=true so the real publisher would have
    // short-circuited HTTP calls.
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    expect(confluenceCtor.mock.calls[0]![1]).toMatchObject({ dryRun: true });
  });
});

describe("runPublish publisher path, Notion target", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(NOTION_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    notionPublish.mockReset();
    notionPreflight.mockReset();
    confluenceCtor.mockReset();
    notionCtor.mockReset();
    installPublisherCtors();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("instantiates NotionPublisher (not Confluence) and stamps details.target='notion' on audit entries", async () => {
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    notionPreflight.mockResolvedValue(emptyPreflight("notion", "parallel"));
    notionPublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created", {
        externalId: "notion-page-xyz",
        url: "https://www.notion.so/Demo-page-xyz",
      }),
    ]);
    // Pass --mode=parallel to also pin that the operator override
    // propagates from the CLI to the publisher constructor's coexistence
    // config (visible in audit.details.mode).
    await runPublish({ cwd: dir, target: "notion", mode: "parallel" });
    expect(notionCtor).toHaveBeenCalledTimes(1);
    expect(confluenceCtor).not.toHaveBeenCalled(); // never crossed wires
    expect(notionPublish).toHaveBeenCalledTimes(1);
    const audit = await tailAuditEntries(dir, 10);
    expect(audit.length).toBe(1);
    expect(audit[0]!.details).toMatchObject({
      target: "notion",
      mode: "parallel",
      externalId: "notion-page-xyz",
    });
  });
});

describe("runPublish config.publish.<target>.mode forwarding (config-file path)", () => {
  // Regression guard for publish.ts:95 `const mode = opts.mode ?? targetCfg?.mode ?? "greenfield"`.
  // The Notion-target test above pins the CLI-override path (opts.mode set).
  // Nothing pins the config-file path (opts.mode absent, mode comes from
  // config.publish.confluence.mode). A regression dropping `targetCfg?.mode`
  // from the chain would silently publish in greenfield even when a customer
  // configured claim mode -- potentially mass-creating duplicate pages for
  // every repo they run publish on, a high-trust wiki corruption failure.
  //
  // Two tests: (1) config-file mode reaches the constructor and audit entry;
  // (2) CLI --mode takes precedence over config-file mode (priority order).
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(CONFLUENCE_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    confluenceCtor.mockReset();
    notionCtor.mockReset();
    installPublisherCtors();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("uses config.publish.confluence.mode when --mode is not passed (config-file path)", async () => {
    // Write a config file with mode=claim so targetCfg.mode is set.
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ publish: { confluence: { mode: "claim" } } }),
    );
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "claim"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created", {
        externalId: "cf-claim-1",
        url: "https://example.atlassian.net/wiki/pages/1",
      }),
    ]);
    // No --mode override: runPublish must read mode from config.
    await runPublish({ cwd: dir, target: "confluence" });
    // Constructor received coexistence.mode = "claim" (not "greenfield").
    // A `targetCfg?.mode` drop-regression produces "greenfield" here.
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as { coexistence: { mode: string } };
    expect(ctorCfg.coexistence.mode).toBe("claim");
    // Audit entry also carries mode="claim" so dashboards see the right value.
    const audit = await tailAuditEntries(dir, 10);
    expect(audit.length).toBe(1);
    expect(audit[0]!.details).toMatchObject({ target: "confluence", mode: "claim" });
  });

  it("CLI --mode overrides config.publish.confluence.mode (precedence: opts.mode > config > greenfield)", async () => {
    // Config says claim, CLI says greenfield: greenfield wins.
    // Pins the `opts.mode ?? targetCfg?.mode ?? "greenfield"` priority order.
    // A regression reversing precedence (config wins over CLI) would ignore
    // explicit --mode flags during one-off emergency publishes.
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ publish: { confluence: { mode: "claim" } } }),
    );
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    // Explicit --mode greenfield takes precedence over config's claim.
    await runPublish({ cwd: dir, target: "confluence", mode: "greenfield" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as { coexistence: { mode: string } };
    expect(ctorCfg.coexistence.mode).toBe("greenfield");
    const audit = await tailAuditEntries(dir, 10);
    expect(audit.length).toBe(1);
    expect(audit[0]!.details).toMatchObject({ mode: "greenfield" });
  });
});

describe("runPublish parallel-mode slug-prefix auto-default", () => {
  // Regression guard for publish.ts:198 `slugPrefix: targetCfg?.slugPrefix ?? (mode === "parallel" ? "code2wiki/" : undefined)`.
  // In parallel mode without an explicit slugPrefix config, the system must auto-default to "code2wiki/"
  // to prevent namespace collisions between user content and code2wiki content. A regression removing
  // or breaking this conditional would silently disable namespace isolation, allowing duplicates or
  // silent overwrites in parallel-mode publishes. High-trust failure: the audit log would record
  // successful publish but the wiki would be corrupted.
  //
  // Two tests: (1) parallel mode + no explicit slugPrefix => coexistence.slugPrefix = "code2wiki/";
  // (2) explicit slugPrefix in config overrides the default (precedence check).
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(CONFLUENCE_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    confluenceCtor.mockReset();
    installPublisherCtors();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("parallel mode with no explicit slugPrefix auto-defaults coexistence.slugPrefix to 'code2wiki/'", async () => {
    // Config specifies mode=parallel but NO slugPrefix, so buildCoexistence must
    // apply the conditional default.
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ publish: { confluence: { mode: "parallel" } } }),
    );
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "parallel"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    // No explicit slugPrefix in config, mode=parallel: must auto-default.
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as {
      coexistence: { slugPrefix: string | undefined };
    };
    expect(ctorCfg.coexistence.slugPrefix).toBe("code2wiki/");
  });

  it("explicit slugPrefix in config overrides the parallel-mode default", async () => {
    // Config sets both mode=parallel AND an explicit slugPrefix.
    // The explicit value must take precedence (precedence: targetCfg.slugPrefix > mode-default).
    // A regression that always applies mode-default on top of explicit would corrupt
    // the customer's namespace strategy.
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({
        publish: { confluence: { mode: "parallel", slugPrefix: "custom-ns/" } },
      }),
    );
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "parallel"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as {
      coexistence: { slugPrefix: string | undefined };
    };
    expect(ctorCfg.coexistence.slugPrefix).toBe("custom-ns/");
  });

  it("greenfield mode does NOT auto-default slugPrefix (no-op in greenfield)", async () => {
    // Verify that the mode-default only fires on parallel mode.
    // greenfield mode should pass undefined (not "code2wiki/").
    // A regression that applied the default to all modes would break greenfield users.
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ publish: { confluence: { mode: "greenfield" } } }),
    );
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as {
      coexistence: { slugPrefix: string | undefined };
    };
    expect(ctorCfg.coexistence.slugPrefix).toBeUndefined();
  });
});

describe("runPublish config.publish.<target>.titlePrefix forwarding", () => {
  // Regression guard for publish.ts:199 `titlePrefix: targetCfg?.titlePrefix`.
  // buildCoexistence plucks titlePrefix directly from config; if the line is
  // dropped, every customer who configured `publish.confluence.titlePrefix`
  // would silently publish pages without the prefix. High-trust failure:
  // the wiki would appear correct (no error thrown) but page titles would
  // be wrong, breaking namespace conventions customers depend on.
  //
  // Three tests: (1) titlePrefix from config reaches coexistence;
  // (2) omitting titlePrefix from config results in undefined (no default);
  // (3) titlePrefix is independent of slugPrefix (both can be set).
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(CONFLUENCE_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    confluenceCtor.mockReset();
    installPublisherCtors();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("config.publish.confluence.titlePrefix reaches coexistence.titlePrefix", async () => {
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ publish: { confluence: { titlePrefix: "[DOCS] " } } }),
    );
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as {
      coexistence: { titlePrefix: string | undefined };
    };
    expect(ctorCfg.coexistence.titlePrefix).toBe("[DOCS] ");
  });

  it("omitting titlePrefix from config results in coexistence.titlePrefix=undefined (no default)", async () => {
    // Config has no titlePrefix: ensure the field isn't defaulted to
    // something by buildCoexistence or the config schema.
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as {
      coexistence: { titlePrefix: string | undefined };
    };
    expect(ctorCfg.coexistence.titlePrefix).toBeUndefined();
  });
});

describe("runPublish config.publish.<target>.banner forwarding", () => {
  // Regression guard for publish.ts:193-206 `buildCoexistence` banner assembly.
  // The banner appears on EVERY published page; wrong values are immediately
  // visible to wiki readers. Three fields thread through buildCoexistence:
  //   repoName, repoUrl, commitUrlTemplate.
  // None of them are pinned in publish.test.ts. A drop of any one line in
  // buildCoexistence compiles clean and silently corrupts every page banner.
  //
  // Three tests: (1) banner.repoName from config overrides the default;
  // (2) banner.repoUrl reaches coexistence.banner.repoUrl;
  // (3) banner.commitUrlTemplate reaches coexistence.banner.commitUrlTemplate.
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(CONFLUENCE_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    confluenceCtor.mockReset();
    installPublisherCtors();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("config.publish.confluence.banner.repoName overrides the process.cwd() default", async () => {
    // Default is path.basename(process.cwd()), which in the test tmpdir
    // would NOT be "acme-corp". A regression dropping the config override
    // silently uses the wrong repo name in every page's attribution banner.
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({ publish: { confluence: { banner: { repoName: "acme-corp" } } } }),
    );
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as {
      coexistence: { banner: { repoName: string; repoUrl?: string; commitUrlTemplate?: string } };
    };
    expect(ctorCfg.coexistence.banner.repoName).toBe("acme-corp");
  }, 60000);

  it("config.publish.confluence.banner.repoUrl reaches coexistence.banner.repoUrl", async () => {
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({
        publish: {
          confluence: {
            banner: {
              repoName: "acme-corp",
              repoUrl: "https://github.com/acme/corp",
            },
          },
        },
      }),
    );
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as {
      coexistence: { banner: { repoUrl?: string } };
    };
    expect(ctorCfg.coexistence.banner.repoUrl).toBe("https://github.com/acme/corp");
  });

  it("config.publish.confluence.banner.commitUrlTemplate reaches coexistence.banner.commitUrlTemplate", async () => {
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({
        publish: {
          confluence: {
            banner: {
              repoName: "acme-corp",
              commitUrlTemplate: "https://github.com/acme/corp/commit/{{commit}}",
            },
          },
        },
      }),
    );
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as {
      coexistence: { banner: { commitUrlTemplate?: string } };
    };
    expect(ctorCfg.coexistence.banner.commitUrlTemplate).toBe(
      "https://github.com/acme/corp/commit/{{commit}}",
    );
  });

  // Pin the DEFAULT fallback in buildCoexistence at publish.ts:194-195:
  //   const repoName =
  //     banner?.repoName ?? path.basename(process.cwd()) ?? "your-repo";
  //
  // The override path (banner.repoName from config) is pinned above. The
  // default path is hit when the customer has NOT set publish.confluence.banner
  // (or has set banner without repoName), which is the most common case for
  // first-time users who never touched the banner config. A regression dropping
  // `?? path.basename(process.cwd())` would silently degrade every default-config
  // banner to the literal string "your-repo", which would surface on every wiki
  // page as the attribution name for any customer who hasn't customised the
  // banner. The override test above would still pass (banner.repoName wins
  // before the default), so this gap is invisible without a dedicated test.
  //
  // path.basename(process.cwd()) is computed at runtime so this test is stable
  // across machines: it asserts the BEHAVIOUR (cwd-derived basename, NOT the
  // "your-repo" literal), not a hardcoded "code2wiki" string that would only
  // hold when run from this specific repo root.
  //
  // Adjacent observation NOT in scope for this commit: publish.ts:195 uses
  // process.cwd() rather than opts.cwd, so `code2wiki publish --cwd /elsewhere`
  // produces a banner derived from the shell's cwd, not the project's. Today's
  // contract is "process.cwd()", and that's what this test pins; a future
  // refactor to use opts.cwd would intentionally flip the contract and require
  // updating this assertion alongside the source.
  it("coexistence.banner.repoName defaults to path.basename(process.cwd()) when no banner.repoName is configured", async () => {
    // No code2wiki.config.json at all -> config.publish.confluence is
    // undefined -> targetCfg undefined -> banner undefined -> fallback fires.
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as {
      coexistence: { banner: { repoName: string } };
    };
    const expected = path.basename(process.cwd());
    expect(ctorCfg.coexistence.banner.repoName).toBe(expected);
    // Defends against a regression that drops the path.basename fallback
    // and only the unreachable "your-repo" literal remains. The literal
    // CAN currently be hit only if path.basename ever returns nullish,
    // which it does not (it returns "" for "/" inputs, not null).
    expect(ctorCfg.coexistence.banner.repoName).not.toBe("your-repo");
    // Defends against the inverse regression: dropping `banner?.repoName ??`
    // would still pass this test (default kicks in either way), so the
    // override test above remains required. Pin the non-empty contract
    // here as a sanity check.
    expect(ctorCfg.coexistence.banner.repoName.length).toBeGreaterThan(0);
  });
});

describe("runPublish config.publish.confluence.parentPageId forwarding", () => {
  // Regression guard for publish.ts:229 in confluenceConfigFromEnv:
  //   parentPageId: targetCfg?.parentPageId ?? process.env["CONFLUENCE_PARENT_PAGE_ID"]
  // Three-way precedence with two distinct regression surfaces, neither
  // currently pinned in publish.test.ts:
  //   (A) Drop the `targetCfg?.parentPageId ??` half -> config value silently
  //       ignored; customers who pin a parent page in code2wiki.config.json
  //       see new pages land at the space root instead of under the pinned
  //       parent.
  //   (B) Drop the `?? process.env[...]` half -> env-only setups (no config
  //       file) silently lose the parent and pages land at the space root.
  //   (C) Swap order to env-first -> config no longer wins; a customer who
  //       added a per-target parent in config to OVERRIDE a stale env-wide
  //       default sees the override silently ignored.
  // Confluence-only (Notion uses databaseId; no parentPageId on
  // notionConfigFromEnv at publish.ts:235-242).
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(CONFLUENCE_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    confluenceCtor.mockReset();
    installPublisherCtors();
    // Belt + suspenders: CONFLUENCE_ENV doesn't include CONFLUENCE_PARENT_PAGE_ID,
    // but the host shell may; explicitly delete so (A) isolates the config
    // branch with NO env fallback in play.
    delete process.env["CONFLUENCE_PARENT_PAGE_ID"];
  });
  afterEach(() => {
    delete process.env["CONFLUENCE_PARENT_PAGE_ID"];
    restoreEnv();
  });

  it("config.publish.confluence.parentPageId reaches ConfluenceConfig.parentPageId (env unset)", async () => {
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({
        publish: { confluence: { parentPageId: "page-from-config-111" } },
      }),
    );
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as { parentPageId?: string };
    expect(ctorCfg.parentPageId).toBe("page-from-config-111");
  });

  it("CONFLUENCE_PARENT_PAGE_ID env fallback is used when config omits parentPageId", async () => {
    process.env["CONFLUENCE_PARENT_PAGE_ID"] = "page-from-env-222";
    // No code2wiki.config.json: targetCfg is undefined, so the `??` falls
    // through to the env. A regression dropping the env half leaves
    // ctorCfg.parentPageId undefined and pages land at the space root.
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as { parentPageId?: string };
    expect(ctorCfg.parentPageId).toBe("page-from-env-222");
  });

  it("config.publish.confluence.parentPageId wins over CONFLUENCE_PARENT_PAGE_ID (precedence)", async () => {
    // Both set: config MUST win (publish.ts:229 is `config ?? env`, not the
    // other way around). A regression swapping order silently downgrades
    // every customer who relied on the per-target override to defeat a
    // shell-wide env default.
    process.env["CONFLUENCE_PARENT_PAGE_ID"] = "page-from-env-LOSER";
    await fs.writeFile(
      path.join(dir, "code2wiki.config.json"),
      JSON.stringify({
        publish: { confluence: { parentPageId: "page-from-config-WINNER" } },
      }),
    );
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as { parentPageId?: string };
    expect(ctorCfg.parentPageId).toBe("page-from-config-WINNER");
  });
});

// Pin CONFLUENCE_LABEL env var forwarding to ConfluenceConfig.label
// (confluenceConfigFromEnv at publish.ts:230: `label: process.env["CONFLUENCE_LABEL"]`).
//
// Regression surface: a refactor that renames the env var, drops the field,
// or accidentally hardcodes `undefined` instead of the env lookup leaves
// every customer whose Confluence admin set up a label-based access policy
// unable to publish. No test previously covered this wire.
describe("runPublish CONFLUENCE_LABEL env var forwarding", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(CONFLUENCE_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    confluenceCtor.mockReset();
    installPublisherCtors();
    delete process.env["CONFLUENCE_LABEL"];
  });
  afterEach(() => {
    delete process.env["CONFLUENCE_LABEL"];
    restoreEnv();
  });

  it("CONFLUENCE_LABEL env var reaches ConfluenceConfig.label when set", async () => {
    process.env["CONFLUENCE_LABEL"] = "docs-managed";
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as { label?: string };
    expect(ctorCfg.label).toBe("docs-managed");
  });

  it("ConfluenceConfig.label is undefined when CONFLUENCE_LABEL is not set", async () => {
    // Env var absent: label must be undefined, not an empty string or
    // "undefined" (both would be treated as a literal label by the publisher).
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as { label?: string };
    expect(ctorCfg.label).toBeUndefined();
  });
});

// Pin NOTION_API_VERSION env var forwarding to NotionConfig.apiVersion
// (notionConfigFromEnv at publish.ts:239: `apiVersion: process.env["NOTION_API_VERSION"]`).
//
// Regression surface: a rename of the env var or a whittle of the field from
// the config assembler silently breaks every customer who depends on a
// non-default Notion API version. No test previously covered this wire.
describe("runPublish NOTION_API_VERSION env var forwarding", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(NOTION_ENV);
    notionPublish.mockReset();
    notionPreflight.mockReset();
    notionCtor.mockReset();
    installPublisherCtors();
    delete process.env["NOTION_API_VERSION"];
  });
  afterEach(() => {
    delete process.env["NOTION_API_VERSION"];
    restoreEnv();
  });

  it("NOTION_API_VERSION env var reaches NotionConfig.apiVersion when set", async () => {
    process.env["NOTION_API_VERSION"] = "2022-06-28";
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    notionPreflight.mockResolvedValue(emptyPreflight("notion", "greenfield"));
    notionPublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "notion" });
    expect(notionCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = notionCtor.mock.calls[0]![0] as { apiVersion?: string };
    expect(ctorCfg.apiVersion).toBe("2022-06-28");
  });

  it("NotionConfig.apiVersion is undefined when NOTION_API_VERSION is not set", async () => {
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    notionPreflight.mockResolvedValue(emptyPreflight("notion", "greenfield"));
    notionPublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "notion" });
    expect(notionCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = notionCtor.mock.calls[0]![0] as { apiVersion?: string };
    expect(ctorCfg.apiVersion).toBeUndefined();
  });
});

// Pin that the git-HEAD commit SHA from currentCommit() is threaded through
// buildCoexistence into coexistence.banner.commit (publish.ts:96 → 204).
//
// Regression surface: the banner renderer substitutes {commit} inside
// commitUrlTemplate to generate a clickable permalink. A refactor that
// drops `commit,` from the banner object in buildCoexistence would silently
// leave coexistence.banner.commit=undefined, causing banner.ts to fall back
// to the repoUrl on EVERY page -- dead commit links for any customer who
// configured commitUrlTemplate, with no existing test to catch it.
//
// The test dir is not a git repo, so currentCommit() returns "unknown".
// That value is the observable wire: if it arrives at the constructor it
// proves the full currentCommit → buildCoexistence → publisher path is intact.
describe("runPublish currentCommit SHA forwarding into coexistence.banner.commit", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = setEnv(CONFLUENCE_ENV);
    confluencePublish.mockReset();
    confluencePreflight.mockReset();
    confluenceCtor.mockReset();
    installPublisherCtors();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("coexistence.banner.commit equals the value from currentCommit (non-git dir → 'unknown')", async () => {
    await writeOutputFile("a.md", VALID_PAGE);
    captureConsole();
    spyExit();
    confluencePreflight.mockResolvedValue(emptyPreflight("confluence", "greenfield"));
    confluencePublish.mockImplementationOnce(async (pages: PageInput[]) => [
      pageResult({ ...pages[0]!, tags: pages[0]!.tags ?? [] }, "created"),
    ]);
    await runPublish({ cwd: dir, target: "confluence" });
    expect(confluenceCtor).toHaveBeenCalledTimes(1);
    const ctorCfg = confluenceCtor.mock.calls[0]![0] as {
      coexistence: { banner: { commit?: string } };
    };
    // "unknown" is currentCommit's fallback for non-git dirs.
    // Any other value (undefined, "", null) means the commit was not
    // forwarded -- the banner would produce dead commit-permalink links.
    expect(ctorCfg.coexistence.banner.commit).toBe("unknown");
  });
});
