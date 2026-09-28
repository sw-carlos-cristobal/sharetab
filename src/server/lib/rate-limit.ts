const attempts = new Map<string, { count: number; resetAt: number }>();

/**
 * The most keys the limiter holds at once. A caller can mint keys (a made-up share token or
 * person token makes a new one on every request), and entries are otherwise only swept once a
 * minute after their window ends, so without a cap the map grows with the request rate (#208).
 * At the cap, a new key evicts the oldest window (usually already expired; the periodic sweep
 * below clears the rest). Evicting keeps new callers limited correctly; the cost is that a
 * client minting keys faster than the cap per window can reset the oldest callers' counters
 * early. Eviction takes the front of the map only, so a full map costs O(1) per new key rather
 * than a scan.
 */
export const MAX_RATE_LIMIT_KEYS = 50_000;

// Starts a new window for a key, making room first. Map iteration follows insertion order, so
// the key is deleted and re-added to put it at the back: the front is always the oldest window.
function startWindow(key: string, now: number, windowMs: number) {
  attempts.delete(key);
  while (attempts.size >= MAX_RATE_LIMIT_KEYS) {
    const oldest = attempts.keys().next();
    if (oldest.done) break;
    attempts.delete(oldest.value);
  }
  attempts.set(key, { count: 1, resetAt: now + windowMs });
}

/**
 * Parse a positive integer from an env value, falling back when unset or
 * invalid. Without this, a non-numeric value becomes NaN and every
 * `count >= NaN` comparison is false — silently disabling the limiter.
 */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return parsed > 0 ? parsed : fallback;
}

export function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number,
): { allowed: boolean; retryAfterMs: number } {
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

/**
 * Check whether a key has remaining budget WITHOUT consuming an attempt.
 * Use as a pre-gate when the real consumption must happen later (after
 * validation or after acquiring a mutex), so rejected requests don't burn
 * budget.
 */
export function peekRateLimit(key: string, maxAttempts: number): { allowed: boolean; retryAfterMs: number } {
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

/**
 * Return one previously consumed attempt to a key's budget. Use to undo a
 * consumption when the guarded operation could not proceed (e.g. a mutex
 * CONFLICT), so the caller's quota isn't burned by a no-op request.
 */
export function refundRateLimit(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (entry && now <= entry.resetAt && entry.count > 0) {
    entry.count--;
  }
}

// Cleanup stale entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now > entry.resetAt) attempts.delete(key);
  }
}, 60000);
