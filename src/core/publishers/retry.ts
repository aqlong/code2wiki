/**
 * 429-retry wrapper for the Confluence + Notion publisher fetch paths.
 *
 * Wraps a `fetch`-shaped function so that any 429 response is retried
 * with exponential backoff + full jitter, capped at `capDelayMs`
 * (default 60s). All other responses (2xx, 3xx, 4xx-other, 5xx) pass
 * through unchanged on the first try, this layer's contract is
 * narrow: 429 only. Other classes of failure (network errors, 5xx)
 * have non-idempotent retry semantics for the create/update endpoints
 * we hit, so we let the caller see them rather than risk duplicating
 * pages.
 *
 * Backoff formula (full jitter, per the AWS guidance Anthropic + most
 * cloud APIs follow): each attempt's delay is uniformly random in
 * [0, min(baseDelayMs * 2^attempt, capDelayMs)]. Honours the
 * Retry-After response header when present (Atlassian + Notion both
 * set it; numeric seconds OR HTTP-date are both spec-legal).
 *
 * Pure, dependency-free, all I/O concerns (jitter, sleep) are
 * injectable so tests can drive deterministic timing without sleeping.
 */

export interface RetryOptions {
  /** Default 5. Total attempts including the first call (so up to 4
   *  retries). A regression past this means the upstream is broken;
   *  letting the caller see the 429 lets it surface a real error. */
  maxAttempts?: number;
  /** Base for exponential backoff, default 500ms. Attempt n's
   *  un-capped ceiling is baseDelayMs * 2^n. */
  baseDelayMs?: number;
  /** Per-attempt cap on the random-delay range, default 60_000ms.
   *  Atlassian's documented worst-case Retry-After is ~60s; Notion's
   *  is similar. Cap matches the upstream's stated worst case. */
  capDelayMs?: number;
  /** Returns a number in [0, 1). Override for deterministic tests. */
  jitter?: () => number;
  /** Sleep helper. Override for tests so the suite doesn't actually
   *  block; the production default is a setTimeout-based promise. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_OPTS: Required<RetryOptions> = {
  maxAttempts: 5,
  baseDelayMs: 500,
  capDelayMs: 60_000,
  jitter: Math.random,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Wrap a fetch implementation so 429s retry with backoff. Returns a
 * new function with the same signature; existing call sites need no
 * changes other than wrapping the fetch they hand the publisher.
 */
export function withRetry(
  baseFetch: typeof fetch,
  options: RetryOptions = {},
): typeof fetch {
  const opts = { ...DEFAULT_OPTS, ...options };

  const wrapped: typeof fetch = async (input, init) => {
    let lastRes: Response | null = null;
    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
      const res = await baseFetch(input, init);
      if (res.status !== 429) return res;
      lastRes = res;
      // If this was the final allowed attempt, return the 429 to the
      // caller, the caller's existing error path treats it as a
      // hard failure (which it now is).
      if (attempt === opts.maxAttempts - 1) return res;
      const delayMs = computeDelayMs(res, attempt, opts);
      await opts.sleep(delayMs);
    }
    // Unreachable in practice (loop returns on every iteration), but
    // TypeScript needs a terminal path.
    return lastRes as Response;
  };
  return wrapped;
}

/**
 * Resolve the delay before the next attempt. Honours Retry-After when
 * the header is present and parseable; falls back to exponential
 * backoff with full jitter, capped at opts.capDelayMs.
 *
 * Exported for unit testing the boundary cases (Retry-After parsing,
 * jitter-bound math) without exercising the network path.
 */
export function computeDelayMs(
  res: Response,
  attempt: number,
  opts: Required<RetryOptions>,
): number {
  const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
  if (retryAfter !== null) {
    // Respect the server's instruction, but never exceed the cap, a
    // misconfigured upstream sending Retry-After: 86400 shouldn't be
    // able to wedge a run for a day.
    return Math.min(retryAfter, opts.capDelayMs);
  }
  // Exponential backoff with full jitter: delay = rand(0, min(base * 2^n, cap)).
  // Attempt 0 -> base * 1, attempt 1 -> base * 2, etc. (clamped at cap).
  const exponentialCeiling = Math.min(
    opts.baseDelayMs * Math.pow(2, attempt),
    opts.capDelayMs,
  );
  return Math.floor(opts.jitter() * exponentialCeiling);
}

/**
 * Parse the Retry-After response header per RFC 7231: either an
 * integer-second delta OR an HTTP-date. Returns the delay in ms, or
 * null if the header is absent / unparseable.
 *
 * Negative or NaN values resolve to null so a malformed header
 * doesn't underflow into "retry immediately".
 */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Numeric form: seconds delta.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return seconds * 1000;
  }
  // HTTP-date form (e.g. "Wed, 21 Oct 2025 07:28:00 GMT").
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - Date.now();
  if (delta < 0) return null;
  return delta;
}
