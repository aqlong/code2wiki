import Anthropic from "@anthropic-ai/sdk";
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

/**
 * Run the LLM extraction for a single candidate. Returns a parsed JSON
 * object matching the schema in prompts.ts. Falls back to mockExtract
 * when no API key is set or mock mode is forced.
 */
export async function extractWithLLM(
  opts: ExtractOptions,
): Promise<unknown> {
  const useMock =
    opts.config.mock ||
    process.env["CODE2WIKI_MOCK"] === "1" ||
    !process.env["ANTHROPIC_API_KEY"];

  if (useMock) {
    return mockExtract(opts.candidate, opts.projectName);
  }

  const client = new Anthropic({
    apiKey: process.env["ANTHROPIC_API_KEY"],
  });

  const baseUserPrompt = buildUserPrompt(opts.candidate, opts.projectName);
  const userPrompt = opts.retryHint
    ? `${baseUserPrompt}\n\n---\n\n${opts.retryHint}`
    : baseUserPrompt;

  const response = await client.messages.create({
    model: opts.config.model,
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

/**
 * Per-candidate token-count breakdown for `code2wiki generate
 * --estimate-cost`. Returns system and user input tokens separately
 * because they're priced differently downstream (system has
 * cache_control: ephemeral in extractWithLLM, user does not), so the
 * cost helper applies the 50% cache discount only to systemTokens.
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
