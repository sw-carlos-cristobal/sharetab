type RateLimitResult = { allowed: boolean; retryAfterMs: number };
type Entry = { count: number; resetAt: number };

/**
 * The most keys the token store (below) holds at once. Its keys are built from a share token,
 * person token or receipt id the client sends, before it is checked, so a caller can mint a new
 * key on every request; entries are otherwise only swept once a minute after their window ends,
 * so without a cap the map grows with the request rate (#208). At the cap, a new key evicts the
 * oldest window (usually already expired; the periodic sweep clears the rest). Evicting keeps
 * new callers limited; the cost is that a client minting keys faster than the cap per window
 * can reset the oldest per-token counters early. Eviction takes the front of the map only, so a
 * full map costs O(1) per new key rather than a scan.
 */
export const MAX_RATE_LIMIT_KEYS = 50_000;

/**
 * Two stores, so that flooding the capped one can't evict counters that guard something else:
 * - the main store (checkRateLimit / peekRateLimit / refundRateLimit) keeps login, registration,
 *   per-IP, per-user and global counters, and never evicts;
 * - the token store (checkTokenRateLimit / peekTokenRateLimit) keeps only counters keyed by a
 *   client-sent share token, person token or receipt id, and is capped at MAX_RATE_LIMIT_KEYS.
 */
function createStore(maxKeys: number) {
  const attempts = new Map<string, Entry>();

  // Starts a new window for a key, making room first. Map iteration follows insertion order,
  // so the key is deleted and re-added to put it at the back: the front is the oldest window.
  function startWindow(key: string, now: number, windowMs: number) {
    attempts.delete(key);
    while (attempts.size >= maxKeys) {
      const oldest = attempts.keys().next();
      if (oldest.done) break;
      attempts.delete(oldest.value);
    }
    attempts.set(key, { count: 1, resetAt: now + windowMs });
  }

  function check(key: string, maxAttempts: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    const entry = attempts.get(key);

    if (!entry || now > entry.resetAt) {
      startWindow(key, now, windowMs);
      return { allowed: true, retryAfterMs: 0 };
    }

    if (entry.count >= maxAttempts) {
      return { allowed: false, retryAfterMs: entry.resetAt - now };
    }

    entry.count++;
    return { allowed: true, retryAfterMs: 0 };
  }

  function peek(key: string, maxAttempts: number): RateLimitResult {
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || now > entry.resetAt) {
      return { allowed: true, retryAfterMs: 0 };
    }
    if (entry.count >= maxAttempts) {
      return { allowed: false, retryAfterMs: entry.resetAt - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  function refund(key: string): void {
    const now = Date.now();
    const entry = attempts.get(key);
    if (entry && now <= entry.resetAt && entry.count > 0) {
      entry.count--;
    }
  }

  function sweep(now: number) {
    for (const [key, entry] of attempts) {
      if (now > entry.resetAt) attempts.delete(key);
    }
  }

  return { check, peek, refund, sweep };
}

const mainStore = createStore(Infinity);
const tokenStore = createStore(MAX_RATE_LIMIT_KEYS);

/**
 * Parse a positive integer from an env value, falling back when unset or
 * invalid. Without this, a non-numeric value becomes NaN and every
 * `count >= NaN` comparison is false — silently disabling the limiter.
 */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return parsed > 0 ? parsed : fallback;
}

export function checkRateLimit(key: string, maxAttempts: number, windowMs: number): RateLimitResult {
  return mainStore.check(key, maxAttempts, windowMs);
}

/**
 * Check whether a key has remaining budget WITHOUT consuming an attempt.
 * Use as a pre-gate when the real consumption must happen later (after
 * validation or after acquiring a mutex), so rejected requests don't burn
 * budget.
 */
export function peekRateLimit(key: string, maxAttempts: number): RateLimitResult {
  return mainStore.peek(key, maxAttempts);
}

/**
 * Return one previously consumed attempt to a key's budget. Use to undo a
 * consumption when the guarded operation could not proceed (e.g. a mutex
 * CONFLICT), so the caller's quota isn't burned by a no-op request.
 */
export function refundRateLimit(key: string): void {
  mainStore.refund(key);
}

/**
 * checkRateLimit for a key built from a share token, person token or receipt id the client
 * sends, before it is checked: kept in the capped token store (see MAX_RATE_LIMIT_KEYS).
 */
export function checkTokenRateLimit(key: string, maxAttempts: number, windowMs: number): RateLimitResult {
  return tokenStore.check(key, maxAttempts, windowMs);
}

/** peekRateLimit for the token store (see checkTokenRateLimit). */
export function peekTokenRateLimit(key: string, maxAttempts: number): RateLimitResult {
  return tokenStore.peek(key, maxAttempts);
}

// Cleanup stale entries periodically
setInterval(() => {
  const now = Date.now();
  mainStore.sweep(now);
  tokenStore.sweep(now);
}, 60000);
