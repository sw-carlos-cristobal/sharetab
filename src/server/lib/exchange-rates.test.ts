import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { getExchangeRate, convertCents, clearRateCache } from "./exchange-rates";

describe("convertCents", () => {
  test("converts cents with exchange rate", () => {
    // 1000 cents USD * 0.92 EUR/USD = 920 cents EUR
    expect(convertCents(1000, 0.92)).toBe(920);
  });

  test("rounds to nearest cent", () => {
    // 1000 cents * 1.234 = 1234.0 (no rounding needed)
    expect(convertCents(1000, 1.234)).toBe(1234);
    // 999 cents * 1.234 = 1232.766 → 1233
    expect(convertCents(999, 1.234)).toBe(1233);
  });

  test("handles rate of 1.0 (same currency)", () => {
    expect(convertCents(5000, 1.0)).toBe(5000);
  });

  test("handles very small amounts", () => {
    expect(convertCents(1, 0.5)).toBe(1); // Math.round(0.5) = 1 in JS
  });

  test("handles zero", () => {
    expect(convertCents(0, 1.5)).toBe(0);
  });
});

describe("getExchangeRate", () => {
  beforeEach(() => {
    clearRateCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns 1.0 for same currency", async () => {
    const rate = await getExchangeRate("USD", "USD");
    expect(rate).toBe(1.0);
  });

  test("returns 1.0 for same currency (case insensitive)", async () => {
    const rate = await getExchangeRate("usd", "USD");
    expect(rate).toBe(1.0);
  });

  test("fetches rate from API successfully", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ rates: { EUR: 0.92 } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const rate = await getExchangeRate("USD", "EUR");
    expect(rate).toBe(0.92);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("from=USD&to=EUR");
  });

  test("uses cached rate on second call", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ rates: { EUR: 0.92 } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const rate1 = await getExchangeRate("USD", "EUR");
    const rate2 = await getExchangeRate("USD", "EUR");
    expect(rate1).toBe(0.92);
    expect(rate2).toBe(0.92);
    // Should only fetch once due to cache
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("uses date in URL for historical rates", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ rates: { GBP: 0.78 } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const rate = await getExchangeRate("USD", "GBP", "2025-01-15");
    expect(rate).toBe(0.78);
    expect(mockFetch.mock.calls[0][0]).toContain("2025-01-15");
  });

  test("returns null on API error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    });
    vi.stubGlobal("fetch", mockFetch);

    const rate = await getExchangeRate("USD", "EUR");
    expect(rate).toBeNull();
  });

  test("returns null on network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const rate = await getExchangeRate("USD", "EUR");
    expect(rate).toBeNull();
  });

  test("returns null for invalid rate data", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ rates: {} }), // missing target currency
    });
    vi.stubGlobal("fetch", mockFetch);

    const rate = await getExchangeRate("USD", "XYZ");
    expect(rate).toBeNull();
  });
});
