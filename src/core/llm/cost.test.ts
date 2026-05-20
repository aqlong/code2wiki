import { describe, it, expect } from "vitest";
import {
  computeEstimate,
  INPUT_RATE_PER_TOKEN,
  OUTPUT_RATE_PER_TOKEN,
  CACHE_DISCOUNT_MULTIPLIER,
  DEFAULT_OUTPUT_TOKENS_PER_PAGE,
} from "./cost.js";

/**
 * Direct unit-test coverage for the pure cost-estimation helper backing
 * `code2wiki generate --estimate-cost`. The end-to-end test in
 * cli/commands/generate.test.ts pins the AGGREGATE total only ($0.10
 * and $6.39 hand-computed); a regression that flipped one constant and
 * simultaneously compensated with another could pass those aggregates
 * while emitting per-bucket lies. These tests pin each surface
 * independently so a single broken constant points unambiguously at
 * itself:
 *
 *   1. CACHE_DISCOUNT_MULTIPLIER applies to systemTokens ONLY (never to
 *      userTokens). Pinned via a symmetric system-only vs user-only
 *      payload comparison; the cached bucket must reflect the discount,
 *      the uncached bucket must not.
 *   2. Per-bucket math (cachedInputCostUsd, uncachedInputCostUsd,
 *      outputCostUsd) pinned separately from totalUsd so a flipped
 *      constant surfaces in exactly one bucket.
 *   3. outputTokensPerPage override path. The default 3000 ships
 *      embedded in the spec; the override slot is the customer escape
 *      hatch if their pages skew shorter or longer. Untested in the
 *      integration test (which always uses the default).
 *   4. Empty input → all zeros. A regression dividing by pages anywhere
 *      would throw / NaN here.
 *   5. Summation across N candidates (not just N=2 from the integration
 *      test).
 *   6. Exported pricing constants pinned to their literal values. The
 *      docstring on cost.ts states the pricing model; a regression
 *      bumping a rate without updating the docs surfaces here.
 */

describe("computeEstimate: empty input", () => {
  it("returns all-zero estimate for empty candidate list", () => {
    const est = computeEstimate([]);
    expect(est.pages).toBe(0);
    expect(est.totalSystemInputTokens).toBe(0);
    expect(est.totalUserInputTokens).toBe(0);
    expect(est.estimatedOutputTokens).toBe(0);
    expect(est.cachedInputCostUsd).toBe(0);
    expect(est.uncachedInputCostUsd).toBe(0);
    expect(est.outputCostUsd).toBe(0);
    expect(est.totalUsd).toBe(0);
  });
});

describe("computeEstimate: per-bucket math (single candidate)", () => {
  it("pins cachedInputCostUsd to systemTokens × inputRate × cacheDiscount", () => {
    // 1000 system tokens, 0 user. Output bucket scales with pages so
    // we still get a non-zero outputCostUsd; assert ONLY the cached
    // bucket here.
    const est = computeEstimate([{ systemTokens: 1000, userTokens: 0 }]);
    // 1000 × ($3/1M) × 0.5 = $0.0015
    expect(est.cachedInputCostUsd).toBeCloseTo(0.0015, 10);
    expect(est.uncachedInputCostUsd).toBe(0);
  });

  it("pins uncachedInputCostUsd to userTokens × inputRate (NO cache discount)", () => {
    // 0 system tokens, 1000 user. Symmetric to the test above; the
    // uncached bucket must be exactly 2× what the same magnitude in
    // systemTokens yielded because the discount is 0.5. Defends against
    // a regression that applied the cache discount to userTokens too
    // (which would make uncached 0.0015, matching cached).
    const est = computeEstimate([{ systemTokens: 0, userTokens: 1000 }]);
    expect(est.uncachedInputCostUsd).toBeCloseTo(0.003, 10);
    expect(est.cachedInputCostUsd).toBe(0);
  });

  it("pins outputCostUsd to pages × DEFAULT_OUTPUT_TOKENS_PER_PAGE × outputRate", () => {
    // 0 system / 0 user → isolates the output bucket.
    const est = computeEstimate([{ systemTokens: 0, userTokens: 0 }]);
    // 1 page × 3000 tokens × ($15/1M) = $0.045
    expect(est.outputCostUsd).toBeCloseTo(0.045, 10);
    expect(est.estimatedOutputTokens).toBe(3000);
    expect(est.cachedInputCostUsd).toBe(0);
    expect(est.uncachedInputCostUsd).toBe(0);
  });
});

describe("computeEstimate: summation across N candidates", () => {
  it("sums systemTokens / userTokens correctly and scales output tokens by candidate count", () => {
    // Three distinct rows so a regression replacing reduce with [0]
    // or [last] surfaces as a wrong total.
    const est = computeEstimate([
      { systemTokens: 100, userTokens: 200 },
      { systemTokens: 300, userTokens: 400 },
      { systemTokens: 500, userTokens: 600 },
    ]);
    expect(est.pages).toBe(3);
    expect(est.totalSystemInputTokens).toBe(900);
    expect(est.totalUserInputTokens).toBe(1200);
    expect(est.estimatedOutputTokens).toBe(3 * 3000);
  });

  it("totalUsd equals the sum of the three cost buckets (invariant)", () => {
    const est = computeEstimate([
      { systemTokens: 1234, userTokens: 5678 },
      { systemTokens: 999, userTokens: 11_111 },
    ]);
    expect(est.totalUsd).toBeCloseTo(
      est.cachedInputCostUsd +
        est.uncachedInputCostUsd +
        est.outputCostUsd,
      10,
    );
  });
});

describe("computeEstimate: outputTokensPerPage override", () => {
  it("uses options.outputTokensPerPage instead of the default when provided", () => {
    const est = computeEstimate(
      [{ systemTokens: 0, userTokens: 0 }],
      { outputTokensPerPage: 1000 },
    );
    // 1 page × 1000 (override) × ($15/1M) = $0.015
    expect(est.estimatedOutputTokens).toBe(1000);
    expect(est.outputCostUsd).toBeCloseTo(0.015, 10);
  });

  it("falls back to DEFAULT_OUTPUT_TOKENS_PER_PAGE when option omitted", () => {
    const est = computeEstimate(
      [{ systemTokens: 0, userTokens: 0 }],
      {},
    );
    expect(est.estimatedOutputTokens).toBe(DEFAULT_OUTPUT_TOKENS_PER_PAGE);
  });
});

describe("exported pricing constants", () => {
  // The docstring on cost.ts states these literal values; a regression
  // bumping them without updating the docs (or vice versa) surfaces
  // here. Anthropic could change real pricing, in which case the bump
  // is intentional and both source + test get updated together.
  it("INPUT_RATE_PER_TOKEN is $3 per million tokens", () => {
    expect(INPUT_RATE_PER_TOKEN).toBe(3 / 1_000_000);
  });

  it("OUTPUT_RATE_PER_TOKEN is $15 per million tokens", () => {
    expect(OUTPUT_RATE_PER_TOKEN).toBe(15 / 1_000_000);
  });

  it("CACHE_DISCOUNT_MULTIPLIER is 0.5 (50% blended approximation)", () => {
    expect(CACHE_DISCOUNT_MULTIPLIER).toBe(0.5);
  });

  it("DEFAULT_OUTPUT_TOKENS_PER_PAGE is 3000", () => {
    expect(DEFAULT_OUTPUT_TOKENS_PER_PAGE).toBe(3000);
  });
});
