// Verify the Anthropic API key is loaded and reachable.
// Prints the key prefix only (never the full value) and the result of a
// minimal `messages.create` call.
//
// Usage:
//   npm run check-key
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// Tolerant .env loader (mirrors src/core/util/env.ts but in plain ESM
// so we don't need a build step before running this script).
function loadEnvFile(filepath) {
  if (!fs.existsSync(filepath)) {
    console.log(`(file does not exist: ${filepath})`);
    return { loaded: 0, diagnostics: [] };
  }
  let raw = fs.readFileSync(filepath, "utf-8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let loaded = 0;
  const diagnostics = [];
  let lineNo = 0;
  for (const rawLine of raw.split(/\r?\n/)) {
    lineNo++;
    const line = rawLine.replace(/^﻿/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) {
      const eqIdx = trimmed.indexOf("=");
      diagnostics.push(
        `line ${lineNo}: length=${trimmed.length}, has '='=${
          eqIdx >= 0 ? "yes@" + eqIdx : "no"
        }, first-char-code=${trimmed.charCodeAt(0)}`,
      );
      continue;
    }
    const key = match[1];
    let value = match[2] ?? "";
    if (!/^["']/.test(value)) {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx);
    }
    value = value.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Overwrite empty/unset values; keep non-empty pre-existing values intact.
    if (!process.env[key]) {
      process.env[key] = value;
      loaded++;
    }
  }
  return { loaded, diagnostics };
}

const envPath = path.join(projectRoot, ".env");
const { loaded: loadedCount, diagnostics } = loadEnvFile(envPath);
console.log(`Loaded ${loadedCount} variable(s) from ${path.relative(process.cwd(), envPath)}`);
if (diagnostics.length) {
  console.log("Lines that did NOT match KEY=VALUE pattern (no values shown):");
  for (const d of diagnostics) console.log(`  ${d}`);
}

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error("✗ ANTHROPIC_API_KEY is not set after loading .env.");
  console.error(`  Check that .env contains a line starting with ANTHROPIC_API_KEY=`);
  console.error(`  Acceptable formats: 'KEY=value', 'KEY="value"', 'export KEY=value'`);
  process.exit(1);
}

const masked = `${key.slice(0, 14)}…${key.slice(-4)} (length=${key.length})`;
console.log(`✓ Key loaded: ${masked}`);

const client = new Anthropic({ apiKey: key });

try {
  const start = Date.now();
  const response = await client.messages.create({
    model: process.env.CODE2WIKI_MODEL ?? "claude-haiku-4-5-20251001",
    max_tokens: 16,
    messages: [{ role: "user", content: "say 'ok' in one word" }],
  });
  const ms = Date.now() - start;
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  console.log(`✓ API reachable (${ms}ms), model responded: "${text}"`);
  console.log(`  Tokens: in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);
  console.log("\nReady to run: npm run generate -- --cwd <path>");
} catch (e) {
  console.error(`✗ API call failed: ${e.message ?? String(e)}`);
  if (e.status === 401) {
    console.error("  → Key is invalid or expired. Check the value in your .env.");
  } else if (e.status === 429) {
    console.error("  → Rate limited. Try again in a few seconds.");
  }
  process.exit(2);
}
