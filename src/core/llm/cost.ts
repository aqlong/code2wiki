/**
 * Pure cost-estimation helper backing `code2wiki generate --estimate-cost`.
 *
 * Supports two pricing tiers:
 *   - Anthropic (default): Input $3/MTok, Output $15/MTok, 50% cache discount
 *     on system tokens (matches client.ts cache_control layout).
 *   - DeepSeek:          Input $0.27/MTok, Output $1.10/MTok, no cache discount.
 *
 * Azure OpenAI is NOT supported here (no non-billed token-count endpoint),
 * so countTokens throws before this function is reached on the Azure path.
 *
 * Pure function so the unit tests can hand-compute expected values
 * without mocking the SDK.
 */

import type { LLMBackend } from "./client.js";

export const ANTHROPIC_INPUT_RATE_PER_TOKEN = 3 / 1_000_000;
export const ANTHROPIC_OUTPUT_RATE_PER_TOKEN = 15 / 1_000_000;
export const DEEPSEEK_INPUT_RATE_PER_TOKEN = 0.27 / 1_000_000;
export const DEEPSEEK_OUTPUT_RATE_PER_TOKEN = 1.10 / 1_000_000;
export const CACHE_DISCOUNT_MULTIPLIER = 0.5;
export const DEFAULT_OUTPUT_TOKENS_PER_PAGE = 3000;

// Backward-compat aliases for existing consumers.
export const INPUT_RATE_PER_TOKEN = ANTHROPIC_INPUT_RATE_PER_TOKEN;
export const OUTPUT_RATE_PER_TOKEN = ANTHROPIC_OUTPUT_RATE_PER_TOKEN;

export interface PerCandidateTokens {
  systemTokens: number;
  userTokens: number;
}

export interface CostEstimate {
  pages: number;
  totalSystemInputTokens: number;
  totalUserInputTokens: number;
  estimatedOutputTokens: number;
  cachedInputCostUsd: number;
  uncachedInputCostUsd: number;
  outputCostUsd: number;
  totalUsd: number;
}

export interface EstimateOptions {
  /** Tokens per page projected for output. Default 3000 (the spec). */
  outputTokensPerPage?: number;
  /** LLM backend for pricing. Defaults to "anthropic" rates. */
  backend?: LLMBackend;
}

export function computeEstimate(
  perCandidate: PerCandidateTokens[],
  options: EstimateOptions = {},
): CostEstimate {
  const isDeepSeek = options.backend === "deepseek";
  const inputRate = isDeepSeek ? DEEPSEEK_INPUT_RATE_PER_TOKEN : ANTHROPIC_INPUT_RATE_PER_TOKEN;
  const outputRate = isDeepSeek ? DEEPSEEK_OUTPUT_RATE_PER_TOKEN : ANTHROPIC_OUTPUT_RATE_PER_TOKEN;

  const outputTokensPerPage =
    options.outputTokensPerPage ?? DEFAULT_OUTPUT_TOKENS_PER_PAGE;
  const pages = perCandidate.length;
  const totalSystemInputTokens = perCandidate.reduce(
    (s, c) => s + c.systemTokens,
    0,
  );
  const totalUserInputTokens = perCandidate.reduce(
    (s, c) => s + c.userTokens,
    0,
  );
  const estimatedOutputTokens = pages * outputTokensPerPage;
  // DeepSeek has no prompt caching; Anthropic applies a 50% cache discount to system tokens.
  const cacheDiscount = isDeepSeek ? 1 : CACHE_DISCOUNT_MULTIPLIER;
  const cachedInputCostUsd =
    totalSystemInputTokens * inputRate * cacheDiscount;
  const uncachedInputCostUsd = totalUserInputTokens * inputRate;
  const outputCostUsd = estimatedOutputTokens * outputRate;
  const totalUsd =
    cachedInputCostUsd + uncachedInputCostUsd + outputCostUsd;

  return {
    pages,
    totalSystemInputTokens,
    totalUserInputTokens,
    estimatedOutputTokens,
    cachedInputCostUsd,
    uncachedInputCostUsd,
    outputCostUsd,
    totalUsd,
  };
}
