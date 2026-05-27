import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAudit } from "./audit.js";
import {
  appendAuditEntry,
  generateAuditKeypair,
  loadSigningKey,
  type AuditEntry,
} from "../../core/audit.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-audit-cli-"));
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
  return vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
    throw new Error(`exit:${String(code ?? 0)}`);
  });
}

async function writeRawAuditLines(dir: string, lines: string[]): Promise<void> {
  await fs.mkdir(path.join(dir, ".code2wiki"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".code2wiki", "audit.jsonl"),
    lines.map((l) => l + "\n").join(""),
    "utf-8",
  );
}

describe("runAudit verify", () => {
  it("prints empty-log message and does not call exit when no log file exists", async () => {
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runAudit({ cwd: dir, action: "verify" });
    expect(log).toContain("Audit log is empty (no entries yet).");
    expect(error).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("prints intact-chain success for a single valid entry", async () => {
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abcdef1234567890",
      page: "publishing-a-site",
      outcome: "created",
      contentHash: "sha256:deadbeef",
      now: () => "2026-05-11T08:00:00.000Z",
    });
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runAudit({ cwd: dir, action: "verify" });
    expect(log).toContain("Audit chain: 1/1 entries valid.");
    expect(log).toContain("✓ Chain is intact. No tampering detected.");
    expect(error).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("walks a 3-entry chain and counts every entry as valid", async () => {
    for (let i = 0; i < 3; i++) {
      await appendAuditEntry(dir, {
        operation: "generate",
        commit: "abc1234567",
        page: `slug-${i}`,
        outcome: "created",
        now: () => `2026-05-11T08:0${i}:00.000Z`,
      });
    }
    const { log } = captureConsole();
    spyExit();
    await runAudit({ cwd: dir, action: "verify" });
    expect(log).toContain("Audit chain: 3/3 entries valid.");
    expect(log).toContain("✓ Chain is intact. No tampering detected.");
  });

  it("reports a tampered entry_hash and exits 1", async () => {
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc1234",
      page: "slug-a",
      outcome: "created",
      now: () => "2026-05-11T08:00:00.000Z",
    });
    // Tamper: mutate the page name without rewriting entry_hash.
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    const tampered = raw.replace('"page":"slug-a"', '"page":"slug-A-TAMPERED"');
    await fs.writeFile(file, tampered, "utf-8");

    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await expect(runAudit({ cwd: dir, action: "verify" })).rejects.toThrow(/exit:1/);
    expect(log).toContain("Audit chain: 0/1 entries valid.");
    expect(error).toContain("✗ Chain has issues:");
    expect(error.some((s) => s.includes("entry #0") && /tampered|truncated/.test(s))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("reports a chain break (prev_hash mismatch) and exits 1", async () => {
    // Genesis entry in dir's log.
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc1",
      page: "a",
      outcome: "created",
      now: () => "2026-05-11T08:00:00.000Z",
    });
    // Mint a second entry against a *different* empty log so its prev_hash=null
    // (self-consistent entry_hash, but wrong link when appended to dir's chain).
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-audit-broken-"));
    try {
      const broken = await appendAuditEntry(tmpDir, {
        operation: "generate",
        commit: "abc2",
        page: "b",
        outcome: "created",
        now: () => "2026-05-11T08:01:00.000Z",
      });
      await fs.appendFile(
        path.join(dir, ".code2wiki", "audit.jsonl"),
        JSON.stringify(broken) + "\n",
        "utf-8",
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }

    const { log, error } = captureConsole();
    spyExit();
    await expect(runAudit({ cwd: dir, action: "verify" })).rejects.toThrow(/exit:1/);
    // The tampered entry is self-consistent (entry_hash valid), only the chain link breaks.
    // valid count == 2 because the loop increments `valid` even on chain-break,
    // logging only the chain-break error.
    expect(log.some((s) => /Audit chain:.*\/2 entries valid\./.test(s))).toBe(true);
    expect(error).toContain("✗ Chain has issues:");
    expect(error.some((s) => s.includes("entry #1") && /chain break|prev_hash/.test(s))).toBe(true);
  });

  it("surfaces the signed/unsigned split when the log is hybrid", async () => {
    // Unsigned entry first (pre-rollout), signed entry second (post-rollout),
    // the same shape as a real signing-enablement cutover. The CLI must tell
    // the operator BOTH counts, so a silently-misconfigured stretch (e.g.,
    // enabled=true but key load failed, or briefly toggled off) is visible
    // without doing arithmetic on validEntries - signedEntries.
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc1",
      page: "unsigned-p",
      outcome: "created",
      now: () => "2026-05-11T08:00:00.000Z",
    });
    const kp = await generateAuditKeypair(dir);
    const signing = await loadSigningKey(kp.privateKeyPath);
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "def2",
      page: "signed-p",
      outcome: "created",
      now: () => "2026-05-11T08:01:00.000Z",
      signing,
    });

    const { log } = captureConsole();
    spyExit();
    await runAudit({ cwd: dir, action: "verify" });
    expect(log).toContain(
      "Audit chain: 2/2 entries valid, 1 with valid signatures (1 unsigned).",
    );
    expect(log).toContain("✓ Chain is intact. No tampering detected.");
  });

  it("omits the unsigned suffix when every signed-or-not entry is signed", async () => {
    const kp = await generateAuditKeypair(dir);
    const signing = await loadSigningKey(kp.privateKeyPath);
    for (const p of ["p1", "p2"]) {
      await appendAuditEntry(dir, {
        operation: "generate",
        commit: "abc1",
        page: p,
        outcome: "created",
        signing,
      });
    }
    const { log } = captureConsole();
    spyExit();
    await runAudit({ cwd: dir, action: "verify" });
    // No "(N unsigned)" parenthetical when unsignedEntries === 0.
    expect(log).toContain("Audit chain: 2/2 entries valid, 2 with valid signatures.");
    expect(log.some((s) => /unsigned/.test(s))).toBe(false);
  });

  it("surfaces a non-JSON line as an error and continues walking", async () => {
    const valid = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc1",
      page: "a",
      outcome: "created",
      now: () => "2026-05-11T08:00:00.000Z",
    });
    // Append a garbage line after the valid one so the JSON-parse error fires
    // at index 1 (the chain break is a separate failure mode; we want to pin
    // the JSON parse path specifically).
    await writeRawAuditLines(dir, [
      JSON.stringify(valid),
      "{not-json-at-all",
    ]);

    const { error } = captureConsole();
    spyExit();
    await expect(runAudit({ cwd: dir, action: "verify" })).rejects.toThrow(/exit:1/);
    expect(error).toContain("✗ Chain has issues:");
    expect(error.some((s) => s.includes("entry #1") && /not valid JSON/.test(s))).toBe(true);
  });
});

describe("runAudit show (default action)", () => {
  it("prints the empty-log explainer when no log file exists", async () => {
    const { log } = captureConsole();
    await runAudit({ cwd: dir, action: "show" });
    expect(log.join("\n")).toContain(
      "Audit log is empty. Run 'code2wiki generate' or 'code2wiki publish' to populate.",
    );
  });

  it("renders header and one row per entry, newest at bottom", async () => {
    for (let i = 0; i < 3; i++) {
      await appendAuditEntry(dir, {
        operation: "generate",
        commit: `abcdef${i}0000`,
        page: `slug-${i}`,
        outcome: "created",
        now: () => `2026-05-11T08:0${i}:00.000Z`,
      });
    }
    const { log } = captureConsole();
    await runAudit({ cwd: dir, action: "show" });
    const joined = log.join("\n");
    expect(joined).toContain("Showing last 3 audit entries (newest at bottom):");
    expect(joined).toContain("slug-0");
    expect(joined).toContain("slug-1");
    expect(joined).toContain("slug-2");
    // Newest-at-bottom: slug-2 must appear AFTER slug-0 in stdout order.
    expect(joined.indexOf("slug-0")).toBeLessThan(joined.indexOf("slug-2"));
  });

  it("caps at the explicit --limit and reports the actual count", async () => {
    for (let i = 0; i < 5; i++) {
      await appendAuditEntry(dir, {
        operation: "generate",
        commit: "abc1",
        page: `slug-${i}`,
        outcome: "created",
        now: () => `2026-05-11T08:0${i}:00.000Z`,
      });
    }
    const { log } = captureConsole();
    await runAudit({ cwd: dir, action: "show", limit: 2 });
    const joined = log.join("\n");
    expect(joined).toContain("Showing last 2 audit entries (newest at bottom):");
    // Last two by insertion order are slug-3 and slug-4.
    expect(joined).toContain("slug-3");
    expect(joined).toContain("slug-4");
    expect(joined).not.toContain("slug-0");
    expect(joined).not.toContain("slug-1");
  });

  it("defaults the limit to 20 when no --limit is passed", async () => {
    // 21 entries; default cap should drop the oldest.
    for (let i = 0; i < 21; i++) {
      await appendAuditEntry(dir, {
        operation: "generate",
        commit: "abc1",
        page: `slug-${String(i).padStart(2, "0")}`,
        outcome: "created",
        now: () => `2026-05-11T08:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    const { log } = captureConsole();
    await runAudit({ cwd: dir, action: "show" });
    const joined = log.join("\n");
    expect(joined).toContain("Showing last 20 audit entries (newest at bottom):");
    expect(joined).not.toContain("slug-00"); // oldest dropped
    expect(joined).toContain("slug-20"); // newest kept
  });

  it("formats time, 7-char commit slice, padded operation, and page on each row", async () => {
    await appendAuditEntry(dir, {
      operation: "publish",
      commit: "abcdef1234567890",
      page: "publishing-a-site",
      outcome: "created",
      now: () => "2026-05-11T08:00:00.000Z",
    });
    const { log } = captureConsole();
    await runAudit({ cwd: dir, action: "show" });
    const row = log.find((s) => s.includes("publishing-a-site"))!;
    expect(row).toBeDefined();
    // Time: 'T' → ' ' replacement, sliced to 19 chars: "2026-05-11 08:00:00"
    expect(row).toContain("2026-05-11 08:00:00");
    // Commit: first 7 chars only.
    expect(row).toContain("abcdef1");
    expect(row).not.toContain("abcdef12"); // 8th char clipped
    // Operation: padEnd(9), "publish" (7 chars) → "publish  " (7+2 spaces).
    expect(row).toMatch(/publish {2}/);
    // Page renders verbatim.
    expect(row).toContain("publishing-a-site");
  });

  it("appends ' -> <target>' when details.target is a string", async () => {
    await appendAuditEntry(dir, {
      operation: "publish",
      commit: "abc1",
      page: "publishing-a-site",
      outcome: "updated",
      details: { target: "confluence" },
      now: () => "2026-05-11T08:00:00.000Z",
    });
    const { log } = captureConsole();
    await runAudit({ cwd: dir, action: "show" });
    const row = log.find((s) => s.includes("publishing-a-site"))!;
    expect(row).toContain(" -> confluence");
  });

  it("appends '   <url>' when details.url is a string", async () => {
    await appendAuditEntry(dir, {
      operation: "publish",
      commit: "abc1",
      page: "publishing-a-site",
      outcome: "updated",
      details: { target: "confluence", url: "https://wiki.example.com/p/123" },
      now: () => "2026-05-11T08:00:00.000Z",
    });
    const { log } = captureConsole();
    await runAudit({ cwd: dir, action: "show" });
    const row = log.find((s) => s.includes("publishing-a-site"))!;
    expect(row).toContain("https://wiki.example.com/p/123");
  });

  it("omits target/url suffixes when details lacks them or they aren't strings", async () => {
    await appendAuditEntry(dir, {
      operation: "publish",
      commit: "abc1",
      page: "slug-no-extras",
      outcome: "unchanged",
      details: { target: 42, url: null, somethingElse: "ignored" },
      now: () => "2026-05-11T08:00:00.000Z",
    });
    const { log } = captureConsole();
    await runAudit({ cwd: dir, action: "show" });
    const row = log.find((s) => s.includes("slug-no-extras"))!;
    expect(row).not.toContain(" -> ");
    expect(row).not.toContain("ignored");
  });

  it("renders the symbol for each documented outcome and falls back to '?'", async () => {
    // Build a JSONL with every documented outcome plus one out-of-enum value
    // so we can pin the `default: "?"` branch of symbolFor.
    const baseEntry: Omit<AuditEntry, "outcome" | "page" | "entry_hash"> = {
      timestamp: "2026-05-11T08:00:00.000Z",
      operation: "generate",
      commit: "abc1234",
      details: undefined,
      content_hash: null,
      prev_hash: null,
    };
    // Every documented AuditOutcome (src/core/audit.ts:48-63) gets a
    // distinct printable symbol, including the three added with the
    // retried + calibration_recomputed ops: `recovered`, `no_help`,
    // `fitted`. The default-branch `?` is reserved for genuinely
    // unknown values (forward-compat for a future enum extension).
    const outcomes: Array<[string, string]> = [
      ["created", "+"],
      ["updated", "~"],
      ["unchanged", "·"],
      ["skipped", "○"],
      ["error", "✗"],
      ["recovered", "↻"],
      ["no_help", "⊘"],
      ["fitted", "⊕"],
      ["completely-unknown", "?"], // explicit default-branch probe
    ];
    const lines = outcomes.map(([outcome], i) => {
      // entry_hash is irrelevant for show (no verify happens); placeholder string is fine.
      return JSON.stringify({
        ...baseEntry,
        page: `slug-${outcome}`,
        outcome,
        entry_hash: `sha256:dummy-${i}`,
      });
    });
    await writeRawAuditLines(dir, lines);

    const { log } = captureConsole();
    await runAudit({ cwd: dir, action: "show", limit: outcomes.length });
    const joined = log.join("\n");
    for (const [outcome, sym] of outcomes) {
      const row = log.find((s) => s.includes(`slug-${outcome}`))!;
      expect(row, `row for outcome=${outcome}`).toBeDefined();
      // The symbol sits between commit-slice and operation: ` ${sym} ${op.padEnd(9)}`.
      expect(row).toContain(` ${sym} generate`);
    }
    // Sanity: every outcome row landed.
    for (const [outcome] of outcomes) {
      expect(joined).toContain(`slug-${outcome}`);
    }
  });

  it("grows the operation column to the widest visible op (defends a stale magic-number pad)", async () => {
    // Pins the per-render dynamic-pad calculation in runAudit. The
    // historical hard-coded `.padEnd(9)` silently misaligned the table
    // whenever a wider op landed (e.g. `regenerate-skip` at 15 or
    // `calibration_recomputed` at 22). With dynamic pad-to-max, every
    // row in a given render shares the same operation-column width;
    // the test mixes a 7-char op (publish) with a 22-char op
    // (calibration_recomputed) and asserts the short row pads up to
    // match. A regression reverting to a static pad would render the
    // short row with fewer than 15 trailing spaces.
    const baseEntry: Omit<AuditEntry, "operation" | "outcome" | "page" | "entry_hash"> = {
      timestamp: "2026-05-11T08:00:00.000Z",
      commit: "abc1234",
      details: undefined,
      content_hash: null,
      prev_hash: null,
    };
    const lines = [
      JSON.stringify({
        ...baseEntry,
        operation: "publish",
        outcome: "created",
        page: "slug-short",
        entry_hash: "sha256:dummy-0",
      }),
      JSON.stringify({
        ...baseEntry,
        operation: "calibration_recomputed",
        outcome: "fitted",
        page: "slug-long",
        entry_hash: "sha256:dummy-1",
      }),
    ];
    await writeRawAuditLines(dir, lines);

    const { log } = captureConsole();
    await runAudit({ cwd: dir, action: "show", limit: 10 });

    const shortRow = log.find((s) => s.includes("slug-short"))!;
    const longRow = log.find((s) => s.includes("slug-long"))!;
    expect(shortRow).toBeDefined();
    expect(longRow).toBeDefined();

    // "publish" (7 chars) padded to 22 -> 15 trailing spaces before the page.
    expect(shortRow).toMatch(/publish {15} slug-short/);
    // "calibration_recomputed" (22 chars) takes the column at exact width:
    // 0 trailing spaces, then the single separator-space before the page.
    expect(longRow).toMatch(/calibration_recomputed slug-long/);
  });

  it("retains the historical pad-9 floor when only short ops are visible (no over-padding regression)", async () => {
    // Defends a future "simplify the floor away" refactor that would
    // collapse `Math.max(9, ...)` into a plain max. Short-op-only
    // renders should preserve the historical 9-char column so existing
    // operator habits (eyeball alignment of the page slug across short
    // rows) survive.
    await appendAuditEntry(dir, {
      operation: "publish",
      commit: "abc1",
      page: "publishing-a-site",
      outcome: "created",
      now: () => "2026-05-11T08:00:00.000Z",
    });
    await appendAuditEntry(dir, {
      operation: "manual",
      commit: "abc2",
      page: "manual-edit",
      outcome: "updated",
      now: () => "2026-05-11T09:00:00.000Z",
    });

    const { log } = captureConsole();
    await runAudit({ cwd: dir, action: "show" });

    const publishRow = log.find((s) => s.includes("publishing-a-site"))!;
    const manualRow = log.find((s) => s.includes("manual-edit"))!;
    expect(publishRow).toBeDefined();
    expect(manualRow).toBeDefined();
    // 7-char "publish" -> pad to 9 -> exactly 2 trailing spaces.
    expect(publishRow).toMatch(/publish {2} publishing-a-site/);
    // 6-char "manual" -> pad to 9 -> exactly 3 trailing spaces.
    expect(manualRow).toMatch(/manual {3} manual-edit/);
  });
});

describe("runAudit keygen", () => {
  it("prints the 4 key-location lines, then the enable-signing instruction", async () => {
    // Pins the operator-facing onboarding output of `code2wiki audit keygen`.
    // A regression that drops any of these lines (a typo silencing the
    // private-key mode reminder, an editor accidentally cutting the
    // Enable-signing two-liner) leaves an operator with a generated key and
    // no idea how to turn signing on. Pre-test only `generateAuditKeypair`'s
    // file I/O was covered (in core/audit.test.ts); the CLI's
    // 6-console.log() block above had zero coverage.
    const { log, error } = captureConsole();
    const exitSpy = spyExit();
    await runAudit({ cwd: dir, action: "keygen" });
    const joined = log.join("\n");
    expect(joined).toContain("Generated Ed25519 audit signing keypair:");
    expect(joined).toContain("Private key:");
    expect(joined).toContain("audit-key.pem (mode 0600, keep secret)");
    expect(joined).toContain("Public key:");
    expect(joined).toContain("Key ID:");
    expect(joined).toContain("Registry:");
    expect(joined).toContain("Enable signing in code2wiki.config.json:");
    expect(joined).toContain('"audit": { "signing": { "enabled": true } }');
    expect(error).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("returns early after keygen (does NOT fall through to the show/empty-log path)", async () => {
    // Pins the `return;` at audit.ts inside the keygen branch. A regression
    // that drops it would fall through to the default show action; with no
    // audit.jsonl yet, that prints the "Audit log is empty. Run …" hint,
    // confusingly suggesting the operator's keygen didn't do its job.
    const { log } = captureConsole();
    spyExit();
    await runAudit({ cwd: dir, action: "keygen" });
    const joined = log.join("\n");
    expect(joined).not.toContain("Audit log is empty");
    expect(joined).not.toContain("Showing last");
  });

  it("writes the private + public key files and a populated registry to disk", async () => {
    // Pins the contract that `runAudit` actually invokes the core keygen.
    // Without this, a regression that, say, prints the output but skips the
    // generateAuditKeypair call (e.g., a future "dry-run" mode left
    // half-implemented) would silently leave the operator with no key.
    captureConsole();
    spyExit();
    await runAudit({ cwd: dir, action: "keygen" });
    const privPath = path.join(dir, ".code2wiki", "audit-key.pem");
    const pubPath = path.join(dir, ".code2wiki", "audit-key.pub");
    const regPath = path.join(dir, ".code2wiki", "audit-keys.json");
    const priv = await fs.readFile(privPath, "utf-8");
    const pub = await fs.readFile(pubPath, "utf-8");
    const reg = JSON.parse(await fs.readFile(regPath, "utf-8")) as {
      keys: Array<{ signing_key_id: string; public_key_pem: string }>;
    };
    expect(priv).toContain("BEGIN PRIVATE KEY");
    expect(pub).toContain("BEGIN PUBLIC KEY");
    expect(reg.keys).toHaveLength(1);
    expect(reg.keys[0]!.signing_key_id).toMatch(/^[a-f0-9]/i);
    expect(reg.keys[0]!.public_key_pem).toBe(pub);
  });

  it("honors opts.keyPath and writes the key + .pub sibling to the requested location", async () => {
    // Pins the `--key-path` flag pass-through at audit.ts:21. A regression
    // dropping `keyPath: opts.keyPath` from the call would silently route
    // every keygen to the default path, ignoring the operator's flag, a
    // particularly painful failure mode for key rotation (operator wants
    // to keep the old key in place under a new name; without pass-through
    // the new key clobbers the old one).
    const customPath = path.join(dir, "custom-audit-key.pem");
    captureConsole();
    spyExit();
    await runAudit({ cwd: dir, action: "keygen", keyPath: customPath });
    const priv = await fs.readFile(customPath, "utf-8");
    const pub = await fs.readFile(
      customPath.replace(/\.pem$/, ".pub"),
      "utf-8",
    );
    expect(priv).toContain("BEGIN PRIVATE KEY");
    expect(pub).toContain("BEGIN PUBLIC KEY");
    // Default path must NOT have been created when the flag is honored.
    await expect(
      fs.stat(path.join(dir, ".code2wiki", "audit-key.pem")),
    ).rejects.toThrow();
  });

  it("appends a second key to the registry on rotation (two keygen calls keep both keys)", async () => {
    // Pins the rotation contract documented in ADR-035 + the core keygen
    // doc-comment ("old keys stay in the registry so pre-rotation entries
    // remain verifiable"). The CLI's keygen action runs this end-to-end on
    // every invocation; a regression that truncates the registry (e.g., a
    // future rewrite that opens the file with `w` instead of read-then-
    // write) would silently break verifiability of any audit entry signed
    // by a pre-rotation key. Exercising the CLI path itself catches this
    // higher up than the core-only test.
    captureConsole();
    spyExit();
    await runAudit({ cwd: dir, action: "keygen" });
    await runAudit({
      cwd: dir,
      action: "keygen",
      keyPath: path.join(dir, "rotated.pem"),
    });
    const reg = JSON.parse(
      await fs.readFile(
        path.join(dir, ".code2wiki", "audit-keys.json"),
        "utf-8",
      ),
    ) as { keys: Array<{ signing_key_id: string }> };
    expect(reg.keys).toHaveLength(2);
    // Distinct keys (sanity, in case generateKeyPair was stubbed out).
    expect(reg.keys[0]!.signing_key_id).not.toBe(reg.keys[1]!.signing_key_id);
  });
});
