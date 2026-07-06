import Anthropic from "@anthropic-ai/sdk";
import OpenAI, { AzureOpenAI } from "openai";
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

export type LLMBackend = "anthropic" | "azure-openai" | "deepseek" | "mock";

/**
 * Resolve which LLM backend to use for this call.
 *
 * Priority order (highest first):
 *   1. Mock: config.mock=true OR CODE2WIKI_MOCK=1 → always mock, no LLM.
 *   2. CODE2WIKI_LLM_BACKEND env var ('deepseek' | 'anthropic' | 'azure-openai').
 *   3. config.llmBackend ('deepseek' | 'anthropic' | 'azure-openai').
 *   4. Auto-detect:
 *      - DeepSeek if DEEPSEEK_API_KEY is set.
 *      - Anthropic if ANTHROPIC_API_KEY is set.
 *      - Azure if AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT are set.
 *      - Mock if none are present (zero-cost smoke-test path).
 */
export function resolveBackend(config: Config): LLMBackend {
  if (config.mock || process.env["CODE2WIKI_MOCK"] === "1") return "mock";

  const envOverride = process.env["CODE2WIKI_LLM_BACKEND"];
  if (envOverride === "deepseek") return validateDeepseekEnv();
  if (envOverride === "azure-openai") return validateAzureEnv();
  if (envOverride === "anthropic") return "anthropic";
  // "auto" and unset/empty fall through to config + auto-detect below. Any
  // OTHER non-empty value is a typo (e.g. "azure" for "azure-openai") that
  // would otherwise be silently ignored, routing to whatever auto-detect
  // picks (often the wrong provider on the wrong bill, the exact opposite of
  // the operator's explicit intent). Fail fast with an actionable error,
  // matching the discipline of validateAzureEnv + resolveMaxCompletionTokens.
  if (envOverride && envOverride !== "auto") {
    throw new Error(
      `CODE2WIKI_LLM_BACKEND must be one of: deepseek, anthropic, azure-openai, auto (or unset); got "${envOverride}". ` +
        "Unset it to auto-detect the backend from the available API keys.",
    );
  }

  const cfgBackend = config.llmBackend ?? "auto";
  if (cfgBackend === "deepseek") return validateDeepseekEnv();
  if (cfgBackend === "azure-openai") return validateAzureEnv();
  if (cfgBackend === "anthropic") return "anthropic";

  // Auto-detect: DeepSeek wins when DEEPSEEK_API_KEY is set.
  const hasDeepSeek = !!process.env["DEEPSEEK_API_KEY"];
  const hasAnthropic = !!process.env["ANTHROPIC_API_KEY"];
  const hasAzure =
    !!process.env["AZURE_OPENAI_API_KEY"] &&
    !!process.env["AZURE_OPENAI_ENDPOINT"];

  if (hasDeepSeek) return "deepseek";
  if (hasAnthropic) return "anthropic";
  if (hasAzure) return "azure-openai";
  return "mock";
}

function validateDeepseekEnv(): "deepseek" {
  if (!process.env["DEEPSEEK_API_KEY"]) {
    throw new Error(
      "DeepSeek backend selected but DEEPSEEK_API_KEY is missing. " +
        "Set it and re-run, or let code2wiki auto-detect by clearing CODE2WIKI_LLM_BACKEND and removing llmBackend from your code2wiki.config.json.",
    );
  }
  return "deepseek";
}

function validateAzureEnv(): "azure-openai" {
  const missing: string[] = [];
  if (!process.env["AZURE_OPENAI_API_KEY"]) missing.push("AZURE_OPENAI_API_KEY");
  if (!process.env["AZURE_OPENAI_ENDPOINT"]) missing.push("AZURE_OPENAI_ENDPOINT");
  if (missing.length > 0) {
    throw new Error(
      `Azure OpenAI backend selected but the following env vars are missing: ${missing.join(", ")}. ` +
        "Set them and re-run, or let code2wiki auto-detect by clearing CODE2WIKI_LLM_BACKEND and removing llmBackend from your code2wiki.config.json.",
    );
  }
  return "azure-openai";
}

// ── DeepSeek extraction ──────────────────────────────────────────────────────

async function extractWithDeepseek(
  userPrompt: string,
  _config: Config,
): Promise<unknown> {
  const apiKey = process.env["DEEPSEEK_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "extractWithDeepseek requires DEEPSEEK_API_KEY. " +
        "Use extractWithLLM() instead of calling this directly so backend selection is consistent.",
    );
  }

  const baseURL =
    process.env["DEEPSEEK_BASE_URL"] || "https://api.deepseek.com";
  const model =
    process.env["DEEPSEEK_MODEL"] || "deepseek-v4-flash";

  const client = new OpenAI({ baseURL, apiKey });

  const response = await client.chat.completions.create({
    model,
    max_tokens: 4096,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const text = response.choices[0]?.message?.content ?? "";
  const finishReason = response.choices[0]?.finish_reason;
  const refusal = (response.choices[0]?.message as { refusal?: string })?.refusal;

  if (!text) {
    const detail = refusal
      ? `Model refused: ${refusal}`
      : finishReason === "length"
        ? `finish_reason=length: the model exhausted its max_tokens budget (4096) before emitting any visible output. This usually means the file is too large for the model's context window. Try a smaller file or a tighter focus region.`
        : `finish_reason=${finishReason ?? "unknown"}.`;
    throw new Error(`DeepSeek returned empty content. ${detail}`);
  }

  return parseJsonObject(text);
}

// ── Azure OpenAI extraction ──────────────────────────────────────────────────

/**
 * Default headroom for Azure OpenAI completions. Sized for o-series reasoning
 * models (o1, o3, gpt-5, gpt-5-mini) which consume invisible chain-of-thought
 * tokens against this budget. Non-reasoning models (gpt-4o, gpt-4-turbo) use
 * a fraction of this and pay only for what they emit. Override with
 * AZURE_OPENAI_MAX_COMPLETION_TOKENS if you have a non-reasoning deployment
 * and want to tighten the cost cap (e.g. set to 4096 to match the Anthropic
 * path).
 */
const AZURE_DEFAULT_MAX_COMPLETION_TOKENS = 16384;

/**
 * Parse the AZURE_OPENAI_MAX_COMPLETION_TOKENS override into a positive
 * integer, or fall back to the default when it is unset/empty.
 *
 * Without this guard a typo'd value (e.g. "16k", "16,384", "4O96") coerces to
 * NaN via Number() and was passed straight to the Azure API, surfacing as an
 * opaque 400 instead of an actionable config error; "0" / "-100" / "4096.5"
 * are likewise rejected by the API but only after a round trip. This keeps the
 * same fail-fast, actionable-error discipline as validateAzureEnv. Number()
 * trims surrounding whitespace, so "  8000  " is still accepted.
 */
function resolveMaxCompletionTokens(raw: string | undefined): number {
  if (!raw) return AZURE_DEFAULT_MAX_COMPLETION_TOKENS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `AZURE_OPENAI_MAX_COMPLETION_TOKENS must be a positive integer; got "${raw}". ` +
        `Remove it to use the default (${AZURE_DEFAULT_MAX_COMPLETION_TOKENS}), ` +
        "or set it to a whole number of tokens (e.g. 4096).",
    );
  }
  return n;
}

async function extractWithAzure(
  userPrompt: string,
  config: Config,
): Promise<unknown> {
  // Defensive re-check: extractWithAzure is only called via extractWithLLM →
  // resolveBackend → validateAzureEnv, so these are validated. But if a
  // refactor ever calls this function directly, we surface the same
  // actionable error instead of a TypeError on the ! assertion.
  const apiKey = process.env["AZURE_OPENAI_API_KEY"];
  const endpoint = process.env["AZURE_OPENAI_ENDPOINT"];
  if (!apiKey || !endpoint) {
    throw new Error(
      "extractWithAzure requires AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT. " +
        "Use extractWithLLM() instead of calling this directly so backend selection is consistent.",
    );
  }

  const deployment =
    process.env["AZURE_OPENAI_DEPLOYMENT"] || config.model || "gpt-4o";
  const apiVersion =
    process.env["AZURE_OPENAI_API_VERSION"] || "2024-10-21";

  // Configurable completion budget. Reasoning models burn most of it on
  // invisible CoT; standard models barely touch it. Default sized for the
  // reasoning case. Validated up front so a typo'd value fails with an
  // actionable error instead of an opaque Azure 400.
  const maxCompletionTokens = resolveMaxCompletionTokens(
    process.env["AZURE_OPENAI_MAX_COMPLETION_TOKENS"],
  );

  const client = new AzureOpenAI({ apiKey, endpoint, deployment, apiVersion });

  // Note: Azure OpenAI auto-caches prompt prefixes >= 1024 tokens for
  // qualifying models (gpt-4o, o1, etc.). The SYSTEM_PROMPT is the stable
  // prefix here so caching kicks in automatically without an explicit
  // cache_control field (unlike Anthropic, where it must be opt-in).
  const response = await client.chat.completions.create({
    model: deployment,
    max_completion_tokens: maxCompletionTokens,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const text = response.choices[0]?.message?.content ?? "";
  const finishReason = response.choices[0]?.finish_reason;
  const refusal = (response.choices[0]?.message as { refusal?: string })?.refusal;

  if (!text) {
    const detail = refusal
      ? `Model refused: ${refusal}`
      : finishReason === "length"
        ? `finish_reason=length: the model exhausted its max_completion_tokens budget (${maxCompletionTokens}) before emitting any visible output. This usually means the file is too large for the model's context window OR (for o-series reasoning models) the reasoning chain consumed the entire budget. Try a larger AZURE_OPENAI_MAX_COMPLETION_TOKENS, a smaller file, or a non-reasoning deployment.`
        : `finish_reason=${finishReason ?? "unknown"}.`;
    throw new Error(`Azure OpenAI returned empty content. ${detail}`);
  }

  // A non-empty body can still be unparseable when the model was cut off
  // mid-JSON at the completion budget. The empty-content guard above only
  // catches the zero-visible-output case; here we have partial JSON. This is
  // common with reasoning deployments (e.g. gpt-5-mini) whose invisible
  // chain-of-thought eats the budget before the JSON finishes. Surface the same
  // actionable guidance instead of parseJsonObject's generic "did not return
  // valid JSON" error, which gives no hint that the fix is a larger budget.
  try {
    return parseJsonObject(text);
  } catch (e) {
    if (finishReason === "length") {
      throw new Error(
        `Azure OpenAI returned truncated JSON (finish_reason=length): the model hit its ` +
          `max_completion_tokens budget (${maxCompletionTokens}) mid-response, leaving incomplete JSON. ` +
          `Raise AZURE_OPENAI_MAX_COMPLETION_TOKENS, use a smaller file, or a non-reasoning deployment.`,
      );
    }
    throw e;
  }
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

  // Empty-content guard, mirroring the Azure path's diagnostic discipline.
  // Without it a truncated (max_tokens) or refused response falls through to
  // parseJsonObject(""), which throws the generic "did not return valid JSON.
  // First 200 chars:" with an empty snippet, hiding the actual cause. The
  // stop_reason names the failure mode so the operator can act on it.
  if (!text) {
    const stopReason = response.stop_reason;
    const detail =
      stopReason === "refusal"
        ? "stop_reason=refusal: the model declined to generate output for this input (safety system)."
        : stopReason === "max_tokens"
          ? "stop_reason=max_tokens: the model exhausted its max_tokens budget (4096) before emitting any visible text. This usually means the file is too large for the model's context window. Try a smaller file or a tighter focus region."
          : `stop_reason=${stopReason ?? "unknown"}.`;
    throw new Error(`Anthropic returned empty content. ${detail}`);
  }

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
 *   - DeepSeek when DEEPSEEK_API_KEY is set.
 *   - Anthropic when ANTHROPIC_API_KEY is set (and DeepSeek not selected).
 *   - Azure OpenAI when AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT are set.
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

  if (backend === "deepseek") {
    return extractWithDeepseek(userPrompt, opts.config);
  }

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
 * NOTE: Neither DeepSeek nor Azure OpenAI provide a non-billed token-counting
 * endpoint equivalent to Anthropic's messages.countTokens. When either backend
 * is active, --estimate-cost is unsupported and this function throws a clear
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
  if (backend === "deepseek") {
    throw new Error(
      "--estimate-cost is not supported with the DeepSeek backend. " +
        "DeepSeek does not expose a non-billed token-counting endpoint. " +
        "Remove DEEPSEEK_API_KEY (or set CODE2WIKI_LLM_BACKEND=anthropic) " +
        "and set ANTHROPIC_API_KEY to use the cost-estimation feature.",
    );
  }
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
