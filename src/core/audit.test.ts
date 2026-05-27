import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAuditEntry,
  verifyAuditChain,
  tailAuditEntries,
  hashContent,
  generateAuditKeypair,
  loadSigningKey,
} from "./audit.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-audit-"));
});
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe("audit log", () => {
  it("creates the file on first append", async () => {
    const entry = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc123",
      page: "foo-bar",
      outcome: "created",
      contentHash: hashContent("hello"),
    });
    expect(entry.entry_hash).toMatch(/^sha256:/);
    expect(entry.prev_hash).toBeNull();
    const file = await fs.readFile(path.join(dir, ".code2wiki", "audit.jsonl"), "utf-8");
    expect(file.split("\n").filter(Boolean).length).toBe(1);
  });

  it("chains multiple entries via prev_hash -> entry_hash", async () => {
    const e1 = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
    });
    const e2 = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p2",
      outcome: "created",
    });
    const e3 = await appendAuditEntry(dir, {
      operation: "publish",
      commit: "abc",
      page: "p1",
      outcome: "updated",
      details: { target: "confluence", url: "https://wiki.example/p1" },
    });
    expect(e2.prev_hash).toBe(e1.entry_hash);
    expect(e3.prev_hash).toBe(e2.entry_hash);

    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(true);
    expect(result.totalEntries).toBe(3);
    expect(result.validEntries).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it("verifyAuditChain returns ok on an empty (missing) log", async () => {
    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(true);
    expect(result.totalEntries).toBe(0);
  });

  it("detects in-place tampering of a single entry", async () => {
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
    });
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p2",
      outcome: "created",
    });
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    const tampered = raw.replace('"page":"p1"', '"page":"p1-EVIL"');
    await fs.writeFile(file, tampered, "utf-8");

    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.index).toBe(0);
    expect(result.errors[0]?.reason).toMatch(/entry_hash mismatch/);
  });

  it("detects an entry inserted between two valid entries", async () => {
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
    });
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p2",
      outcome: "created",
    });
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    // Forge an entry with the same prev_hash as line 2 but different content.
    // We reuse the first entry's prev_hash structure but lie about page name.
    const forged = JSON.parse(lines[1]!);
    forged.page = "p-FORGED";
    // Recompute entry_hash so that THIS entry passes its own hash check…
    // but the chain breaks because the next entry's prev_hash points at the
    // ORIGINAL entry, not this one.
    const newLines = [lines[0], JSON.stringify(forged), lines[1]];
    await fs.writeFile(file, newLines.join("\n") + "\n", "utf-8");

    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("accepts a `retried` op + `recovered` outcome and keeps the chain valid", async () => {
    // Sequence the chain-of-correction emits: retried entry first
    // (recording the validator's complaint), then the generate entry
    // for the same page. Both must round-trip through verifyAuditChain
    // so future audit-verify CLI invocations don't choke on the new op.
    const retryEntry = await appendAuditEntry(dir, {
      operation: "retried",
      commit: "abc",
      page: "checkout",
      outcome: "recovered",
      details: {
        firstIssues: [
          { field: "summary", severity: "error", message: "summary empty" },
        ],
        retriedIssues: [],
        firstErrorCount: 1,
        retriedErrorCount: 0,
      },
    });
    const genEntry = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "checkout",
      outcome: "created",
      contentHash: hashContent("# checkout\n"),
    });
    expect(genEntry.prev_hash).toBe(retryEntry.entry_hash);

    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(true);
    expect(result.totalEntries).toBe(2);
    expect(result.validEntries).toBe(2);
  });

  it("accepts a `retried` op + `no_help` outcome (retry didn't reduce errors)", async () => {
    const e = await appendAuditEntry(dir, {
      operation: "retried",
      commit: "abc",
      page: "p1",
      outcome: "no_help",
      details: {
        firstIssues: [
          { field: "summary", severity: "error", message: "summary empty" },
        ],
        retriedIssues: [
          { field: "summary", severity: "error", message: "summary empty" },
        ],
        firstErrorCount: 1,
        retriedErrorCount: 1,
      },
    });
    expect(e.operation).toBe("retried");
    expect(e.outcome).toBe("no_help");
    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(true);
  });

  it("tailAuditEntries returns the last N parsed entries", async () => {
    for (let i = 0; i < 5; i++) {
      await appendAuditEntry(dir, {
        operation: "generate",
        commit: "abc",
        page: `p${i}`,
        outcome: "created",
      });
    }
    const last3 = await tailAuditEntries(dir, 3);
    expect(last3.map((e) => e.page)).toEqual(["p2", "p3", "p4"]);
  });

  it("stamps promptVersion on every `generate` operation (ADR pin)", async () => {
    const e = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
      details: { promptVersion: "v15" },
    });
    expect(e.details).toBeDefined();
    expect(e.details?.promptVersion).toBe("v15");
  });

  it("stamps promptVersion on every `retried` operation (ADR pin)", async () => {
    const e = await appendAuditEntry(dir, {
      operation: "retried",
      commit: "abc",
      page: "p1",
      outcome: "recovered",
      details: {
        firstIssues: [],
        retriedIssues: [],
        promptVersion: "v15",
      },
    });
    expect(e.details).toBeDefined();
    expect(e.details?.promptVersion).toBe("v15");
  });
});

describe("hashContent", () => {
  it("returns the `sha256:` prefix followed by 64 lowercase hex chars", () => {
    const h = hashContent("hello");
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  it("changes when the input changes by a single byte", () => {
    expect(hashContent("hello")).not.toBe(hashContent("hellp"));
  });

  it("handles unicode input by hashing the utf-8 encoding (not codepoint count)", () => {
    // pins crypto.update(s, "utf-8"); regression to "binary" or default would
    // produce a different hash on any non-ASCII content_hash, silently breaking
    // replay-via-snapshot comparisons for any tenant publishing non-ASCII docs.
    const h = hashContent("héllo 🌍");
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h).not.toBe(hashContent("hello"));
  });
});

describe("computeEntryHash (exported pure helper)", () => {
  // computeEntryHash is the byte-identity contract for any external audit
  // verifier (per its JSDoc at audit.ts:282). The relative-invariant pins
  // further down in this file (with sig vs without, with alg vs without,
  // signing_key_id "" vs absent) defend the canonical JSON path's drop-
  // undefined + sort-keys semantics, and the appendAuditEntry literal pin
  // at line 793 defends the writer path. Neither directly pins the helper's
  // own absolute output format. A refactor that swapped the "sha256:"
  // prefix for "blake3:" (or dropped it entirely for "efficiency"), or
  // upper-cased the hex digest, or switched from SHA-256 to SHA-512, would
  // pass every existing relative pin AND only trip the writer literal test
  // if the writer call site stayed identical. Pin the helper directly so
  // the failure mode is unambiguous: "external verifiers will produce
  // different bytes than they did yesterday" lands on a test name that
  // names the contract.

  const FIXED_NOW = "2026-05-17T00:00:00.000Z";

  // Same shape the writer constructs at audit.ts:340-353 for the
  // appendAuditEntry literal-hash fixture on line 793. Reusing the
  // identical base shape is load-bearing: if the writer's literal and
  // the helper's literal ever diverge, one of the two paths drifted.
  const BASE = {
    timestamp: FIXED_NOW,
    operation: "generate" as const,
    commit: "deadbee",
    page: "demo-page",
    outcome: "created" as const,
    details: undefined,
    content_hash: hashContent("body"),
    prev_hash: null,
  };

  it("returns the `sha256:` prefix followed by 64 lowercase hex chars", async () => {
    const { computeEntryHash } = await import("./audit.js");
    expect(computeEntryHash(BASE)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("produces the byte-identical hash to the writer for the same canonical input (external-verifier contract)", async () => {
    // The literal here is the SAME value pinned at line 793 against
    // appendAuditEntry's output. The point is the equivalence: an
    // external verifier reconstructing this Omit<AuditEntry,"entry_hash">
    // and calling computeEntryHash gets exactly what the writer wrote.
    // Drift between helper and writer = silent breakage for every
    // external auditor reproducing chain hashes from raw audit.jsonl.
    const { computeEntryHash } = await import("./audit.js");
    expect(computeEntryHash(BASE)).toBe(
      "sha256:829f1d72e3f6b736785675a2233621c63f4acc51d3b312f376d0440718b4bd0f",
    );
  });

  it("is deterministic for the same input", async () => {
    const { computeEntryHash } = await import("./audit.js");
    expect(computeEntryHash(BASE)).toBe(computeEntryHash(BASE));
  });

  it("changes when a single canonical field changes by one byte", async () => {
    // Pins that hashed content actually flows into the digest. A regression
    // that hashed a constant (e.g., returned sha256(canonical_envelope_only)
    // and forgot to include the entry body) would pass shape + determinism
    // pins but produce the same hash for every entry. Sensitivity on
    // `commit` is representative; the per-field flip tests further down
    // cover the other authenticated fields individually.
    const { computeEntryHash } = await import("./audit.js");
    expect(computeEntryHash({ ...BASE, commit: "deadbef" })).not.toBe(
      computeEntryHash(BASE),
    );
  });
});

describe("canonical-hash invariants", () => {
  // The whole point of canonicalJson (sorted keys, drop-undefined) is reproducible
  // hashes that survive write-then-parse round-trips. Drift here corrupts the chain
  // for every existing audit log in the field.

  it("details key order does NOT affect entry_hash", async () => {
    // Two separate dirs so both entries are the first append (prev_hash=null),
    // and a fixed `now` so the timestamp doesn't perturb the hash.
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-canonkey-a-"));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-canonkey-b-"));
    try {
      const now = () => "2026-05-11T00:00:00.000Z";
      const eA = await appendAuditEntry(dirA, {
        operation: "generate",
        commit: "abc",
        page: "p1",
        outcome: "created",
        now,
        details: { foo: 1, bar: "two", zed: [3, 4] },
      });
      const eB = await appendAuditEntry(dirB, {
        operation: "generate",
        commit: "abc",
        page: "p1",
        outcome: "created",
        now,
        details: { zed: [3, 4], bar: "two", foo: 1 },
      });
      expect(eA.entry_hash).toBe(eB.entry_hash);
    } finally {
      await fs.rm(dirA, { recursive: true, force: true });
      await fs.rm(dirB, { recursive: true, force: true });
    }
  });

  it("a key whose value is `undefined` is dropped from the hash (matches JSON.stringify semantics)", async () => {
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-canonundef-a-"));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-canonundef-b-"));
    try {
      const now = () => "2026-05-11T00:00:00.000Z";
      const eA = await appendAuditEntry(dirA, {
        operation: "generate",
        commit: "abc",
        page: "p1",
        outcome: "created",
        now,
        details: { foo: 1, gone: undefined },
      });
      const eB = await appendAuditEntry(dirB, {
        operation: "generate",
        commit: "abc",
        page: "p1",
        outcome: "created",
        now,
        details: { foo: 1 },
      });
      expect(eA.entry_hash).toBe(eB.entry_hash);
    } finally {
      await fs.rm(dirA, { recursive: true, force: true });
      await fs.rm(dirB, { recursive: true, force: true });
    }
  });

  it("details roundtrip preserves nested objects + arrays exactly", async () => {
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
      details: {
        promptVersion: "v1",
        firstIssues: [
          { field: "summary", severity: "error", message: "summary empty" },
          { field: "actors", severity: "warning", message: "no actors" },
        ],
        nested: { a: 1, b: { c: [true, false, null] } },
      },
    });
    const [back] = await tailAuditEntries(dir, 1);
    expect(back?.details).toEqual({
      promptVersion: "v1",
      firstIssues: [
        { field: "summary", severity: "error", message: "summary empty" },
        { field: "actors", severity: "warning", message: "no actors" },
      ],
      nested: { a: 1, b: { c: [true, false, null] } },
    });
  });
});

describe("now() override", () => {
  it("sets the stored timestamp verbatim", async () => {
    const e = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
      now: () => "2024-01-02T03:04:05.678Z",
    });
    expect(e.timestamp).toBe("2024-01-02T03:04:05.678Z");
  });

  it("same `now` override + same input across dirs produces identical entry_hash", async () => {
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-now-a-"));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "code2wiki-now-b-"));
    try {
      const now = () => "2026-05-11T00:00:00.000Z";
      const eA = await appendAuditEntry(dirA, {
        operation: "publish",
        commit: "deadbeef",
        page: "p1",
        outcome: "updated",
        now,
      });
      const eB = await appendAuditEntry(dirB, {
        operation: "publish",
        commit: "deadbeef",
        page: "p1",
        outcome: "updated",
        now,
      });
      expect(eA.entry_hash).toBe(eB.entry_hash);
    } finally {
      await fs.rm(dirA, { recursive: true, force: true });
      await fs.rm(dirB, { recursive: true, force: true });
    }
  });
});

describe("content_hash variants", () => {
  it("omitting contentHash stores `null`", async () => {
    const e = await appendAuditEntry(dir, {
      operation: "regenerate-skip",
      commit: "abc",
      page: "p1",
      outcome: "unchanged",
    });
    expect(e.content_hash).toBeNull();
  });

  it("explicit `null` contentHash stores `null`", async () => {
    const e = await appendAuditEntry(dir, {
      operation: "regenerate-skip",
      commit: "abc",
      page: "p1",
      outcome: "unchanged",
      contentHash: null,
    });
    expect(e.content_hash).toBeNull();
  });

  it("hashContent output is persisted exactly through write+read+verify", async () => {
    const ch = hashContent("# checkout\n\nThe customer clicks pay.\n");
    const written = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "checkout",
      outcome: "created",
      contentHash: ch,
    });
    const [back] = await tailAuditEntries(dir, 1);
    expect(back?.content_hash).toBe(ch);
    expect(back?.entry_hash).toBe(written.entry_hash);
    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(true);
  });
});

describe("AuditOperation / AuditOutcome union coverage", () => {
  // Every operation + outcome union member must roundtrip through write -> tail -> verify.
  // Catches a regression that adds a new union member but forgets to update the
  // canonical JSON path or the verifier's parse.

  it("all 8 AuditOperation values roundtrip with a valid chain", async () => {
    const ops = [
      "generate",
      "publish",
      "regenerate-skip",
      "manual",
      "claim",
      "claim_aborted",
      "retried",
      "calibration_recomputed",
    ] as const;
    for (const op of ops) {
      await appendAuditEntry(dir, {
        operation: op,
        commit: "abc",
        page: `page-${op}`,
        outcome: "created",
      });
    }
    const all = await tailAuditEntries(dir, ops.length);
    expect(all.map((e) => e.operation)).toEqual(ops);
    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(true);
    expect(result.totalEntries).toBe(ops.length);
  });

  it("all 8 AuditOutcome values roundtrip with a valid chain", async () => {
    const outcomes = [
      "created",
      "updated",
      "unchanged",
      "skipped",
      "error",
      "recovered",
      "no_help",
      "fitted",
    ] as const;
    for (const oc of outcomes) {
      await appendAuditEntry(dir, {
        operation: "generate",
        commit: "abc",
        page: `page-${oc}`,
        outcome: oc,
      });
    }
    const all = await tailAuditEntries(dir, outcomes.length);
    expect(all.map((e) => e.outcome)).toEqual(outcomes);
    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(true);
    expect(result.totalEntries).toBe(outcomes.length);
  });
});

describe("tailAuditEntries edge cases", () => {
  it("n=0 returns empty array (guard against slice(-0) === slice(0) footgun)", async () => {
    // Without the `if (n <= 0) return [];` guard at the top of
    // tailAuditEntries, this would return the WHOLE log because
    // `arr.slice(-0) === arr.slice(0)`. User-visible surface:
    // `code2wiki audit show --limit 0` would dump every entry.
    for (let i = 0; i < 3; i++) {
      await appendAuditEntry(dir, {
        operation: "generate",
        commit: "abc",
        page: `p${i}`,
        outcome: "created",
      });
    }
    const last0 = await tailAuditEntries(dir, 0);
    expect(last0).toEqual([]);
  });

  it("negative n returns empty array (guards against slice end-relative semantics)", async () => {
    // Without the guard, `slice(-(-5))` === `slice(5)` would skip the first
    // 5 entries and return the rest; also unexpected. Negative n is not
    // a meaningful "tail count" so we collapse it to empty.
    for (let i = 0; i < 3; i++) {
      await appendAuditEntry(dir, {
        operation: "generate",
        commit: "abc",
        page: `p${i}`,
        outcome: "created",
      });
    }
    const negative = await tailAuditEntries(dir, -1);
    expect(negative).toEqual([]);
  });

  it("n greater than total returns ALL parsed entries", async () => {
    for (let i = 0; i < 3; i++) {
      await appendAuditEntry(dir, {
        operation: "generate",
        commit: "abc",
        page: `p${i}`,
        outcome: "created",
      });
    }
    const all = await tailAuditEntries(dir, 100);
    expect(all.map((e) => e.page)).toEqual(["p0", "p1", "p2"]);
  });

  it("missing log file returns an empty array (no ENOENT throw)", async () => {
    // Empty dir, no .code2wiki/audit.jsonl ever written.
    expect(await tailAuditEntries(dir, 5)).toEqual([]);
  });
});

describe("verifyAuditChain corruption modes", () => {
  it("truncated last line (incomplete JSON) is reported as a parse error", async () => {
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
    });
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p2",
      outcome: "created",
    });
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    // Chop off the trailing half of the second JSON line (leave it incomplete).
    const lines = raw.split("\n").filter(Boolean);
    const chopped = lines[1]!.slice(0, Math.floor(lines[1]!.length / 2));
    await fs.writeFile(file, lines[0] + "\n" + chopped + "\n", "utf-8");

    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.index === 1 && /not valid JSON/.test(e.reason))).toBe(true);
    expect(result.validEntries).toBe(1);
  });

  it("a non-JSON line in the middle is reported but trailing valid entries still chain", async () => {
    // After a parse error, the verifier's `continue` deliberately preserves the
    // last good prevHash so a single bad line doesn't poison the chain check
    // for the following line. Pin that behavior.
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
    });
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p2",
      outcome: "created",
    });
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    // Splice a non-JSON garbage line between the two valid lines.
    const spliced = [lines[0], "GARBAGE NOT JSON", lines[1]].join("\n") + "\n";
    await fs.writeFile(file, spliced, "utf-8");

    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(false);
    expect(result.totalEntries).toBe(3);
    expect(result.validEntries).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(1);
    expect(result.errors[0]?.reason).toMatch(/not valid JSON/);
  });

  it("appending after a tampered tail still chains (new entry internally valid; verify still flags the tamper)", async () => {
    // Subtle invariant: appendAuditEntry reads the LAST line's stored entry_hash
    // for prev_hash; it does NOT re-verify the chain before chaining. So a
    // tamperer who edits an entry in place and then watches the customer append
    // more entries will see the new entries pass their own hash checks. The
    // tamper is still surfaced by verifyAuditChain on demand.
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
    });
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    const tampered = raw.replace('"page":"p1"', '"page":"p1-EVIL"');
    await fs.writeFile(file, tampered, "utf-8");

    const fresh = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p2",
      outcome: "created",
    });
    // fresh.prev_hash chains onto the tampered tail's stored entry_hash.
    const linesAfter = (await fs.readFile(file, "utf-8")).split("\n").filter(Boolean);
    const tamperedEntry = JSON.parse(linesAfter[0]!);
    expect(fresh.prev_hash).toBe(tamperedEntry.entry_hash);

    const result = await verifyAuditChain(dir);
    // Tamper still detected; new entry doesn't mask it.
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.index === 0 && /entry_hash mismatch/.test(e.reason))).toBe(true);
    expect(result.totalEntries).toBe(2);
  });

  it("modifying prev_hash of a middle entry breaks chain verification", async () => {
    // A tamperer modifies an entry's prev_hash field to rewrite history.
    // Since prev_hash IS part of the authenticated content (included in the
    // entry_hash computation), modifying it causes the entry's entry_hash
    // to diverge from what the verifier recomputes. The tampering is
    // detected as an entry_hash mismatch.
    const e1 = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
    });
    const e2 = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p2",
      outcome: "created",
    });
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p3",
      outcome: "created",
    });
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    // Modify e2's prev_hash to a fake value.
    const tampered = raw.replace(
      `"prev_hash":"${e1.entry_hash}"`,
      `"prev_hash":"sha256:0000000000000000000000000000000000000000000000000000000000000000"`,
    );
    await fs.writeFile(file, tampered, "utf-8");

    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(false);
    // e1 is fine, but e2's entry_hash no longer recomputes correctly
    // (because prev_hash is part of the content that gets hashed).
    expect(result.errors.some((e) => e.index === 1 && /entry_hash mismatch/.test(e.reason))).toBe(true);
  });

  it("removing a middle entry from the chain breaks verification of the tail", async () => {
    // A tamperer deletes an entry from the middle, hoping the adjacent
    // entries will chain around it. But the third entry's prev_hash still
    // points to the second entry's hash, and with the second deleted, the
    // third's prev_hash no longer matches the FIRST entry. Chain breaks.
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
    });
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p2",
      outcome: "created",
    });
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p3",
      outcome: "created",
    });
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    // Remove the middle entry (p2) and splice p1 + p3 back.
    const spliced = [lines[0], lines[2]].join("\n") + "\n";
    await fs.writeFile(file, spliced, "utf-8");

    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(false);
    // Both entries have valid entry_hash, but the chain is broken:
    // p3's prev_hash doesn't match p1's entry_hash.
    expect(result.totalEntries).toBe(2);
    expect(result.validEntries).toBe(2);
    expect(result.errors.some((e) => e.index === 1 && /chain break/.test(e.reason))).toBe(true);
  });

  it("reordering two middle entries breaks the chain", async () => {
    // A tamperer swaps two adjacent entries, hoping the chain "just works"
    // because each entry's hash is still valid. But prev_hash pointers
    // break: the third entry now points to the second (which is now
    // the fourth after the swap), not the third's original pred.
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
    });
    const e2 = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p2",
      outcome: "created",
    });
    const e3 = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p3",
      outcome: "created",
    });
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    // Swap p2 and p3 (lines[1] and lines[2]).
    const swapped = [lines[0], lines[2], lines[1]].join("\n") + "\n";
    await fs.writeFile(file, swapped, "utf-8");

    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(false);
    // After the swap, p3 (now second) has e3.prev_hash which pointed to e2.
    // But e2 is now third, so the second entry's prev_hash is invalid.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /chain break/.test(e.reason))).toBe(true);
  });
});

// JSONL on-disk byte framing + hashContent algorithm fixtures + verifier
// tolerance. These contracts are load-bearing for every operator's grep / wc -l
// pipeline over .code2wiki/audit.jsonl, for every replay-via-snapshot
// content-hash comparison, and for forensics tooling that consumes the file
// byte-for-byte. None of the existing tests pin the file SHAPE (only that
// entries parse + chain); a refactor swapping JSON.stringify for
// JSON.stringify(entry, null, 2) pretty-print would inject newlines INSIDE
// each entry and still pass every existing test while silently breaking
// one-line-per-entry tooling.
describe("audit log byte-level shape", () => {
  it("file is one JSON entry per line with exactly one `\\n` separator and a trailing newline", async () => {
    // Three entries: clean baseline. No `\r\n`, no `\n\n`, no leading newline,
    // exactly one `\n` after each entry. Regression catches pretty-print
    // (newlines inside), CRLF line endings (would 2x the newline count), or
    // missing trailing newline (would mash the next append onto the last
    // entry and break tailPrevHash's split-and-filter).
    for (let i = 0; i < 3; i++) {
      await appendAuditEntry(dir, {
        operation: "generate",
        commit: "abc",
        page: `p${i}`,
        outcome: "created",
      });
    }
    const raw = await fs.readFile(
      path.join(dir, ".code2wiki", "audit.jsonl"),
      "utf-8",
    );
    expect(raw.startsWith("{")).toBe(true);
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.includes("\r\n")).toBe(false);
    expect(raw.includes("\n\n")).toBe(false);
    // Exactly 3 newlines for 3 entries (one trailing each).
    expect((raw.match(/\n/g) ?? []).length).toBe(3);
    // Split on \n -> 3 entries + 1 trailing empty string (from the final \n).
    const parts = raw.split("\n");
    expect(parts).toHaveLength(4);
    expect(parts[3]).toBe("");
    // Each non-empty part parses cleanly as a single JSON object.
    for (let i = 0; i < 3; i++) {
      expect(() => JSON.parse(parts[i]!)).not.toThrow();
    }
  });

  it("persisted key order is insertion order, NOT alphabetical (write path uses JSON.stringify, hash path uses canonicalJson)", async () => {
    // canonicalJson sorts keys alphabetically; but the ON-DISK write at
    // audit.ts:161 is JSON.stringify(entry), which preserves construction
    // order. Pin the order so a refactor leaking canonicalJson into the
    // write path (a tempting "consistency" cleanup) ships as a deliberate
    // semantic change, not an accidental one. Operator tools that key off
    // the prefix `{"timestamp":"...` would silently break on a switch to
    // alphabetical order (`{"commit":"..."`).
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
      contentHash: hashContent("body"),
      details: { foo: 1 },
    });
    const raw = await fs.readFile(
      path.join(dir, ".code2wiki", "audit.jsonl"),
      "utf-8",
    );
    const line = raw.split("\n").filter(Boolean)[0]!;
    expect(line.startsWith('{"timestamp":')).toBe(true);
    // Iterate parsed-object keys; JSON.parse preserves the insertion order
    // of the source string, so this asserts the on-disk order matches
    // appendAuditEntry's construction order at audit.ts:147-160.
    const keys = Object.keys(JSON.parse(line));
    expect(keys).toEqual([
      "timestamp",
      "operation",
      "commit",
      "page",
      "outcome",
      "details",
      "content_hash",
      "prev_hash",
      "entry_hash",
    ]);
  });

  it("file is written as UTF-8 so non-ASCII content round-trips byte-exact", async () => {
    // Pin fs.appendFile(..., "utf-8"). A regression to "binary" or "latin1"
    // would write é as a single byte 0xE9 (latin-1) and mojibake every
    // operator's `cat .code2wiki/audit.jsonl`; a regression to "utf16le"
    // would prefix every line with a BOM and break JSON.parse on the line
    // for every customer publishing non-ASCII docs (the LLM produces them
    // for any Spanish / French / Japanese codebase).
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "renée-🌍",
      outcome: "created",
      details: { author: "Renée 🌍" },
    });
    const bytes = await fs.readFile(
      path.join(dir, ".code2wiki", "audit.jsonl"),
    );
    // é (U+00E9) in UTF-8 is C3 A9; 🌍 (U+1F30D) is F0 9F 8C 8D.
    const hex = bytes.toString("hex");
    expect(hex).toContain("c3a9");
    expect(hex).toContain("f09f8c8d");
    // Round-trip via tail (which reads + parses utf-8).
    const [back] = await tailAuditEntries(dir, 1);
    expect(back?.page).toBe("renée-🌍");
    expect(back?.details).toEqual({ author: "Renée 🌍" });
  });

  it("hashContent(\"\") matches the known SHA-256 of the empty string", async () => {
    // Algorithm fixture: empty-string SHA-256 is a well-known cryptographic
    // constant. A regression from SHA-256 to SHA-1, MD5, or SHA-512 would
    // pass every structural-shape test (still hex, still 64 chars for
    // SHA-256 vs 40 for SHA-1; SHA-512 would fail the 64-char structural
    // pin but the migration window would be silent on existing chains).
    // Pin the bytes so the algorithm choice is locked.
    expect(hashContent("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashContent(\"hello\") matches the known SHA-256 of \"hello\"", async () => {
    // Second algorithm fixture: defensive against an accidental swap that
    // happened to produce a 64-hex string for empty input but diverged on
    // non-trivial input (e.g. a hypothetical KDF-with-fixed-salt). Two
    // distinct known-value fixtures effectively pin the algorithm.
    expect(hashContent("hello")).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("verifyAuditChain tolerates blank-line separators between entries", async () => {
    // The verifier reads the file via `raw.split("\n").filter(Boolean)` at
    // audit.ts:185; the filter(Boolean) is load-bearing forgiveness for
    // operator-edited audit logs (vim adds trailing whitespace, auto-
    // formatters add blank lines, git-merge-driver smudges). A refactor to
    // `raw.split("\n").slice(0, -1)` for "efficiency" would suddenly choke
    // on any whitespace mutation, surfacing as a false-positive tamper
    // alarm in an auditor's verify run. Pin the tolerance.
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
    });
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p2",
      outcome: "created",
    });
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    // Splice extra blank lines between, around, and at the head of the file.
    const spliced = "\n\n" + lines[0] + "\n\n\n" + lines[1] + "\n\n";
    await fs.writeFile(file, spliced, "utf-8");

    const result = await verifyAuditChain(dir);
    expect(result.ok).toBe(true);
    expect(result.totalEntries).toBe(2);
    expect(result.validEntries).toBe(2);
    expect(result.errors).toEqual([]);
  });
});

// ---- Cryptographic-signing schema reservation -----------------------------
//
// Schema bump per docs/signed-audit-log-plan.md "Smallest reversible slice
// for v1" step 1. The new fields (`signing_key_id`, `signature`,
// `timestamp_token`) are all OPTIONAL on AuditEntry. No CLI / writer code
// produces them yet; the v2 signing slice (gated on a Phase 3 / SOC 2 /
// on-prem-agent trigger) will. These tests pin the invariants that v2
// will depend on so a refactor cannot silently change the hash semantics
// the signature contract assumes.

describe("AuditEntry: signing-fields schema reservation", () => {
  const FIXED_NOW = () => "2026-05-17T00:00:00.000Z";
  const COMMON = {
    operation: "generate" as const,
    commit: "deadbee",
    page: "demo-page",
    outcome: "created" as const,
    contentHash: hashContent("body"),
    now: FIXED_NOW,
  };

  it("an unsigned entry's entry_hash and wire format are byte-identical to the pre-schema-bump shape", async () => {
    // The recorded literal hash was computed against the schema BEFORE
    // the signing-fields reservation. If the schema bump leaks ANY new
    // hashed content into the canonical JSON for unsigned entries, this
    // value drifts and every existing chain in the wild breaks. The
    // pinned value is the structural backstop against that.
    const e = await appendAuditEntry(dir, COMMON);
    expect(e.entry_hash).toBe(
      "sha256:829f1d72e3f6b736785675a2233621c63f4acc51d3b312f376d0440718b4bd0f",
    );
    // Wire format: signing fields must NOT appear in the JSON line for
    // an unsigned entry. JSON.stringify drops undefined keys, but a
    // regression introducing default empty strings or nulls would surface
    // here.
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    expect(raw).not.toContain("signing_key_id");
    expect(raw).not.toContain("signature");
    expect(raw).not.toContain("timestamp_token");
  });

  // Load-bearing for v2 signing: signature is excluded from the hash
  // because the hash IS what gets signed (a signature inside its own
  // hashed payload is a chicken-and-egg). A regression putting signature
  // back into the canonical JSON would mean every v2-signed entry fails
  // its own signature check.
  it("setting `signature` on an otherwise-identical entry does NOT change entry_hash", async () => {
    // We can't go through appendAuditEntry (the writer doesn't accept
    // these fields yet); recompute via the same module's helpers on raw
    // entry objects. The point of the test is that the HASH function is
    // already future-proofed.
    const { computeEntryHash } = await import("./audit.js");
    const base = {
      timestamp: FIXED_NOW(),
      operation: "generate" as const,
      commit: "abc",
      page: "p",
      outcome: "created" as const,
      content_hash: hashContent("x"),
      prev_hash: null,
    };
    const unsignedHash = computeEntryHash(base);
    const withSig = computeEntryHash({
      ...base,
      signature: "base64-of-some-signature",
    });
    expect(withSig).toBe(unsignedHash);
  });

  // Same forward-compat invariant for D8's RFC 3161 timestamp token.
  // Stamping a timestamp_token must not invalidate the hash.
  it("setting `timestamp_token` on an otherwise-identical entry does NOT change entry_hash", async () => {
    const { computeEntryHash } = await import("./audit.js");
    const base = {
      timestamp: FIXED_NOW(),
      operation: "publish" as const,
      commit: "c",
      page: "q",
      outcome: "updated" as const,
      content_hash: null,
      prev_hash: null,
    };
    const unstamped = computeEntryHash(base);
    const stamped = computeEntryHash({
      ...base,
      timestamp_token: "MIIB...rfc3161-token-bytes",
    });
    expect(stamped).toBe(unstamped);
  });

  // Distinct from signature/timestamp_token: alg IS in the hash. The
  // planning-note D2 explicitly requires the algorithm identifier so a
  // future Ed25519 -> ECDSA-P256 migration does not need a flag day,
  // AND the field must be authenticated: an attacker who could swap
  // `alg` from "Ed25519" to "ECDSA-P256" without tripping the hash
  // could trick a verifier into accepting a forged ECDSA signature
  // claiming to have been produced by the original Ed25519 key.
  it("setting `alg` on an otherwise-identical entry DOES change entry_hash (algorithm is authenticated)", async () => {
    const { computeEntryHash } = await import("./audit.js");
    const base = {
      timestamp: FIXED_NOW(),
      operation: "generate" as const,
      commit: "c",
      page: "p",
      outcome: "created" as const,
      content_hash: null,
      prev_hash: null,
    };
    const unalged = computeEntryHash(base);
    const ed25519 = computeEntryHash({ ...base, alg: "Ed25519" });
    const ecdsa = computeEntryHash({ ...base, alg: "ECDSA-P256" });
    expect(ed25519).not.toBe(unalged);
    expect(ecdsa).not.toBe(unalged);
    // Two distinct algs produce two distinct hashes. The attack this
    // mitigates: an attacker relabels Ed25519 -> ECDSA-P256 and a
    // verifier that ignores `alg` accepts a forged ECDSA signature.
    expect(ed25519).not.toBe(ecdsa);
  });

  // canonicalJson's filter is `obj[k] !== undefined`, NOT a truthiness
  // check, so `alg: ""` survives serialisation as `"alg":""` and shifts
  // the hash relative to an entry where `alg` is absent. Symmetric pin
  // to the `signing_key_id: ""` test below: a "normalise empty alg to
  // undefined" cleanup would silently collapse the two shapes and let
  // an entry hand-written with `alg: ""` mint the same hash as a
  // legitimate unalged v1 entry. Cheap and surface-symmetric: same
  // attack class applies whether the empty string lands in `alg` or
  // `signing_key_id`.
  it("`alg: \"\"` vs absent on otherwise-identical entries produce distinct entry_hashes", async () => {
    const { computeEntryHash } = await import("./audit.js");
    const base = {
      timestamp: FIXED_NOW(),
      operation: "generate" as const,
      commit: "c",
      page: "p",
      outcome: "created" as const,
      content_hash: null,
      prev_hash: null,
    };
    const absent = computeEntryHash(base);
    const emptyString = computeEntryHash({
      ...base,
      alg: "",
    });
    expect(emptyString).not.toBe(absent);
  });

  // Distinct from signature/timestamp_token: signing_key_id IS in the
  // hash. An auditor presented with a verified entry must be able to
  // trust the claimed key; if the key id were excluded, an attacker
  // who somehow obtained ANY trusted-registry key could relabel an
  // entry's signing_key_id without tripping the hash, then claim the
  // signature was made by a key they control.
  it("setting `signing_key_id` on an otherwise-identical entry DOES change entry_hash (key id is authenticated)", async () => {
    const { computeEntryHash } = await import("./audit.js");
    const base = {
      timestamp: FIXED_NOW(),
      operation: "generate" as const,
      commit: "c",
      page: "p",
      outcome: "created" as const,
      content_hash: null,
      prev_hash: null,
    };
    const unkeyed = computeEntryHash(base);
    const keyed = computeEntryHash({
      ...base,
      signing_key_id: "fingerprint:abc123",
    });
    expect(keyed).not.toBe(unkeyed);
  });

  // Distinct fingerprints must produce distinct entry_hashes. The
  // prior test pins unkeyed vs keyed (absence vs presence); this one
  // pins keyA vs keyB (two distinct defined values). A regression that
  // truncates the key id at N chars (a tempting "drop the `fingerprint:`
  // prefix" or "first 8 chars only" canonicalisation) would silently
  // collapse two fingerprints that share a prefix into the same hashed
  // content, defeating the "claimed key is authenticated" contract.
  // Use values that share a long common prefix to make the truncation-
  // class regression unambiguous.
  it("two distinct `signing_key_id` values on otherwise-identical entries produce distinct entry_hashes", async () => {
    const { computeEntryHash } = await import("./audit.js");
    const base = {
      timestamp: FIXED_NOW(),
      operation: "generate" as const,
      commit: "c",
      page: "p",
      outcome: "created" as const,
      content_hash: null,
      prev_hash: null,
    };
    const keyedA = computeEntryHash({
      ...base,
      signing_key_id: "fingerprint:abcdef0123456789aaaa",
    });
    const keyedB = computeEntryHash({
      ...base,
      signing_key_id: "fingerprint:abcdef0123456789bbbb",
    });
    expect(keyedA).not.toBe(keyedB);
  });

  // canonicalJson drops undefined-valued keys but NOT empty-string
  // values (the filter is `obj[k] !== undefined`, not `!obj[k]`). An
  // entry written with `signing_key_id: ""` is therefore semantically
  // distinct from one where the field is absent: the canonical content
  // gains a `"signing_key_id":""` pair, shifting the hash. Pinning this
  // catches a future "normalise empty strings to undefined" cleanup
  // that would silently collapse the two shapes into the same hash and
  // let an attacker writing `""` impersonate the unsigned wire format.
  it("`signing_key_id: \"\"` vs absent on otherwise-identical entries produce distinct entry_hashes", async () => {
    const { computeEntryHash } = await import("./audit.js");
    const base = {
      timestamp: FIXED_NOW(),
      operation: "generate" as const,
      commit: "c",
      page: "p",
      outcome: "created" as const,
      content_hash: null,
      prev_hash: null,
    };
    const absent = computeEntryHash(base);
    const emptyString = computeEntryHash({
      ...base,
      signing_key_id: "",
    });
    expect(emptyString).not.toBe(absent);
  });

  // Round-trip invariant: an entry stamped with the full signing trio
  // can still chain (verifyAuditChain currently has no signature-
  // verification logic, but the entry_hash check must not be tripped by
  // the new fields). This pins that the verifier correctly processes a
  // signed entry written by the real writer.
  it("verifyAuditChain accepts an entry that carries signing fields", async () => {
    const kp = await generateAuditKeypair(dir);
    const signing = await loadSigningKey(kp.privateKeyPath);
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "c",
      page: "signed-p",
      outcome: "created",
      contentHash: hashContent("body"),
      now: FIXED_NOW,
      signing,
    });

    const r = await verifyAuditChain(dir);
    expect(r.ok).toBe(true);
    expect(r.totalEntries).toBe(1);
    expect(r.validEntries).toBe(1);
    expect(r.signedEntries).toBe(1);
  });

  // Multi-entry-chain forward-compat. Two signed entries must chain cleanly
  // and both be signature-verified. Tests that tailPrevHash correctly reads
  // entry_hash from a signed line (it carries extra fields).
  it("verifyAuditChain accepts a two-entry chain where BOTH entries are signed (forward-compat)", async () => {
    const kp = await generateAuditKeypair(dir);
    const signing = await loadSigningKey(kp.privateKeyPath);
    await appendAuditEntry(dir, {
      operation: "generate", commit: "c1", page: "signed-p1",
      outcome: "created", contentHash: hashContent("body-a"), signing,
    });
    await appendAuditEntry(dir, {
      operation: "publish", commit: "c2", page: "signed-p2",
      outcome: "updated", signing,
    });

    const r = await verifyAuditChain(dir);
    expect(r.ok).toBe(true);
    expect(r.totalEntries).toBe(2);
    expect(r.validEntries).toBe(2);
    expect(r.signedEntries).toBe(2);
    expect(r.errors).toEqual([]);
  });

  // Migration forward-compat. A real customer flow at v2 cutover: unsigned
  // entries (pre-rollout) followed by signed entries (post-rollout). The
  // chain MUST cross the boundary cleanly.
  it("verifyAuditChain accepts an unsigned entry followed by a signed entry (migration boundary)", async () => {
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "c1",
      page: "unsigned-p",
      outcome: "created",
      contentHash: hashContent("body"),
      now: FIXED_NOW,
    });
    const kp = await generateAuditKeypair(dir);
    const signing = await loadSigningKey(kp.privateKeyPath);
    await appendAuditEntry(dir, {
      operation: "generate",
      commit: "c2",
      page: "signed-p",
      outcome: "created",
      contentHash: hashContent("body2"),
      signing,
    });

    const r = await verifyAuditChain(dir);
    expect(r.ok).toBe(true);
    expect(r.totalEntries).toBe(2);
    expect(r.validEntries).toBe(2);
    expect(r.signedEntries).toBe(1);
    expect(r.errors).toEqual([]);
  });

  // End-to-end pin of the planning-note D2 attack mitigation: an
  // attacker with write access to .code2wiki/audit.jsonl flips a
  // signed entry's `alg` from "Ed25519" to "ECDSA-P256" without
  // changing the signature, hoping a verifier that ignores `alg`
  // accepts a forged ECDSA signature under the original Ed25519 key.
  // Because `alg` IS in the hashed content (line 859's unit pin), the
  // verifier's recomputed hash diverges from the stored entry_hash
  // and verifyAuditChain reports the tamper. Symmetric to the body-
  // field tampering test at line 72; extends the same invariant to
  // the v2-reservation surface end-to-end through the fs roundtrip.
  it("verifyAuditChain detects in-place tampering of `alg` on a signed entry (D2 relabel-then-replay attack)", async () => {
    const { computeEntryHash } = await import("./audit.js");
    const base = {
      timestamp: FIXED_NOW(),
      operation: "generate" as const,
      commit: "c",
      page: "signed-p",
      outcome: "created" as const,
      content_hash: hashContent("body"),
      prev_hash: null,
      alg: "Ed25519",
      signing_key_id: "fingerprint:abc",
    };
    const entry_hash = computeEntryHash(base);
    const signed = {
      ...base,
      signature: "base64-signature-bytes",
      timestamp_token: "base64-rfc3161-token",
      entry_hash,
    };
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(signed) + "\n", "utf-8");
    // Surgical swap: only the alg value moves, every other byte
    // (signature included) stays identical.
    const raw = await fs.readFile(file, "utf-8");
    const tampered = raw.replace(
      '"alg":"Ed25519"',
      '"alg":"ECDSA-P256"',
    );
    expect(tampered).not.toBe(raw);
    await fs.writeFile(file, tampered, "utf-8");

    const r = await verifyAuditChain(dir);
    expect(r.ok).toBe(false);
    expect(r.totalEntries).toBe(1);
    expect(r.validEntries).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.index).toBe(0);
    expect(r.errors[0]?.reason).toMatch(/entry_hash mismatch/);
  });

  // Symmetric end-to-end pin for `signing_key_id`: an attacker flips
  // the claimed key id on disk, hoping a verifier that ignores
  // signing_key_id accepts a signature made by a key they control.
  // Because signing_key_id IS in the hashed content (line 915's unit
  // pin), the verifier's recomputed hash diverges and the tamper is
  // surfaced. Distinct attack class from the `alg` swap: this
  // mitigates "key A signed it, attacker relabels to key B (which
  // the attacker controls)" rather than "Ed25519 -> ECDSA-P256".
  it("verifyAuditChain detects in-place tampering of `signing_key_id` on a signed entry", async () => {
    const { computeEntryHash } = await import("./audit.js");
    const base = {
      timestamp: FIXED_NOW(),
      operation: "generate" as const,
      commit: "c",
      page: "signed-p",
      outcome: "created" as const,
      content_hash: hashContent("body"),
      prev_hash: null,
      alg: "Ed25519",
      signing_key_id: "fingerprint:abc",
    };
    const entry_hash = computeEntryHash(base);
    const signed = {
      ...base,
      signature: "base64-signature-bytes",
      timestamp_token: "base64-rfc3161-token",
      entry_hash,
    };
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(signed) + "\n", "utf-8");
    const raw = await fs.readFile(file, "utf-8");
    const tampered = raw.replace(
      '"signing_key_id":"fingerprint:abc"',
      '"signing_key_id":"fingerprint:xyz"',
    );
    expect(tampered).not.toBe(raw);
    await fs.writeFile(file, tampered, "utf-8");

    const r = await verifyAuditChain(dir);
    expect(r.ok).toBe(false);
    expect(r.totalEntries).toBe(1);
    expect(r.validEntries).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.index).toBe(0);
    expect(r.errors[0]?.reason).toMatch(/entry_hash mismatch/);
  });
});

// ---- Ed25519 signing (ADR-035) -------------------------------------------

describe("Ed25519 signing: generateAuditKeypair", () => {
  it("creates PEM files and registry with a stable fingerprint", async () => {
    const kp = await generateAuditKeypair(dir);
    expect(kp.signing_key_id).toMatch(/^fingerprint:[0-9a-f]{64}$/);
    // Private key file must exist at the default location.
    const privatePem = await fs.readFile(kp.privateKeyPath, "utf-8");
    expect(privatePem).toMatch(/BEGIN PRIVATE KEY/);
    // Public key file exists next to private.
    const publicPem = await fs.readFile(kp.publicKeyPath, "utf-8");
    expect(publicPem).toMatch(/BEGIN PUBLIC KEY/);
    // Registry entry was appended.
    const raw = await fs.readFile(kp.registryPath, "utf-8");
    const reg = JSON.parse(raw);
    expect(reg.keys).toHaveLength(1);
    expect(reg.keys[0].signing_key_id).toBe(kp.signing_key_id);
    expect(reg.keys[0].revoked_at).toBeNull();
    expect(reg.keys[0].valid_until).toBeNull();
  });

  it("second keygen appends a second key without removing the first", async () => {
    const kp1 = await generateAuditKeypair(dir);
    const kp2 = await generateAuditKeypair(dir, {
      keyPath: path.join(dir, ".code2wiki", "audit-key-2.pem"),
    });
    expect(kp1.signing_key_id).not.toBe(kp2.signing_key_id);
    const raw = await fs.readFile(kp1.registryPath, "utf-8");
    const reg = JSON.parse(raw);
    // Both keys in the registry so old entries remain verifiable.
    expect(reg.keys).toHaveLength(2);
    expect(reg.keys.map((k: { signing_key_id: string }) => k.signing_key_id)).toContain(kp1.signing_key_id);
    expect(reg.keys.map((k: { signing_key_id: string }) => k.signing_key_id)).toContain(kp2.signing_key_id);
  });

  it("loadSigningKey reads the private key and derives the same signing_key_id", async () => {
    const kp = await generateAuditKeypair(dir);
    const loaded = await loadSigningKey(kp.privateKeyPath);
    expect(loaded.signing_key_id).toBe(kp.signing_key_id);
  });

  it("loadSigningKey throws a helpful error when the key file is missing", async () => {
    const missing = path.join(dir, ".code2wiki", "nonexistent.pem");
    await expect(loadSigningKey(missing)).rejects.toThrow(/audit keygen/);
  });
});

describe("Ed25519 signing: appendAuditEntry + verifyAuditChain", () => {
  it("signed entry carries alg, signing_key_id, signature; chain verifies", async () => {
    const kp = await generateAuditKeypair(dir);
    const signing = await loadSigningKey(kp.privateKeyPath);
    const e = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "abc",
      page: "p1",
      outcome: "created",
      signing,
    });
    expect(e.alg).toBe("Ed25519");
    expect(e.signing_key_id).toBe(kp.signing_key_id);
    expect(e.signature).toBeDefined();
    expect(typeof e.signature).toBe("string");

    const r = await verifyAuditChain(dir);
    expect(r.ok).toBe(true);
    expect(r.totalEntries).toBe(1);
    expect(r.validEntries).toBe(1);
    expect(r.signedEntries).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it("tampering the page on a signed entry fails both hash AND signature checks", async () => {
    const kp = await generateAuditKeypair(dir);
    const signing = await loadSigningKey(kp.privateKeyPath);
    await appendAuditEntry(dir, {
      operation: "generate", commit: "abc", page: "p1", outcome: "created", signing,
    });
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    await fs.writeFile(file, raw.replace('"page":"p1"', '"page":"p1-EVIL"'));
    const r = await verifyAuditChain(dir);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.reason).toMatch(/entry_hash mismatch/);
    // signedEntries stays 0 because the hash check fails before signature check.
    expect(r.signedEntries).toBe(0);
  });

  it("forging a signature (wrong bytes) on an otherwise valid entry is detected", async () => {
    const kp = await generateAuditKeypair(dir);
    const signing = await loadSigningKey(kp.privateKeyPath);
    await appendAuditEntry(dir, {
      operation: "generate", commit: "abc", page: "p1", outcome: "created", signing,
    });
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    const entry = JSON.parse(raw.trim());
    // Swap the signature for a base64-encoded zero buffer of the same length.
    const zeroSig = Buffer.alloc(64).toString("base64");
    entry.signature = zeroSig;
    await fs.writeFile(file, JSON.stringify(entry) + "\n", "utf-8");

    const r = await verifyAuditChain(dir);
    // entry_hash still matches (we only changed `signature`, which is excluded
    // from the hash), BUT signature verification must fail.
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.reason).toMatch(/signature verification failed/);
    expect(r.signedEntries).toBe(0);
  });

  it("hybrid chain (unsigned then signed) verifies cleanly with correct signedEntries count", async () => {
    // Unsigned entry written before signing was enabled.
    await appendAuditEntry(dir, {
      operation: "generate", commit: "abc", page: "unsigned-p", outcome: "created",
    });
    const kp = await generateAuditKeypair(dir);
    const signing = await loadSigningKey(kp.privateKeyPath);
    await appendAuditEntry(dir, {
      operation: "generate", commit: "def", page: "signed-p", outcome: "created", signing,
    });

    const r = await verifyAuditChain(dir);
    expect(r.ok).toBe(true);
    expect(r.totalEntries).toBe(2);
    expect(r.validEntries).toBe(2);
    expect(r.signedEntries).toBe(1);
    expect(r.unsignedEntries).toBe(1);
  });

  it("--requireSigned rejects unsigned entries", async () => {
    await appendAuditEntry(dir, {
      operation: "generate", commit: "abc", page: "p1", outcome: "created",
    });
    const r = await verifyAuditChain(dir, { requireSigned: true });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.reason).toMatch(/unsigned/);
    expect(r.signedEntries).toBe(0);
    // unsignedEntries is the underlying tally; requireSigned only flips
    // it from "informational" to "an error in the chain".
    expect(r.unsignedEntries).toBe(1);
  });

  it("--requireSigned passes when every entry is signed", async () => {
    const kp = await generateAuditKeypair(dir);
    const signing = await loadSigningKey(kp.privateKeyPath);
    for (const p of ["p1", "p2"]) {
      await appendAuditEntry(dir, {
        operation: "generate", commit: "abc", page: p, outcome: "created", signing,
      });
    }
    const r = await verifyAuditChain(dir, { requireSigned: true });
    expect(r.ok).toBe(true);
    expect(r.signedEntries).toBe(2);
  });

  it("key rotation: old and new keys both verify their respective entries", async () => {
    // Key 1: generates two entries.
    const kp1 = await generateAuditKeypair(dir);
    const sign1 = await loadSigningKey(kp1.privateKeyPath);
    await appendAuditEntry(dir, {
      operation: "generate", commit: "abc", page: "a", outcome: "created", signing: sign1,
    });
    await appendAuditEntry(dir, {
      operation: "generate", commit: "abc", page: "b", outcome: "created", signing: sign1,
    });

    // Key 2 (rotation): generates one more entry.
    const kp2 = await generateAuditKeypair(dir, {
      keyPath: path.join(dir, ".code2wiki", "audit-key-2.pem"),
    });
    const sign2 = await loadSigningKey(kp2.privateKeyPath);
    await appendAuditEntry(dir, {
      operation: "generate", commit: "def", page: "c", outcome: "created", signing: sign2,
    });

    const r = await verifyAuditChain(dir);
    expect(r.ok).toBe(true);
    expect(r.totalEntries).toBe(3);
    expect(r.signedEntries).toBe(3);
  });

  it("unknown signing_key_id (entry claims a key not in registry) is reported", async () => {
    // Write a signed entry with a key that is NOT in the registry by
    // hand-crafting the entry (simulates an attacker injecting a forged
    // key id or a key from a different project).
    const { computeEntryHash } = await import("./audit.js");
    // First ensure the registry file exists (keygen creates it).
    await generateAuditKeypair(dir);
    const base = {
      timestamp: "2026-05-19T00:00:00.000Z",
      operation: "generate" as const,
      commit: "c",
      page: "p",
      outcome: "created" as const,
      content_hash: null,
      prev_hash: null,
      alg: "Ed25519",
      signing_key_id: "fingerprint:000000000000000000000000000000000000000000000000unknown",
    };
    const entry_hash = computeEntryHash(base);
    const entry = { ...base, signature: Buffer.alloc(64).toString("base64"), entry_hash };
    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    // Overwrite the log with our forged entry (prev_hash=null so chain is consistent).
    await fs.writeFile(file, JSON.stringify(entry) + "\n", "utf-8");

    const r = await verifyAuditChain(dir);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.reason).toMatch(/unknown signing_key_id/);
  });

  it("detects tampering to the signature field on a signed entry", async () => {
    // A signed entry with valid entry_hash, alg, signing_key_id, and
    // a correct signature is legitimate. If an attacker modifies only
    // the `signature` field to a different base64 string (leaving
    // entry_hash and other authenticated content intact), the signature
    // verification must fail: crypto.verify() of the modified signature
    // against the entry_hash fails. The tamper is detected.
    const kp = await generateAuditKeypair(dir);
    const signing = await loadSigningKey(kp.privateKeyPath);
    const entry = await appendAuditEntry(dir, {
      operation: "generate",
      commit: "c",
      page: "signed-p",
      outcome: "created",
      contentHash: hashContent("body"),
      signing,
    });

    const file = path.join(dir, ".code2wiki", "audit.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    // Replace the signature with a different valid base64 string
    // (use a 64-byte null buffer to ensure valid base64 format).
    const fakeSignature = Buffer.alloc(64).toString("base64");
    const tampered = raw.replace(
      `"signature":"${entry.signature}"`,
      `"signature":"${fakeSignature}"`,
    );
    expect(tampered).not.toBe(raw);
    await fs.writeFile(file, tampered, "utf-8");

    const r = await verifyAuditChain(dir);
    expect(r.ok).toBe(false);
    expect(r.totalEntries).toBe(1);
    expect(r.validEntries).toBe(1); // entry_hash recomputes correctly
    expect(r.signedEntries).toBe(0); // but signature fails
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toMatch(/signature verification failed/);
  });
});

describe("canonicalJson (pure helper backing computeEntryHash)", () => {
  // canonicalJson at src/core/audit.ts:248 is the byte-identity helper for
  // every audit-entry hash. The chain check downstream relies on it to
  // reproduce the same string from the same logical fields no matter the
  // key-insertion order in the source object. Pre-pin coverage was
  // indirect (through computeEntryHash + the round-trip integration
  // tests); the contract details below regress easily under "tidy-up"
  // refactors (drop a sort, swap a filter), so each invariant gets a
  // targeted assertion that names the failure mode in plain English.

  it("string primitives pass through JSON.stringify (quotes, escaping)", async () => {
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson("foo")).toBe('"foo"');
    // Embedded double-quote + backslash must escape correctly so the
    // canonicalised string remains valid JSON for downstream parse.
    expect(canonicalJson('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("number / boolean / null primitives pass through JSON.stringify", async () => {
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-1.5)).toBe("-1.5");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(null)).toBe("null");
  });

  it("undefined at the top level returns \"null\" (safety branch)", async () => {
    // The early-return at audit.ts:249 is the documented "unreachable in
    // normal usage" safety; pinning it guards against a refactor that
    // collapses the null/object branch and routes undefined into
    // JSON.stringify(undefined) (returns undefined, not a string, which
    // would break every downstream concat).
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("empty object renders as \"{}\"; empty array renders as \"[]\"", async () => {
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });

  it("multi-key object: keys sorted alphabetically (defends the .sort() removal)", async () => {
    // Without .sort() the output would depend on Object.keys iteration
    // order (insertion order in V8), so two semantically equal objects
    // built in different orders would hash differently and break the
    // chain. Build with reverse-alphabetical insertion to make any
    // insertion-order regression visible.
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson({ c: 3, b: 2, a: 1 })).toBe('{"a":1,"b":2,"c":3}');
  });

  it("nested object: keys sorted recursively (defends sort-only-at-top-level)", async () => {
    // A "sort only the outer keys" optimisation would leave the inner
    // object's keys in insertion order and break the chain for any
    // entry whose details payload nests an object built in a different
    // order across runs. The exact-equality assertion catches the
    // recursive descent.
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson({ b: { y: 2, x: 1 }, a: 0 })).toBe(
      '{"a":0,"b":{"x":1,"y":2}}',
    );
  });

  it("array preserves insertion order (NOT sorted)", async () => {
    // Arrays are semantically ordered; canonicalJson MUST leave them
    // alone. Defends a well-meaning "sort everything" refactor that
    // would corrupt audit details where order matters (e.g., a list of
    // first-draft validator errors emitted in retry order).
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson(["c", "a", "b"])).toBe('["c","a","b"]');
  });

  it("undefined-valued keys are dropped (matches JSON.stringify behaviour)", async () => {
    // Mirrors JSON.stringify so callers can pass partial objects without
    // worrying about explicit-undefined leaking into the hash. The
    // implementation filters with `obj[k] !== undefined`; mutation to a
    // truthy filter would also drop null / "" / 0 / false (see the four
    // tests below pinning those distinctly).
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
    expect(canonicalJson({ k: undefined })).toBe("{}");
  });

  it("null-valued keys are RETAINED (distinct from undefined-drop)", async () => {
    // Load-bearing: an explicit null in audit details carries meaning
    // (e.g., parent_hash=null on the genesis entry) and MUST survive the
    // canonicalisation. A truthy-filter regression would drop nulls and
    // re-hash to a different value on every cold-start.
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson({ a: 1, b: null })).toBe('{"a":1,"b":null}');
  });

  it("empty-string-valued keys are RETAINED (distinct from undefined-drop)", async () => {
    // promptVersion="" would silently disappear under a truthy filter
    // (or `obj[k] != null`), conflating "operator set the flag to empty"
    // with "operator never set the flag". Pins the strict !== undefined
    // discriminator.
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson({ k: "" })).toBe('{"k":""}');
  });

  it("zero-valued keys are RETAINED (distinct from undefined-drop)", async () => {
    // nObservations=0 in a skipped calibration audit entry must survive.
    // A truthy filter would drop it and the audit-show display would
    // render a missing field instead of "0 observations".
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson({ k: 0 })).toBe('{"k":0}');
  });

  it("false-valued keys are RETAINED (distinct from undefined-drop)", async () => {
    // dryRun=false in a wet recompute run must survive. A truthy filter
    // would drop the discriminator and the audit would be ambiguous as
    // to which branch ran.
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson({ k: false })).toBe('{"k":false}');
  });

  it("undefined INSIDE an array renders as \"null\" (mirrors JSON.stringify)", async () => {
    // Arrays are positional; dropping an undefined element would shift
    // every subsequent index. JSON.stringify and canonicalJson both
    // preserve length by emitting "null" for undefined slots.
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("emits no whitespace between tokens", async () => {
    // Whitespace would change the byte-string and therefore the hash.
    // Defends a debug-readability refactor that adds JSON.stringify's
    // space argument.
    const { canonicalJson } = await import("./audit.js");
    const out = canonicalJson({ a: 1, b: [1, 2], c: { d: 3 } });
    expect(out).toBe('{"a":1,"b":[1,2],"c":{"d":3}}');
    expect(out).not.toMatch(/\s/);
  });

  it("keys with special characters are JSON.stringify-escaped (not raw concat)", async () => {
    // The key serialisation path is `JSON.stringify(k) + ":"`; without
    // it, a key containing a double-quote would break the output's JSON
    // validity. Pins the escape behaviour for adversarial / unusual keys.
    const { canonicalJson } = await import("./audit.js");
    expect(canonicalJson({ 'k"with"quotes': 1 })).toBe(
      '{"k\\"with\\"quotes":1}',
    );
  });

  it("output is parseable JSON that round-trips to a semantically equal value", async () => {
    // Catches any output that drifts away from strict JSON syntax (e.g.,
    // trailing commas, unquoted keys, NaN, Infinity). The pin is the
    // round-trip equivalence: JSON.parse(canonicalJson(x)) must deeply
    // equal x with undefined-valued keys dropped.
    const { canonicalJson } = await import("./audit.js");
    const input = {
      operation: "generate",
      page: "foo-bar",
      details: {
        promptVersion: "v5",
        retryOutcome: null,
        firstDraftErrors: 0,
        wasSkipped: false,
      },
      tags: ["a", "b"],
    };
    expect(JSON.parse(canonicalJson(input))).toEqual(input);
  });
});
