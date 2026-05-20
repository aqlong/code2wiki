import { describe, it, expect, vi } from "vitest";
import { withRetry, computeDelayMs, parseRetryAfter } from "./retry.js";

/**
 * Pins the 429-backoff wrapper that ConfluencePublisher + NotionPublisher
 * apply to their fetchImpl in the constructor. Three load-bearing
 * surfaces:
 *
 *   1. NON-429 responses pass through on the FIRST attempt with no
 *      delay. A regression that retried 5xx (or any 4xx other than
 *      429) would double-publish on idempotency-fragile endpoints
 *      (Confluence create returns 409 on duplicate title; Notion
 *      4xx-other usually means a permanent client bug, retrying
 *      hammers the API for nothing).
 *
 *   2. 429 retries respect Retry-After when present, fall back to
 *      exponential backoff with full jitter otherwise. Cap at 60s
 *      regardless. A regression dropping the cap would let a
 *      misconfigured upstream sending "Retry-After: 86400" wedge a
 *      run for a day.
 *
 *   3. After maxAttempts the final 429 is returned to the caller,
 *      NOT swallowed. The caller's existing error path (which
 *      already handles non-2xx) takes over from there.
 *
 * Injected `sleep` + `jitter` keep the tests deterministic and
 * instant; no actual setTimeout sleeps happen.
 */

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response("", { status, headers });
}

function trackedSleep(): {
  fn: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  const fn = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { fn, delays };
}

describe("withRetry: pass-through on non-429 responses", () => {
  it("returns a 200 response on the first call with no sleep", async () => {
    const sleep = trackedSleep();
    const base = vi.fn().mockResolvedValue(res(200));
    const wrapped = withRetry(base, { sleep: sleep.fn });
    const out = await wrapped("https://x.example/page");
    expect(out.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(1);
    expect(sleep.delays).toEqual([]);
  });

  it.each([400, 401, 403, 404, 409, 500, 502, 503, 504])(
    "does NOT retry on status %d (only 429 retries)",
    async (status) => {
      const sleep = trackedSleep();
      const base = vi.fn().mockResolvedValue(res(status));
      const wrapped = withRetry(base, { sleep: sleep.fn });
      const out = await wrapped("https://x.example/page");
      expect(out.status).toBe(status);
      expect(base).toHaveBeenCalledTimes(1);
      expect(sleep.delays).toEqual([]);
    },
  );
});

describe("withRetry: 429 path", () => {
  it("retries on 429 then succeeds on the second attempt", async () => {
    const sleep = trackedSleep();
    const base = vi
      .fn()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200));
    const wrapped = withRetry(base, {
      sleep: sleep.fn,
      jitter: () => 0.5,
      baseDelayMs: 1000,
    });
    const out = await wrapped("https://x.example/page");
    expect(out.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    // Attempt 0 ceiling = 1000ms * 2^0 = 1000ms; jitter 0.5 -> 500ms.
    expect(sleep.delays).toEqual([500]);
  });

  it("honours numeric Retry-After (seconds) over exponential backoff", async () => {
    const sleep = trackedSleep();
    const base = vi
      .fn()
      .mockResolvedValueOnce(res(429, { "Retry-After": "3" }))
      .mockResolvedValueOnce(res(200));
    const wrapped = withRetry(base, {
      sleep: sleep.fn,
      // jitter intentionally high; Retry-After should win and ignore it.
      jitter: () => 0.99,
      baseDelayMs: 100,
    });
    const out = await wrapped("https://x.example/page");
    expect(out.status).toBe(200);
    expect(sleep.delays).toEqual([3000]);
  });

  it("caps Retry-After at capDelayMs (defends against misconfigured upstreams)", async () => {
    const sleep = trackedSleep();
    const base = vi
      .fn()
      // Retry-After: 86400 seconds = 1 day.
      .mockResolvedValueOnce(res(429, { "Retry-After": "86400" }))
      .mockResolvedValueOnce(res(200));
    const wrapped = withRetry(base, {
      sleep: sleep.fn,
      capDelayMs: 60_000,
    });
    const out = await wrapped("https://x.example/page");
    expect(out.status).toBe(200);
    // Cap fires: 60s instead of the upstream's requested 24h.
    expect(sleep.delays).toEqual([60_000]);
  });

  it("returns the final 429 after maxAttempts exhaustion (does NOT throw)", async () => {
    const sleep = trackedSleep();
    const base = vi.fn().mockResolvedValue(res(429));
    const wrapped = withRetry(base, {
      sleep: sleep.fn,
      jitter: () => 0,
      maxAttempts: 3,
      baseDelayMs: 100,
    });
    const out = await wrapped("https://x.example/page");
    // The final 429 surfaces; the caller's existing non-2xx path
    // (e.g. confluence.ts `if (!res.ok) throw ...`) handles it.
    expect(out.status).toBe(429);
    expect(base).toHaveBeenCalledTimes(3);
    // Sleeps fire BETWEEN attempts: 3 attempts = 2 sleeps.
    expect(sleep.delays).toHaveLength(2);
  });

  it("respects maxAttempts=1 (no retries at all)", async () => {
    const sleep = trackedSleep();
    const base = vi.fn().mockResolvedValue(res(429));
    const wrapped = withRetry(base, {
      sleep: sleep.fn,
      maxAttempts: 1,
    });
    const out = await wrapped("https://x.example/page");
    expect(out.status).toBe(429);
    expect(base).toHaveBeenCalledTimes(1);
    expect(sleep.delays).toEqual([]);
  });
});

describe("computeDelayMs: exponential backoff math (no network)", () => {
  const opts = {
    maxAttempts: 5,
    baseDelayMs: 500,
    capDelayMs: 60_000,
    jitter: () => 0.5,
    sleep: async () => {},
  };

  it("doubles the ceiling per attempt before applying jitter", () => {
    // Attempt 0: base * 2^0 = 500, jitter 0.5 -> 250.
    expect(computeDelayMs(res(429), 0, opts)).toBe(250);
    // Attempt 1: base * 2^1 = 1000, jitter 0.5 -> 500.
    expect(computeDelayMs(res(429), 1, opts)).toBe(500);
    // Attempt 4: base * 2^4 = 8000, jitter 0.5 -> 4000.
    expect(computeDelayMs(res(429), 4, opts)).toBe(4000);
  });

  it("clamps the ceiling at capDelayMs even when 2^n would exceed it", () => {
    // base 500 * 2^10 = 512_000; capped at 60_000; jitter 0.5 -> 30_000.
    expect(computeDelayMs(res(429), 10, opts)).toBe(30_000);
  });

  it("returns 0 when jitter returns 0 (no random delay floor)", () => {
    expect(
      computeDelayMs(res(429), 3, { ...opts, jitter: () => 0 }),
    ).toBe(0);
  });
});

describe("parseRetryAfter", () => {
  it("returns null for absent / empty header", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("   ")).toBeNull();
  });

  it("parses numeric seconds delta into ms", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(" 0 ")).toBe(0);
    expect(parseRetryAfter("60")).toBe(60_000);
  });

  it("returns null for malformed numeric forms (negative, decimal, alpha)", () => {
    expect(parseRetryAfter("-1")).toBeNull();
    // Decimals don't match the integer regex AND don't parse as Date.
    expect(parseRetryAfter("1.5")).toBeNull();
    expect(parseRetryAfter("not-a-number")).toBeNull();
  });

  it("parses HTTP-date form and returns positive delta from now", () => {
    const futureMs = Date.now() + 5000;
    const httpDate = new Date(futureMs).toUTCString();
    const parsed = parseRetryAfter(httpDate);
    expect(parsed).not.toBeNull();
    // Allow a small tolerance for the clock drift between writing the
    // header and parsing it (typically <50ms in the test runtime).
    expect(parsed).toBeGreaterThan(4000);
    expect(parsed).toBeLessThanOrEqual(5000);
  });

  it("returns null for past HTTP-dates (never schedule a negative delay)", () => {
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(pastDate)).toBeNull();
  });
});
