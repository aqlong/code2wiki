import Anthropic from "@anthropic-ai/sdk";
import { AzureOpenAI } from "openai";
import type { Candidate, Config } from "../types.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";
import { mockExtract } from "./mock.js";

export interface ExtractOptions {
  candidate: Candidate;
  projectName: string;
  config: Config;
  /**
   * Optional structured complaint from the chain-of-correction validator
   * (src/core/feedback/validator.ts). When present, gets appended to the
   * user prompt so the LLM has the validator's specific issue list when
   * it tries again. Cache-friendly: the system prompt + main user prompt
   * stay identical, only the trailing hint differs, so the prompt cache
   * still hits the bulk of the input.
   */
  retryHint?: string;
}

// ── Backend detection ────────────────────────────────────────────────────────

export type LLMBackend = "anthropic" | "azure-openai" | "mock";

/**
 * Resolve which LLM backend to use for this call.
 *
 * Priority order (highest first):
 *   1. Mock: config.mock=true OR CODE2WIKI_MOCK=1 → always mock, no LLM.
 *   2. CODE2WIKI_LLM_BACKEND env var ('anthropic' | 'azure-openai').
 *   3. config.llmBackend ('anthropic' | 'azure-openai').
 *   4. Auto-detect:
 *      - Azure if AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT are set
 *        and ANTHROPIC_API_KEY is absent.
 *      - Anthropic if ANTHROPIC_API_KEY is set.
 *      - Mock if neither is present (zero-cost smoke-test path).
 */
export function resolveBackend(config: Config): LLMBackend {
  if (config.mock || process.env["CODE2WIKI_MOCK"] === "1") return "mock";

  const envOverride = process.env["CODE2WIKI_LLM_BACKEND"];
  if (envOverride === "azure-openai") return validateAzureEnv();
  if (envOverride === "anthropic") return "anthropic";

  const cfgBackend = config.llmBackend ?? "auto";
  if (cfgBackend === "azure-openai") return validateAzureEnv();
  if (cfgBackend === "anthropic") return "anthropic";

  // Auto-detect.
  const hasAzure =
    !!process.env["AZURE_OPENAI_API_KEY"] &&
    !!process.env["AZURE_OPENAI_ENDPOINT"];
  const hasAnthropic = !!process.env["ANTHROPIC_API_KEY"];

  if (hasAzure && !hasAnthropic) return "azure-openai";
  if (hasAnthropic) return "anthropic";
  return "mock";
}

function validateAzureEnv(): "azure-openai" {
  const missing: string[] = [];
  if (!process.env["AZURE_OPENAI_API_KEY"]) missing.push("AZURE_OPENAI_API_KEY");
  if (!process.env["AZURE_OPENAI_ENDPOINT"]) missing.push("AZURE_OPENAI_ENDPOINT");
  if (missing.length > 0) {
    throw new Error(
      `Azure OpenAI backend selected but the following env vars are missing: ${missing.join(", ")}. ` +
        "Set them and re-run, or remove CODE2WIKI_LLM_BACKEND to let code2wiki auto-detect.",
    );
  }
  return "azure-openai";
}

// ── Azure OpenAI extraction ──────────────────────────────────────────────────

async function extractWithAzure(
  userPrompt: string,
  config: Config,
): Promise<unknown> {
  const apiKey = process.env["AZURE_OPENAI_API_KEY"]!;
  const endpoint = process.env["AZURE_OPENAI_ENDPOINT"]!;
  const deployment =
    process.env["AZURE_OPENAI_DEPLOYMENT"] || config.model || "gpt-4o";
  const apiVersion =
    process.env["AZURE_OPENAI_API_VERSION"] || "2024-10-21";

  const client = new AzureOpenAI({ apiKey, endpoint, deployment, apiVersion });

  const response = await client.chat.completions.create({
    model: deployment,
    max_tokens: 4096,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const text = response.choices[0]?.message?.content ?? "";
  return parseJsonObject(text);
}

// ── Anthropic extraction ─────────────────────────────────────────────────────

async function extractWithAnthropic(
  userPrompt: string,
  config: Config,
): Promise<unknown> {
  const client = new Anthropic({
    apiKey: process.env["ANTHROPIC_API_KEY"],
  });

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
  });

  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

  return parseJsonObject(text);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the LLM extraction for a single candidate. Returns a parsed JSON
 * object matching the schema in prompts.ts. Falls back to mockExtract
 * when no API key is set or mock mode is forced.
 *
 * Backend selection: see resolveBackend(). Short version:
 *   - Mock by default (no keys needed).
 *   - Azure OpenAI when AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT are set
 *     (or CODE2WIKI_LLM_BACKEND=azure-openai / config.llmBackend=azure-openai).
 *   - Anthropic when ANTHROPIC_API_KEY is set and Azure is not selected.
 */
export async function extractWithLLM(
  opts: ExtractOptions,
): Promise<unknown> {
  const backend = resolveBackend(opts.config);

  if (backend === "mock") {
    return mockExtract(opts.candidate, opts.projectName);
  }

  const baseUserPrompt = buildUserPrompt(opts.candidate, opts.projectName);
  const userPrompt = opts.retryHint
    ? `${baseUserPrompt}\n\n---\n\n${opts.retryHint}`
    : baseUserPrompt;

  if (backend === "azure-openai") {
    return extractWithAzure(userPrompt, opts.config);
  }

  return extractWithAnthropic(userPrompt, opts.config);
}

/**
 * Per-candidate token-count breakdown for `code2wiki generate
 * --estimate-cost`. Returns system and user input tokens separately
 * because they're priced differently downstream (system has
 * cache_control: ephemeral in extractWithLLM, user does not), so the
 * cost helper applies the 50% cache discount only to systemTokens.
 *
 * NOTE: Azure OpenAI does not provide a non-billed token-counting endpoint
 * equivalent to Anthropic's messages.countTokens. When the Azure backend is
 * active, --estimate-cost is unsupported and this function throws a clear
 * error.
 *
 * Cost: the messages.countTokens endpoint is non-billed (Anthropic
 * exposes it for cost-prediction workflows like this one). Two calls
 * per candidate, one with system + user (gives total), one with user
 * alone (lets us derive system by subtraction). N candidates = 2N
 * countTokens calls; acceptable for the default maxCandidates cap of
 * 50.
 *
 * Never invokes messages.create, even when called with an API key,
 * this is purely a pre-flight measurement. The --estimate-cost flow
 * is the only consumer today.
 */
export interface CountTokensResult {
  systemTokens: number;
  userTokens: number;
}

export type CountTokensFn = (opts: {
  candidate: Candidate;
  projectName: string;
  config: Config;
}) => Promise<CountTokensResult>;

export const countTokens: CountTokensFn = async (opts) => {
  const backend = resolveBackend(opts.config);
  if (backend === "azure-openai") {
    throw new Error(
      "--estimate-cost is not supported with the Azure OpenAI backend. " +
        "Azure OpenAI does not expose a non-billed token-counting endpoint. " +
        "Remove AZURE_OPENAI_API_KEY (or set CODE2WIKI_LLM_BACKEND=anthropic) " +
        "and set ANTHROPIC_API_KEY to use the cost-estimation feature.",
    );
  }
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "countTokens requires ANTHROPIC_API_KEY (the messages.countTokens endpoint is non-billed but still authenticated).",
    );
  }
  const client = new Anthropic({
    apiKey: process.env["ANTHROPIC_API_KEY"],
  });
  const userPrompt = buildUserPrompt(opts.candidate, opts.projectName);

  // Full payload (system + user) matches the shape extractWithLLM
  // actually sends, so the total here equals what we'd be billed on.
  const totalRes = await client.messages.countTokens({
    model: opts.config.model,
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    messages: [{ role: "user", content: userPrompt }],
  });

  // User-only payload. Subtracting from `total` isolates the system
  // contribution. Doing it this way (vs counting system alone with
  // a placeholder) avoids accidentally counting the placeholder.
  const userRes = await client.messages.countTokens({
    model: opts.config.model,
    messages: [{ role: "user", content: userPrompt }],
  });

  return {
    systemTokens: totalRes.input_tokens - userRes.input_tokens,
    userTokens: userRes.input_tokens,
  };
};

function parseJsonObject(text: string): unknown {
  // Tolerate possible code-fence wrappers from the LLM.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      `LLM did not return valid JSON. First 200 chars: ${cleaned.slice(0, 200)}`,
    );
  }
}
