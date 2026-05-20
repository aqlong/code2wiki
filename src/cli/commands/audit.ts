import {
  tailAuditEntries,
  verifyAuditChain,
  generateAuditKeypair,
} from "../../core/audit.js";

export interface AuditOptions {
  cwd: string;
  /** Sub-command: 'show' (default) | 'verify' | 'keygen' */
  action: string;
  /** For 'show': how many entries to display. Defaults to 20. */
  limit?: number;
  /** For 'verify': fail if any entry is unsigned. */
  requireSigned?: boolean;
  /** For 'keygen': output path for the private key PEM. */
  keyPath?: string;
}

export async function runAudit(opts: AuditOptions): Promise<void> {
  if (opts.action === "keygen") {
    const result = await generateAuditKeypair(opts.cwd, { keyPath: opts.keyPath });
    console.log("Generated Ed25519 audit signing keypair:");
    console.log(`  Private key: ${result.privateKeyPath} (mode 0600, keep secret)`);
    console.log(`  Public key:  ${result.publicKeyPath}`);
    console.log(`  Key ID:      ${result.signing_key_id}`);
    console.log(`  Registry:    ${result.registryPath}`);
    console.log();
    console.log("Enable signing in code2wiki.config.json:");
    console.log('  "audit": { "signing": { "enabled": true } }');
    return;
  }

  if (opts.action === "verify") {
    const result = await verifyAuditChain(opts.cwd, { requireSigned: opts.requireSigned });
    if (result.totalEntries === 0) {
      console.log("Audit log is empty (no entries yet).");
      return;
    }
    // Surface the signed/unsigned split when ANY entry carries a
    // signature, so an operator who enabled signing mid-stream (or
    // briefly toggled it off) sees the hybrid state at a glance
    // instead of having to subtract signedEntries from validEntries.
    let sigSuffix = "";
    if (result.signedEntries > 0) {
      sigSuffix = `, ${result.signedEntries} with valid signatures`;
      if (result.unsignedEntries > 0) {
        sigSuffix += ` (${result.unsignedEntries} unsigned)`;
      }
    }
    console.log(
      `Audit chain: ${result.validEntries}/${result.totalEntries} entries valid${sigSuffix}.`,
    );
    if (result.ok) {
      console.log("✓ Chain is intact. No tampering detected.");
    } else {
      console.error("✗ Chain has issues:");
      for (const e of result.errors) {
        console.error(`  entry #${e.index}: ${e.reason}`);
      }
      process.exit(1);
    }
    return;
  }

  // Default: show
  const limit = opts.limit ?? 20;
  const entries = await tailAuditEntries(opts.cwd, limit);
  if (!entries.length) {
    console.log(
      "Audit log is empty. Run 'code2wiki generate' or 'code2wiki publish' to populate.",
    );
    return;
  }
  console.log(
    `Showing last ${entries.length} audit entries (newest at bottom):\n`,
  );
  for (const e of entries) {
    const target = e.details && typeof e.details["target"] === "string"
      ? ` -> ${e.details["target"]}`
      : "";
    const url = e.details && typeof e.details["url"] === "string"
      ? `   ${e.details["url"]}`
      : "";
    const time = e.timestamp.replace("T", " ").slice(0, 19);
    const sym = symbolFor(e.outcome);
    console.log(
      `  ${time}  ${e.commit.slice(0, 7)}  ${sym} ${e.operation.padEnd(9)} ${e.page}${target}${url}`,
    );
  }
}

function symbolFor(outcome: string): string {
  switch (outcome) {
    case "created":
      return "+";
    case "updated":
      return "~";
    case "unchanged":
      return "·";
    case "skipped":
      return "○";
    case "error":
      return "✗";
    default:
      return "?";
  }
}
