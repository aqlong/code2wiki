import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// vi.mock is hoisted. To exercise the publisher-driven half of `runClaim`
// (pageRef resolution, success-path audit emission, CLAIM_ABORTED rollback,
// placement default) without making real HTTP calls, we mock the publisher
// modules. Each Publisher class becomes a constructor that returns an object
// with `claim` wired to a shared vi.fn spy. We re-install the ctor
// mockImplementation in each describe block's beforeEach because the
// file-level afterEach runs vi.restoreAllMocks() (resets console/exit spies)
// which wipes mockImplementation on hoisted vi.fn()s, same lesson learned
// in publish.test.ts.
const { confluenceClaim, notionClaim, confluenceCtor, notionCtor } = vi.hoisted(
  () => ({
    confluenceClaim: vi.fn(),
    notionClaim: vi.fn(),
    confluenceCtor: vi.fn(),
    notionCtor: vi.fn(),
  }),
);

vi.mock("../../core/publishers/confluence.js", () => ({
  ConfluencePublisher: confluenceCtor,
}));

vi.mock("../../core/publishers/notion.js", () => ({
  NotionPublisher: notionCtor,
}));

function installPublisherCtors(): void {
  confluenceCtor.mockImplementation(() => ({
    name: "confluence",
    claim: confluenceClaim,
  }));
  notionCtor.mockImplementation(() => ({
    name: "notion",
    claim: notionClaim,
  }));
}

import { runClaim } from "./claim.js";
import { tailAuditEntries, verifyAuditChain } from "../../core/audit.js";

let dir: string;
let originalEnv: Record<string, string | undefined>;

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

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-claim-cli-"));
  originalEnv = {
    CONFLUENCE_BASE_URL: process.env["CONFLUENCE_BASE_URL"],
    CONFLUENCE_EMAIL: process.env["CONFLUENCE_EMAIL"],
    CONFLUENCE_API_TOKEN: process.env["CONFLUENCE_API_TOKEN"],
    CONFLUENCE_SPACE_KEY: process.env["CONFLUENCE_SPACE_KEY"],
    NOTION_API_TOKEN: process.env["NOTION_API_TOKEN"],
    NOTION_DATABASE_ID: process.env["NOTION_DATABASE_ID"],
  };
});

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

function setEnv(env: Record<string, string>): void {
  for (const k of Object.keys(env)) process.env[k] = env[k]!;
}

function spyExit(): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(process, "exit")
    .mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${String(code ?? 0)}`);
    });
}

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

async function setupGeneratedFixture(dir: string): Promise<void> {
  const outDir = path.join(dir, "docs", "use-cases");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, "publishing-a-site.md"),
    "---\ncode2wiki_id: publishing-a-site\ntitle: Publishing a Site\nslug: publishing-a-site\ntags: []\n---\n\n## Summary\n\nA test.\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "code2wiki.config.json"),
    JSON.stringify({ output: "./docs/use-cases" }),
    "utf-8",
  );
}

// ---- Argument validation -----------------------------------------------------

describe("runClaim, argument validation (CL-9, CL-10)", () => {
  it("CL-10: --map-to is required", async () => {
    const exitSpy = spyExit();
    await expect(
      runClaim({
        cwd: dir,
        pageRef: "12345",
        target: "confluence",
        mapTo: "",
      }),
    ).rejects.toThrow(/exit:1/);
    exitSpy.mockRestore();
  });

  it("CL-9: missing --map-to id reports available IDs", async () => {
    await setupGeneratedFixture(dir);
    const { error } = captureConsole();
    spyExit();
    await expect(
      runClaim({
        cwd: dir,
        pageRef: "12345",
        target: "confluence",
        mapTo: "no-such-id",
      }),
    ).rejects.toThrow();
    const all = error.join("\n");
    expect(all).toContain("publishing-a-site");
    expect(all).toMatch(/No generated page/);
  });

  it("rejects an invalid --target", async () => {
    await setupGeneratedFixture(dir);
    spyExit();
    await expect(
      runClaim({
        cwd: dir,
        pageRef: "1",
        target: "wrong" as "confluence",
        mapTo: "publishing-a-site",
      }),
    ).rejects.toThrow();
  });
});

// ---- Audit-chain integration (existing direct-write smoke tests) -------------

describe("Audit chain after claim entries (CL-14, AU-1, AU-2)", () => {
  it("appendAuditEntry('claim') keeps the chain valid", async () => {
    const { appendAuditEntry } = await import("../../core/audit.js");
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "publishing-a-site",
      outcome: "created",
    });
    const claimEntry = await appendAuditEntry(dir, {
      operation: "claim",
      commit: "abc",
      page: "publishing-a-site",
      outcome: "updated",
      details: {
        target: "confluence",
        external_id: "12345",
        placement: "below",
        pre_claim_content_hash: "sha256:abc",
      },
    });
    await appendAuditEntry(dir, {
      operation: "publish",
      commit: "abc",
      page: "publishing-a-site",
      outcome: "updated",
      details: { target: "confluence", mode: "claim" },
    });
    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(true);
    expect(result.totalEntries).toBe(3);
    const entries = await tailAuditEntries(dir, 3);
    expect(entries[1]?.operation).toBe("claim");
    expect(entries[1]?.entry_hash).toBe(claimEntry.entry_hash);
    expect((entries[1]?.details as Record<string, unknown>)["pre_claim_content_hash"]).toBe(
      "sha256:abc",
    );
  });

  it("AU-4: claim_aborted entry preserves chain integrity", async () => {
    const { appendAuditEntry } = await import("../../core/audit.js");
    await appendAuditEntry(dir, {
      operation: "claim_aborted",
      commit: "abc",
      page: "publishing-a-site",
      outcome: "error",
      details: { target: "confluence", error: "label write failed" },
    });
    await appendAuditEntry(dir, {
      operation: "claim",
      commit: "abc",
      page: "publishing-a-site",
      outcome: "updated",
      details: { target: "confluence", external_id: "12345", placement: "below" },
    });
    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(true);
  });

  it("AU-5: publish entry records mode in details", async () => {
    const { appendAuditEntry } = await import("../../core/audit.js");
    const entry = await appendAuditEntry(dir, {
      operation: "publish",
      commit: "abc",
      page: "p",
      outcome: "created",
      details: { target: "confluence", mode: "claim" },
    });
    expect((entry.details as Record<string, unknown>)["mode"]).toBe("claim");
  });
});

// ---- Publisher-driven path ---------------------------------------------------
//
// These tests use the vi.mock'd ConfluencePublisher / NotionPublisher to
// inspect pageRef resolution + success-path audit emission + CLAIM_ABORTED
// rollback + placement default, surfaces previously left untested because
// the publishers couldn't be intercepted from outside.

describe("runClaim publisher path, Confluence success", () => {
  beforeEach(async () => {
    await setupGeneratedFixture(dir);
    setEnv(CONFLUENCE_ENV);
    confluenceClaim.mockReset();
    notionClaim.mockReset();
    confluenceCtor.mockReset();
    notionCtor.mockReset();
    installPublisherCtors();
  });

  it("resolves a /pages/<id>/Title URL → numeric pageId, emits a 'claim' audit entry with all 5 detail fields", async () => {
    confluenceClaim.mockResolvedValueOnce({
      external_id: "123456789",
      pre_claim_content_hash: "sha256:abc",
      url: "https://example.atlassian.net/wiki/spaces/ENG/pages/123456789",
    });
    const { log } = captureConsole();

    await runClaim({
      cwd: dir,
      pageRef: "https://example.atlassian.net/wiki/spaces/DOCS/pages/123456789/My-Title",
      target: "confluence",
      mapTo: "publishing-a-site",
    });

    expect(confluenceClaim).toHaveBeenCalledTimes(1);
    const callArg = confluenceClaim.mock.calls[0]![0] as {
      pageId: string;
      placement: "above" | "below";
      code2wiki_id: string;
    };
    expect(callArg.pageId).toBe("123456789");
    expect(callArg.code2wiki_id).toBe("publishing-a-site");
    // Audit entry pins all five load-bearing detail fields so a future
    // schema slip (dropping pre_claim_content_hash, say) surfaces here.
    const audit = await tailAuditEntries(dir, 10);
    expect(audit.length).toBe(1);
    expect(audit[0]!.operation).toBe("claim");
    expect(audit[0]!.outcome).toBe("updated");
    expect(audit[0]!.page).toBe("publishing-a-site");
    const details = audit[0]!.details as Record<string, unknown>;
    expect(details["target"]).toBe("confluence");
    expect(details["external_id"]).toBe("123456789");
    expect(details["url"]).toBe(
      "https://example.atlassian.net/wiki/spaces/ENG/pages/123456789",
    );
    expect(details["placement"]).toBe("below");
    expect(details["pre_claim_content_hash"]).toBe("sha256:abc");
    // Success message names the resolved external id + mapped code2wiki_id.
    expect(log.join("\n")).toContain("adopted confluence:123456789");
    expect(log.join("\n")).toContain("publishing-a-site");
  });

  it("resolves a viewpage.action?pageId=<id> URL → numeric pageId", async () => {
    confluenceClaim.mockResolvedValueOnce({
      external_id: "42",
      pre_claim_content_hash: "sha256:def",
    });
    captureConsole();
    await runClaim({
      cwd: dir,
      pageRef:
        "https://example.atlassian.net/wiki/pages/viewpage.action?pageId=42&other=junk",
      target: "confluence",
      mapTo: "publishing-a-site",
    });
    const arg = confluenceClaim.mock.calls[0]![0] as { pageId: string };
    expect(arg.pageId).toBe("42");
  });

  it("passes a bare numeric pageId through unchanged", async () => {
    confluenceClaim.mockResolvedValueOnce({
      external_id: "777",
      pre_claim_content_hash: "sha256:xyz",
    });
    captureConsole();
    await runClaim({
      cwd: dir,
      pageRef: "777",
      target: "confluence",
      mapTo: "publishing-a-site",
    });
    const arg = confluenceClaim.mock.calls[0]![0] as { pageId: string };
    expect(arg.pageId).toBe("777");
  });

  it("malformed Confluence pageRef → exit 2, no audit entry", async () => {
    // Bare hyphenated string matches neither numeric nor URL patterns,
    // resolveConfluencePageId throws, runClaim's generic catch exits 2.
    const { error } = captureConsole();
    spyExit();
    await expect(
      runClaim({
        cwd: dir,
        pageRef: "not-a-page-id",
        target: "confluence",
        mapTo: "publishing-a-site",
      }),
    ).rejects.toThrow("exit:2");
    expect(error.join("\n")).toMatch(/Could not parse a Confluence page id/);
    // Generic error path skips appendAuditEntry, no `claim_aborted` for
    // pre-publisher failures (those are pure-local config errors).
    expect(confluenceClaim).not.toHaveBeenCalled();
    const audit = await tailAuditEntries(dir, 10);
    expect(audit.length).toBe(0);
  });

  it("uses placement='below' by default, propagates explicit placement='above'", async () => {
    // Default-below pin: a regression flipping the default to 'above'
    // would surprise customers, claim mode appends below the existing
    // page content; above is the operator-override path.
    confluenceClaim.mockResolvedValueOnce({
      external_id: "1",
      pre_claim_content_hash: "sha256:1",
    });
    captureConsole();
    await runClaim({
      cwd: dir,
      pageRef: "1",
      target: "confluence",
      mapTo: "publishing-a-site",
    });
    expect((confluenceClaim.mock.calls[0]![0] as { placement: string }).placement).toBe(
      "below",
    );
    let audit = await tailAuditEntries(dir, 10);
    expect((audit[0]!.details as Record<string, unknown>)["placement"]).toBe("below");

    confluenceClaim.mockResolvedValueOnce({
      external_id: "2",
      pre_claim_content_hash: "sha256:2",
    });
    await runClaim({
      cwd: dir,
      pageRef: "2",
      target: "confluence",
      mapTo: "publishing-a-site",
      placement: "above",
    });
    expect((confluenceClaim.mock.calls[1]![0] as { placement: string }).placement).toBe(
      "above",
    );
    audit = await tailAuditEntries(dir, 10);
    expect((audit[1]!.details as Record<string, unknown>)["placement"]).toBe("above");
  });
});

describe("runClaim publisher path, Notion success", () => {
  beforeEach(async () => {
    await setupGeneratedFixture(dir);
    setEnv(NOTION_ENV);
    confluenceClaim.mockReset();
    notionClaim.mockReset();
    confluenceCtor.mockReset();
    notionCtor.mockReset();
    installPublisherCtors();
  });

  it("resolves a 32-char hex Notion id → dashed 8-4-4-4-12 UUID", async () => {
    notionClaim.mockResolvedValueOnce({
      external_id: "abc",
      pre_claim_content_hash: "sha256:n1",
    });
    captureConsole();
    await runClaim({
      cwd: dir,
      pageRef: "0123456789abcdef0123456789abcdef",
      target: "notion",
      mapTo: "publishing-a-site",
    });
    const arg = notionClaim.mock.calls[0]![0] as { pageId: string };
    // Pin the dash insertion contract, the Notion API rejects undashed
    // ids on some endpoints, so a regression dropping the reshape would
    // surface as a 4xx mid-claim.
    expect(arg.pageId).toBe("01234567-89ab-cdef-0123-456789abcdef");
    // Cross-target safety: Confluence ctor was NOT called.
    expect(confluenceCtor).not.toHaveBeenCalled();
    // Audit entry's target field is 'notion' (a regression hooking the
    // wrong class would still hit the audit-write code but with the
    // wrong target string).
    const audit = await tailAuditEntries(dir, 10);
    expect((audit[0]!.details as Record<string, unknown>)["target"]).toBe("notion");
  });

  it("resolves a notion.so URL with embedded 32-hex id → dashed UUID", async () => {
    notionClaim.mockResolvedValueOnce({
      external_id: "abc",
      pre_claim_content_hash: "sha256:n2",
    });
    captureConsole();
    await runClaim({
      cwd: dir,
      pageRef:
        "https://www.notion.so/workspace/My-Page-Title-fedcba9876543210fedcba9876543210?query=1",
      target: "notion",
      mapTo: "publishing-a-site",
    });
    const arg = notionClaim.mock.calls[0]![0] as { pageId: string };
    expect(arg.pageId).toBe("fedcba98-7654-3210-fedc-ba9876543210");
  });

  it("malformed Notion pageRef → exit 2", async () => {
    const { error } = captureConsole();
    spyExit();
    await expect(
      runClaim({
        cwd: dir,
        pageRef: "https://www.notion.so/no-id-here",
        target: "notion",
        mapTo: "publishing-a-site",
      }),
    ).rejects.toThrow("exit:2");
    expect(error.join("\n")).toMatch(/Could not parse a Notion page id/);
    expect(notionClaim).not.toHaveBeenCalled();
  });
});

describe("runClaim publisher path, error handling", () => {
  beforeEach(async () => {
    await setupGeneratedFixture(dir);
    setEnv(CONFLUENCE_ENV);
    confluenceClaim.mockReset();
    notionClaim.mockReset();
    confluenceCtor.mockReset();
    notionCtor.mockReset();
    installPublisherCtors();
  });

  it("CLAIM_ABORTED → emits a 'claim_aborted' audit entry, exits 2, prints audit-hash", async () => {
    // Publisher throws after partial side-effects (e.g. label written
    // then body-write failed). The CLI MUST emit the rollback marker so
    // the next-claim path knows the wiki has a `code2wiki:claim:<id>`
    // label dangling, the audit entry's `entry_hash` is the operator's
    // forensic anchor and must be on stderr (claim is exit-2 → caller
    // pipes stderr to a log).
    const aborted = Object.assign(new Error("label-write failed"), {
      code: "CLAIM_ABORTED",
    });
    confluenceClaim.mockRejectedValueOnce(aborted);
    const { error } = captureConsole();
    spyExit();
    await expect(
      runClaim({
        cwd: dir,
        pageRef: "987",
        target: "confluence",
        mapTo: "publishing-a-site",
      }),
    ).rejects.toThrow("exit:2");
    const audit = await tailAuditEntries(dir, 10);
    expect(audit.length).toBe(1);
    expect(audit[0]!.operation).toBe("claim_aborted");
    expect(audit[0]!.outcome).toBe("error");
    expect(audit[0]!.page).toBe("publishing-a-site");
    const details = audit[0]!.details as Record<string, unknown>;
    expect(details["target"]).toBe("confluence");
    expect(details["page_ref"]).toBe("987");
    expect(details["error"]).toBe("label-write failed");
    const stderr = error.join("\n");
    expect(stderr).toContain("aborted: label-write failed");
    expect(stderr).toContain(audit[0]!.entry_hash);
    // The chain remains valid after the rollback entry, a corrupted
    // chain here would mean `audit verify` flags every later run.
    const verify = await verifyAuditChain(dir);
    expect(verify.ok).toBe(true);
  });

  it("generic publisher error (no CLAIM_ABORTED code) → exit 2, NO audit entry", async () => {
    // A pure network failure or 5xx during the GET-page step happens
    // BEFORE any wiki state mutation, there's nothing to roll back, so
    // we deliberately skip the audit emission. A regression emitting
    // claim_aborted here would pollute the audit log with false
    // rollback markers + waste operator attention on phantom dangling
    // labels.
    confluenceClaim.mockRejectedValueOnce(new Error("network down"));
    const { error } = captureConsole();
    spyExit();
    await expect(
      runClaim({
        cwd: dir,
        pageRef: "1",
        target: "confluence",
        mapTo: "publishing-a-site",
      }),
    ).rejects.toThrow("exit:2");
    expect(error.join("\n")).toContain("network down");
    const audit = await tailAuditEntries(dir, 10);
    expect(audit.length).toBe(0);
  });
});
