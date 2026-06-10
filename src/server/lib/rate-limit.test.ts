import { describe, test, expect, vi, beforeEach } from "vitest";

// Must mock timers before importing, since the module sets up setInterval at load time
vi.useFakeTimers();

// Dynamic import to ensure timer mock is in place
const { checkRateLimit, peekRateLimit, refundRateLimit } = await import("./rate-limit");

describe("checkRateLimit", () => {
  beforeEach(() => {
    // Advance time far enough to expire any entries from previous tests
    vi.advanceTimersByTime(999999999);
  });

  test("allows first request", () => {
    const result = checkRateLimit("test-first", 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  test("allows requests up to the limit", () => {
    const key = "test-up-to-limit";
    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit(key, 5, 60000);
      expect(result.allowed).toBe(true);
    }
  });

  test("blocks requests beyond the limit", () => {
    const key = "test-beyond-limit";
    // Use up all 3 allowed
    for (let i = 0; i < 3; i++) {
      checkRateLimit(key, 3, 60000);
    }
    // 4th should be blocked
    const result = checkRateLimit(key, 3, 60000);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test("resets after window expires", () => {
    const key = "test-reset";
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

  test("different keys are independent", () => {
    const key1 = "test-key1";
    const key2 = "test-key2";

    // Exhaust key1
    for (let i = 0; i < 2; i++) {
      checkRateLimit(key1, 2, 60000);
    }
    expect(checkRateLimit(key1, 2, 60000).allowed).toBe(false);

    // key2 should still work
    expect(checkRateLimit(key2, 2, 60000).allowed).toBe(true);
  });

  test("peekRateLimit does not consume attempts", () => {
    const key = "test-peek";
    // Peek many times — none should count against the limit
    for (let i = 0; i < 10; i++) {
      expect(peekRateLimit(key, 2).allowed).toBe(true);
    }
    // Two real attempts still available
    expect(checkRateLimit(key, 2, 60000).allowed).toBe(true);
    expect(checkRateLimit(key, 2, 60000).allowed).toBe(true);
    expect(checkRateLimit(key, 2, 60000).allowed).toBe(false);
  });

  test("peekRateLimit reports exhausted budget without consuming", () => {
    const key = "test-peek-exhausted";
    checkRateLimit(key, 1, 60000);
    const peeked = peekRateLimit(key, 1);
    expect(peeked.allowed).toBe(false);
    expect(peeked.retryAfterMs).toBeGreaterThan(0);
    // Window expiry restores budget
    vi.advanceTimersByTime(60001);
    expect(peekRateLimit(key, 1).allowed).toBe(true);
  });

  test("refundRateLimit returns a consumed attempt", () => {
    const key = "test-refund";
    checkRateLimit(key, 1, 60000);
    expect(checkRateLimit(key, 1, 60000).allowed).toBe(false);
    refundRateLimit(key);
    expect(checkRateLimit(key, 1, 60000).allowed).toBe(true);
  });

  test("refundRateLimit is a no-op on unknown or empty keys", () => {
    refundRateLimit("test-refund-unknown");
    const key = "test-refund-empty";
    checkRateLimit(key, 5, 60000);
    refundRateLimit(key);
    refundRateLimit(key); // second refund must not go below zero
    expect(checkRateLimit(key, 1, 60000).allowed).toBe(true);
  });

  test("retryAfterMs decreases as time passes", () => {
    const key = "test-retry-after";
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
