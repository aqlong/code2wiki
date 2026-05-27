import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";

/**
 * Append-only, hash-chained audit log.
 *
 * Lives at `.code2wiki/audit.jsonl` (one JSON object per line). Each
 * entry includes:
 *   - timestamp, operation, commit, page, outcome, details
 *   - content_hash: SHA-256 of the rendered Markdown (or null for skips)
 *   - prev_hash:    entry_hash of the immediately previous entry
 *   - entry_hash:   SHA-256 of the entry content + prev_hash
 *
 * The hash chain means any tampered or removed entry is detectable by
 * `verifyAuditChain`, which a compliance auditor can run independently.
 *
 * No data is encrypted. The log is intended to be reviewable by humans;
 * tamper-proofness comes from the chain, not from secrecy.
 */

export type AuditOperation =
  | "generate"
  | "publish"
  | "regenerate-skip"
  | "manual"
  // ADR-016: a customer adopted a hand-written wiki page as the source for
  // a generated page. `claim_aborted` is logged when the rollback path
  // after a partial failure also fails.
  | "claim"
  | "claim_aborted"
  // docs/self-learning.md signal #6: chain-of-correction retry fired
  // because the validator flagged structural errors in the LLM's first
  // draft. Logged once per candidate that triggered the retry, BEFORE
  // the corresponding `generate` entry. `details` carries the validator
  // issues so feedback tooling can aggregate which fields most often
  // fail (and motivate prompt iteration on those fields).
  | "retried"
  // ADR-034 (Self-learning v2): weekly calibration refit. Written by
  // `apps/dashboard/scripts/calibration-recompute.ts` via the GHA
  // workflow after the data gate (N >= 100 edit-back observations,
  // all three confidence buckets non-empty) is met. Details carry
  // calibrationId, nObservations, brierScore, scopeType (currently
  // "global", reserved for D6 per-customer scope), promptVersion (or
  // null when the CLI was invoked without --prompt-version), and
  // modelVersion (the serialised-model schema version; full model
  // body lives in confidence_calibration, not the audit log).
  // Contract pinned by recompute-cli.test.ts buildCalibrationAuditDetails.
  | "calibration_recomputed";

export type AuditOutcome =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped"
  | "error"
  // Outcomes specific to the `retried` op:
  // "recovered" = retry produced fewer errors than the first draft;
  // we used the retried output. "no_help" = retry did not reduce
  // errors; we kept the first draft and let renderer defaults paper
  // over the gaps. Both outcomes are healthy log states, neither
  // indicates a failed run.
  | "recovered"
  | "no_help"
  // ADR-034: calibration_recomputed op outcome.
  | "fitted";

export interface AuditEntry {
  timestamp: string; // ISO 8601
  operation: AuditOperation;
  commit: string;
  page: string; // slug or code2wiki_id
  outcome: AuditOutcome;
  /** Free-form provider-specific details (target, URL, error message). */
  details?: Record<string, unknown>;
  /** SHA-256 of the rendered Markdown body, or null when not applicable. */
  content_hash: string | null;
  /** entry_hash of the previous entry, or null for the very first one. */
  prev_hash: string | null;
  // ---- Cryptographic-signing reservation (docs/signed-audit-log-plan.md).
  // All four fields below are absent (undefined) in v1 unsigned entries.
  // canonicalJson drops undefined-valued keys so the wire format and
  // entry_hash are byte-identical to the pre-schema-bump shape for any
  // entry that does not opt into signing.
  /** Algorithm identifier for the signature (e.g. "Ed25519",
   *  "ECDSA-P256"). Planning-note D2 makes this MANDATORY for forward
   *  compat: a future v2 algorithm migration ("we switched from
   *  Ed25519 to ECDSA-P256") must not need a flag day. IN the hash
   *  for the same reason as signing_key_id: an attacker who relabels
   *  the alg without re-signing would otherwise let a verifier accept
   *  a forged signature under a weaker scheme. */
  alg?: string;
  /** Identifier (e.g. fingerprint) of the public key that signed this
   *  entry. IN the hash: an auditor needs to know which key was
   *  claimed, and a swap would otherwise be undetectable. */
  signing_key_id?: string;
  /** Detached signature over the entry_hash, base64. NOT in the hash
   *  because the hash is what gets signed (chicken-and-egg). v2 stamps
   *  this AFTER computing entry_hash. */
  signature?: string;
  /** RFC 3161 trusted-timestamp token (planning-note D8 reservation,
   *  v2). NOT in the hash because timestamping happens AFTER the
   *  signature, which happens AFTER the hash. */
  timestamp_token?: string;
  /** SHA-256 over a canonical JSON of every other field EXCEPT
   *  `signature` and `timestamp_token` (those get stamped after). */
  entry_hash: string;
}

const AUDIT_DIR = ".code2wiki";
const AUDIT_FILE = "audit.jsonl";
const AUDIT_KEYS_FILE = "audit-keys.json";

// ---- Keygen / signing types (ADR-035) ------------------------------------

interface AuditKeyEntry {
  signing_key_id: string;
  public_key_pem: string;
  created_at: string;
  valid_from: string;
  valid_until: string | null;
  revoked_at: string | null;
}

interface AuditKeyRegistry {
  keys: AuditKeyEntry[];
}

/** Compute a stable fingerprint from the raw SPKI DER bytes of a public key. */
function computePublicKeyFingerprint(pubKey: crypto.KeyObject): string {
  const der = pubKey.export({ type: "spki", format: "der" }) as Buffer;
  return "fingerprint:" + crypto.createHash("sha256").update(der).digest("hex");
}

/** Derive the public key from a private key and return its fingerprint. */
function signingKeyId(privateKey: crypto.KeyObject): string {
  return computePublicKeyFingerprint(crypto.createPublicKey(privateKey));
}

async function readKeyRegistry(projectRoot: string): Promise<AuditKeyRegistry> {
  const p = path.join(projectRoot, AUDIT_DIR, AUDIT_KEYS_FILE);
  try {
    return JSON.parse(await fs.readFile(p, "utf-8")) as AuditKeyRegistry;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { keys: [] };
    throw e;
  }
}

export interface GeneratedKeypair {
  privateKeyPath: string;
  publicKeyPath: string;
  signing_key_id: string;
  registryPath: string;
}

/**
 * Generate an Ed25519 keypair, write PEM files, and append to the key
 * registry at `.code2wiki/audit-keys.json`. Safe to call multiple times
 * (each call rotates to a new key; old keys stay in the registry so
 * pre-rotation entries remain verifiable).
 */
export async function generateAuditKeypair(
  projectRoot: string,
  opts: { keyPath?: string } = {},
): Promise<GeneratedKeypair> {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;

  const dir = path.join(projectRoot, AUDIT_DIR);
  await fs.mkdir(dir, { recursive: true });

  const privateKeyPath = opts.keyPath
    ? path.resolve(projectRoot, opts.keyPath)
    : path.join(dir, "audit-key.pem");
  const publicKeyPath = privateKeyPath.replace(/(\.[^.]+)?$/, ".pub");
  const registryPath = path.join(dir, AUDIT_KEYS_FILE);

  await fs.writeFile(privateKeyPath, privatePem, { encoding: "utf-8", mode: 0o600 });
  await fs.writeFile(publicKeyPath, publicPem, { encoding: "utf-8", mode: 0o644 });

  const kid = computePublicKeyFingerprint(publicKey);
  const now = new Date().toISOString();

  const registry = await readKeyRegistry(projectRoot);
  registry.keys.push({
    signing_key_id: kid,
    public_key_pem: publicPem,
    created_at: now,
    valid_from: now,
    valid_until: null,
    revoked_at: null,
  });
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf-8");

  return { privateKeyPath, publicKeyPath, signing_key_id: kid, registryPath };
}

export interface SigningInput {
  privateKey: crypto.KeyObject;
  signing_key_id: string;
}

/**
 * Load a private key from a PEM file and derive its `signing_key_id`.
 * Throws with a clear message if the file is missing.
 */
export async function loadSigningKey(keyPath: string): Promise<SigningInput> {
  let pem: string;
  try {
    pem = await fs.readFile(keyPath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Audit signing key not found at ${keyPath}. Run \`code2wiki audit keygen\` to generate one.`,
      );
    }
    throw e;
  }
  // Verify the file is not world-readable (best-effort; only meaningful on POSIX).
  try {
    const stat = await fs.stat(keyPath);
    if (stat.mode & fsConstants.S_IRWXO) {
      console.warn(
        `[code2wiki] Warning: ${keyPath} is readable by others (mode ${(stat.mode & 0o777).toString(8)}). Run \`chmod 600 ${keyPath}\` to restrict access.`,
      );
    }
  } catch {
    // Non-POSIX FS or permission denied reading stat; skip.
  }
  const privateKey = crypto.createPrivateKey(pem);
  return { privateKey, signing_key_id: signingKeyId(privateKey) };
}

function auditPath(projectRoot: string): string {
  return path.join(projectRoot, AUDIT_DIR, AUDIT_FILE);
}

function sha256Hex(s: string): string {
  return "sha256:" + crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

/** Stable JSON: keys sorted, undefined-valued keys dropped (matching
 *  JSON.stringify's serialization), no whitespace. Required for
 *  reproducible hashes that survive write-then-parse round-trips.
 *
 *  Exported so any external audit verifier (and the v2 signing slice)
 *  can canonicalise byte-exactly without reimplementing the contract.
 *  Pairs with the already-exported {@link computeEntryHash}: the
 *  hash is sha256("sha256:" prefix) of the canonicalJson output, and
 *  both must agree to reproduce a known entry's hash. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null"; // unreachable for top-level; safety
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined) // drop undefined like JSON.stringify does
    .sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
      .join(",") +
    "}"
  );
}

/**
 * Compute the SHA-256 entry hash over the canonical JSON of every
 * field except `entry_hash`, `signature`, and `timestamp_token`. The
 * latter two are stamped AFTER hashing (the signature signs this
 * hash; the timestamp tokens the signature) and must therefore not
 * be part of the hashed content. `signing_key_id` AND `alg` are
 * hashed so an attacker swapping either (relabeling the key or the
 * algorithm) trips the chain check.
 *
 * Exported so the future v2 signing slice (docs/signed-audit-log-plan.md)
 * and any external verifier can recompute the hash with byte-exact
 * semantics, without reimplementing the canonicalisation rules.
 */
export function computeEntryHash(entry: Omit<AuditEntry, "entry_hash">): string {
  // `signature` and `timestamp_token` are excluded from the hash so v2
  // signing / RFC-3161 timestamping can stamp them WITHOUT invalidating
  // the chain. `signing_key_id` and `alg` are INCLUDED so an attacker
  // swapping either trips the hash-mismatch check. Unsigned v1 entries
  // have all four fields undefined; canonicalJson drops undefined keys,
  // so this is a no-op for them (same hash output as pre-schema-bump).
  const { signature: _sig, timestamp_token: _ts, ...hashable } = entry;
  void _sig;
  void _ts;
  return sha256Hex(canonicalJson(hashable));
}

export function hashContent(markdown: string): string {
  return sha256Hex(markdown);
}

/** Read the most recent entry's entry_hash so the next append chains correctly. */
async function tailPrevHash(projectRoot: string): Promise<string | null> {
  const file = auditPath(projectRoot);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    if (!lines.length) return null;
    const last = JSON.parse(lines[lines.length - 1]!) as AuditEntry;
    return last.entry_hash;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw e;
  }
}

export interface AppendInput {
  operation: AuditOperation;
  commit: string;
  page: string;
  outcome: AuditOutcome;
  contentHash?: string | null;
  details?: Record<string, unknown>;
  /** Override timestamp (testing). Defaults to now. */
  now?: () => string;
  /** When provided, the entry is signed with this key (ADR-035). */
  signing?: SigningInput;
}

/** Append a single audit entry. Returns the entry_hash of the new entry. */
export async function appendAuditEntry(
  projectRoot: string,
  input: AppendInput,
): Promise<AuditEntry> {
  const file = auditPath(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const prev_hash = await tailPrevHash(projectRoot);
  const base: Omit<AuditEntry, "entry_hash"> = {
    timestamp: input.now ? input.now() : new Date().toISOString(),
    operation: input.operation,
    commit: input.commit,
    page: input.page,
    outcome: input.outcome,
    details: input.details,
    content_hash: input.contentHash ?? null,
    prev_hash,
    // Signing fields (only stamped when signing is enabled).
    ...(input.signing
      ? { alg: "Ed25519", signing_key_id: input.signing.signing_key_id }
      : {}),
  };
  const entry_hash = computeEntryHash(base);
  // Sign the entry_hash string so the signature covers everything in the hash.
  const signature = input.signing
    ? crypto
        .sign(null, Buffer.from(entry_hash, "utf-8"), input.signing.privateKey)
        .toString("base64")
    : undefined;
  const entry: AuditEntry = {
    ...base,
    entry_hash,
    ...(signature ? { signature } : {}),
  };
  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf-8");
  return entry;
}

export interface VerifyResult {
  ok: boolean;
  totalEntries: number;
  validEntries: number;
  /** Number of entries that carried a signature AND passed verification. */
  signedEntries: number;
  /** Number of entries that carried NO signature at all. Distinct from
   *  "signature failed verification": those land in `errors` and are
   *  NOT counted here. Surfaced so the CLI can tell an operator the
   *  signed/unsigned split in a hybrid log (enabled signing mid-stream
   *  or briefly disabled it) without forcing them to do the math. */
  unsignedEntries: number;
  errors: Array<{ index: number; reason: string }>;
}

export interface VerifyOptions {
  /** When true, any unsigned entry is reported as an error. Use for
   *  compliance-tier setups where every entry must be signed. */
  requireSigned?: boolean;
}

/** Walk the audit log, verifying each entry's hash, chain, and optional signatures. */
export async function verifyAuditChain(
  projectRoot: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const file = auditPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        ok: true,
        totalEntries: 0,
        validEntries: 0,
        signedEntries: 0,
        unsignedEntries: 0,
        errors: [],
      };
    }
    throw e;
  }
  const lines = raw.split("\n").filter(Boolean);
  const errors: Array<{ index: number; reason: string }> = [];
  let prevHash: string | null = null;
  let valid = 0;
  let signed = 0;
  let unsigned = 0;
  // Lazy-load the key registry only when we encounter a signed entry.
  let registry: AuditKeyRegistry | null = null;

  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[i]!) as AuditEntry;
    } catch (e) {
      errors.push({ index: i, reason: `not valid JSON: ${(e as Error).message}` });
      continue;
    }
    // Recompute entry_hash from the rest of the entry; mismatch = tampering.
    const { entry_hash, ...rest } = entry;
    const recomputed = computeEntryHash(rest);
    if (recomputed !== entry_hash) {
      errors.push({
        index: i,
        reason: `entry_hash mismatch (entry tampered or truncated)`,
      });
      prevHash = entry_hash; // continue chain so we surface multiple issues
      continue;
    }
    if (entry.prev_hash !== prevHash) {
      errors.push({
        index: i,
        reason: `prev_hash does not match previous entry's entry_hash (chain break)`,
      });
    }

    // Signature verification (ADR-035).
    if (entry.signature) {
      if (!registry) registry = await readKeyRegistry(projectRoot);
      const keyEntry = registry.keys.find(
        (k) => k.signing_key_id === entry.signing_key_id,
      );
      if (!keyEntry) {
        errors.push({
          index: i,
          reason: `unknown signing_key_id: ${entry.signing_key_id ?? "(none)"}`,
        });
      } else {
        const pubKey = crypto.createPublicKey(keyEntry.public_key_pem);
        const sigBuf = Buffer.from(entry.signature, "base64");
        const sigOk = crypto.verify(
          null,
          Buffer.from(entry_hash, "utf-8"),
          pubKey,
          sigBuf,
        );
        if (!sigOk) {
          errors.push({ index: i, reason: "signature verification failed" });
        } else {
          signed++;
        }
      }
    } else {
      // No signature on this entry. Count it as unsigned regardless of
      // --require-signed (the require-signed flag affects ok/errors,
      // not the underlying tally).
      unsigned++;
      if (opts.requireSigned) {
        errors.push({
          index: i,
          reason: "entry is unsigned (--require-signed is active)",
        });
      }
    }

    valid++;
    prevHash = entry_hash;
  }
  return {
    ok: errors.length === 0,
    totalEntries: lines.length,
    validEntries: valid,
    signedEntries: signed,
    unsignedEntries: unsigned,
    errors,
  };
}

/** Read the last N entries (newest last), parsed. */
export async function tailAuditEntries(
  projectRoot: string,
  n: number,
): Promise<AuditEntry[]> {
  // Guard against `slice(-0) === slice(0)`, without this, n=0 would return
  // every entry (and a negative n would silently fall through to slice's
  // own end-relative semantics). Both are user-surprise on `audit show --limit 0`.
  if (n <= 0) return [];
  const file = auditPath(projectRoot);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    return lines
      .slice(-n)
      .map((l) => JSON.parse(l) as AuditEntry);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return [];
    throw e;
  }
}
