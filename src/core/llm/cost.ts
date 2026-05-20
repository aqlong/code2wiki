/**
 * Pure cost-estimation helper backing `code2wiki generate --estimate-cost`.
 *
 * Pricing model (matches client.ts caching layout):
 *   - Input: $3/MTok base
 *   - Output: $15/MTok
 *   - System prompt has `cache_control: { type: "ephemeral" }` in
 *     extractWithLLM, so we apply a 50% discount to the system-token
 *     portion of input (per spec). The user prompt is NOT cached
 *     (per-candidate full source attachment differs every call), so
 *     it pays the full input rate.
 *
 * This intentionally simplifies Anthropic's real cache pricing (cache
 * write 1.25x, cache read 0.1x), the 50% blended discount is the spec's
 * chosen approximation; revisit if estimates drift materially from
 * actual bills.
 *
 * Pure function so the unit tests can hand-compute expected values
 * without mocking the SDK.
 */

export const INPUT_RATE_PER_TOKEN = 3 / 1_000_000;
export const OUTPUT_RATE_PER_TOKEN = 15 / 1_000_000;
export const CACHE_DISCOUNT_MULTIPLIER = 0.5;
export const DEFAULT_OUTPUT_TOKENS_PER_PAGE = 3000;

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
}

export function computeEstimate(
  perCandidate: PerCandidateTokens[],
  options: EstimateOptions = {},
): CostEstimate {
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
  const cachedInputCostUsd =
    totalSystemInputTokens * INPUT_RATE_PER_TOKEN * CACHE_DISCOUNT_MULTIPLIER;
  const uncachedInputCostUsd = totalUserInputTokens * INPUT_RATE_PER_TOKEN;
  const outputCostUsd = estimatedOutputTokens * OUTPUT_RATE_PER_TOKEN;
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
