const attempts = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
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
export function peekRateLimit(
  key: string,
  maxAttempts: number
): { allowed: boolean; retryAfterMs: number } {
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
