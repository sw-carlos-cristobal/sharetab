import { describe, test, expect, vi, beforeEach } from 'vitest';

// Must mock timers before importing, since the module sets up setInterval at load time
vi.useFakeTimers();

// Dynamic import to ensure timer mock is in place
const {
  checkRateLimit,
  peekRateLimit,
  refundRateLimit,
  parsePositiveInt,
  MAX_RATE_LIMIT_KEYS,
  checkTokenRateLimit,
  peekTokenRateLimit,
} = await import('./rate-limit');

describe('parsePositiveInt', () => {
  test('parses a valid positive integer', () => {
    expect(parsePositiveInt('30', 5)).toBe(30);
  });

  test('falls back when undefined', () => {
    expect(parsePositiveInt(undefined, 5)).toBe(5);
  });

  test('falls back on non-numeric input instead of returning NaN', () => {
    expect(parsePositiveInt('unlimited', 5)).toBe(5);
  });

  test('falls back on empty string', () => {
    expect(parsePositiveInt('', 5)).toBe(5);
  });

  test('falls back on zero and negative values', () => {
    expect(parsePositiveInt('0', 5)).toBe(5);
    expect(parsePositiveInt('-10', 5)).toBe(5);
  });
});

describe('checkRateLimit', () => {
  beforeEach(() => {
    // Advance time far enough to expire any entries from previous tests
    vi.advanceTimersByTime(999999999);
  });

  test('allows first request', () => {
    const result = checkRateLimit('test-first', 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  test('allows requests up to the limit', () => {
    const key = 'test-up-to-limit';
    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit(key, 5, 60000);
      expect(result.allowed).toBe(true);
    }
  });

  test('blocks requests beyond the limit', () => {
    const key = 'test-beyond-limit';
    // Use up all 3 allowed
    for (let i = 0; i < 3; i++) {
      checkRateLimit(key, 3, 60000);
    }
    // 4th should be blocked
    const result = checkRateLimit(key, 3, 60000);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test('resets after window expires', () => {
    const key = 'test-reset';
    // Use up the limit
    for (let i = 0; i < 3; i++) {
      checkRateLimit(key, 3, 60000);
    }
    expect(checkRateLimit(key, 3, 60000).allowed).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(60001);

    // Should be allowed again
    const result = checkRateLimit(key, 3, 60000);
    expect(result.allowed).toBe(true);
  });

  test('different keys are independent', () => {
    const key1 = 'test-key1';
    const key2 = 'test-key2';

    // Exhaust key1
    for (let i = 0; i < 2; i++) {
      checkRateLimit(key1, 2, 60000);
    }
    expect(checkRateLimit(key1, 2, 60000).allowed).toBe(false);

    // key2 should still work
    expect(checkRateLimit(key2, 2, 60000).allowed).toBe(true);
  });

  test('peekRateLimit does not consume attempts', () => {
    const key = 'test-peek';
    // Peek many times — none should count against the limit
    for (let i = 0; i < 10; i++) {
      expect(peekRateLimit(key, 2).allowed).toBe(true);
    }
    // Two real attempts still available
    expect(checkRateLimit(key, 2, 60000).allowed).toBe(true);
    expect(checkRateLimit(key, 2, 60000).allowed).toBe(true);
    expect(checkRateLimit(key, 2, 60000).allowed).toBe(false);
  });

  test('peekRateLimit reports exhausted budget without consuming', () => {
    const key = 'test-peek-exhausted';
    checkRateLimit(key, 1, 60000);
    const peeked = peekRateLimit(key, 1);
    expect(peeked.allowed).toBe(false);
    expect(peeked.retryAfterMs).toBeGreaterThan(0);
    // Window expiry restores budget
    vi.advanceTimersByTime(60001);
    expect(peekRateLimit(key, 1).allowed).toBe(true);
  });

  test('refundRateLimit returns a consumed attempt', () => {
    const key = 'test-refund';
    checkRateLimit(key, 1, 60000);
    expect(checkRateLimit(key, 1, 60000).allowed).toBe(false);
    refundRateLimit(key);
    expect(checkRateLimit(key, 1, 60000).allowed).toBe(true);
  });

  test('refundRateLimit is a no-op on unknown or empty keys', () => {
    refundRateLimit('test-refund-unknown');
    const key = 'test-refund-empty';
    checkRateLimit(key, 5, 60000);
    refundRateLimit(key);
    refundRateLimit(key); // second refund must not go below zero
    expect(checkRateLimit(key, 1, 60000).allowed).toBe(true);
  });

  test('retryAfterMs decreases as time passes', () => {
    const key = 'test-retry-after';
    checkRateLimit(key, 1, 10000);
    const blocked = checkRateLimit(key, 1, 10000);
    expect(blocked.allowed).toBe(false);
    const firstRetry = blocked.retryAfterMs;

    vi.advanceTimersByTime(5000);

    const stillBlocked = checkRateLimit(key, 1, 10000);
    expect(stillBlocked.allowed).toBe(false);
    expect(stillBlocked.retryAfterMs).toBeLessThan(firstRetry);
  });
});

describe('the token store: keys built from client-sent tokens (#208)', () => {
  beforeEach(() => {
    vi.advanceTimersByTime(999999999);
  });

  // Fills the limiter with `count` new one-attempt keys
  function fill(prefix: string, count: number) {
    for (let i = 0; i < count; i++) checkTokenRateLimit(`${prefix}-${i}`, 1, 60000);
  }

  test('holds up to the cap', () => {
    fill('cap', MAX_RATE_LIMIT_KEYS);
    // Every key is still spent
    expect(checkTokenRateLimit('cap-0', 1, 60000).allowed).toBe(false);
    expect(checkTokenRateLimit(`cap-${MAX_RATE_LIMIT_KEYS - 1}`, 1, 60000).allowed).toBe(false);
  });

  test('a new key past the cap evicts the oldest window, not the newest', () => {
    fill('evict', MAX_RATE_LIMIT_KEYS);
    checkTokenRateLimit('evict-new', 1, 60000);
    // The oldest key was dropped, so it starts over; the newest are still spent
    expect(checkTokenRateLimit('evict-0', 1, 60000).allowed).toBe(true);
    expect(checkTokenRateLimit('evict-new', 1, 60000).allowed).toBe(false);
    expect(checkTokenRateLimit(`evict-${MAX_RATE_LIMIT_KEYS - 1}`, 1, 60000).allowed).toBe(false);
  });

  test('evicts the oldest windows first (here expired ones), keeping newer live ones', () => {
    // Half the cap in short windows that expire, then the rest in long ones
    for (let i = 0; i < MAX_RATE_LIMIT_KEYS / 2; i++) checkTokenRateLimit(`short-${i}`, 1, 1000);
    for (let i = 0; i < MAX_RATE_LIMIT_KEYS / 2; i++) checkTokenRateLimit(`long-${i}`, 1, 600000);
    vi.advanceTimersByTime(2000);
    checkTokenRateLimit('after-expiry', 1, 60000);
    // The first long window is still there: the expired short ones made the room
    expect(checkTokenRateLimit('long-0', 1, 600000).allowed).toBe(false);
  });

  test('a key whose window resets moves to the back of the eviction order', () => {
    checkTokenRateLimit('renewed', 1, 1000);
    vi.advanceTimersByTime(2000);
    // Its window resets now, after the others below would have been added
    fill('others', MAX_RATE_LIMIT_KEYS - 1);
    checkTokenRateLimit('renewed', 1, 60000);
    checkTokenRateLimit('one-more', 1, 60000);
    // The oldest window is others-0, not the renewed key
    expect(checkTokenRateLimit('renewed', 1, 60000).allowed).toBe(false);
    expect(checkTokenRateLimit('others-0', 1, 60000).allowed).toBe(true);
  });

  test('peekTokenRateLimit reads the token store without spending', () => {
    checkTokenRateLimit('peeked', 1, 60000);
    expect(peekTokenRateLimit('peeked', 1).allowed).toBe(false);
    expect(peekTokenRateLimit('never-seen', 1).allowed).toBe(true);
  });

  test("flooding it doesn't evict login, per-IP or global counters in the main store", () => {
    checkRateLimit('login-ip:203.0.113.9', 1, 15 * 60000);
    checkRateLimit('login:alice@example.com', 1, 15 * 60000);
    checkRateLimit('guest-process-global', 1, 60 * 60000);
    fill('flood', MAX_RATE_LIMIT_KEYS + 10);
    expect(checkRateLimit('login-ip:203.0.113.9', 1, 15 * 60000).allowed).toBe(false);
    expect(checkRateLimit('login:alice@example.com', 1, 15 * 60000).allowed).toBe(false);
    expect(checkRateLimit('guest-process-global', 1, 60 * 60000).allowed).toBe(false);
  });
});
