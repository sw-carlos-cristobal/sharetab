/**
 * Exchange rate fetcher using frankfurter.app (free, no API key, ECB data).
 * Caches rates in memory with a configurable TTL.
 */

const FRANKFURTER_BASE = "https://api.frankfurter.app";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type CacheEntry = {
  rate: number;
  fetchedAt: number;
};

// Cache key format: "FROM:TO:DATE" where DATE is YYYY-MM-DD or "latest"
const rateCache = new Map<string, CacheEntry>();

function cacheKey(from: string, to: string, date?: string): string {
  return `${from}:${to}:${date ?? "latest"}`;
}

/**
 * Fetch the exchange rate for converting `from` currency to `to` currency.
 *
 * @param from - ISO 4217 currency code (e.g., "EUR")
 * @param to - ISO 4217 currency code (e.g., "USD")
 * @param date - Optional YYYY-MM-DD date for historical rate. Omit for latest.
 * @returns The exchange rate (1 unit of `from` = rate units of `to`), or null if fetch fails.
 */
export async function getExchangeRate(
  from: string,
  to: string,
  date?: string
): Promise<number | null> {
  // Same currency = 1:1
  if (from.toUpperCase() === to.toUpperCase()) {
    return 1.0;
  }

  const key = cacheKey(from.toUpperCase(), to.toUpperCase(), date);

  // Check cache
  const cached = rateCache.get(key);
  if (cached) {
    if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.rate;
    }
    rateCache.delete(key);
  }

  try {
    const endpoint = date ? `${FRANKFURTER_BASE}/${date}` : `${FRANKFURTER_BASE}/latest`;
    const url = `${endpoint}?from=${encodeURIComponent(from.toUpperCase())}&to=${encodeURIComponent(to.toUpperCase())}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!response.ok) {
      console.error(`[exchange-rates] Frankfurter API returned ${response.status} for ${key}`);
      return null;
    }

    const data = (await response.json()) as {
      rates: Record<string, number>;
    };

    const rate = data.rates[to.toUpperCase()];
    if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) {
      console.error(`[exchange-rates] Invalid rate for ${key}:`, data);
      return null;
    }

    // Cache the result
    rateCache.set(key, { rate, fetchedAt: Date.now() });

    return rate;
  } catch (error) {
    console.error(`[exchange-rates] Failed to fetch rate for ${key}:`, error);
    return null;
  }
}

/**
 * Convert an amount in cents from one currency to another.
 *
 * @param amountCents - Amount in cents in the source currency
 * @param exchangeRate - The exchange rate (1 unit source = rate units target)
 * @returns Amount in cents in the target currency, rounded to nearest cent
 */
export function convertCents(amountCents: number, exchangeRate: number): number {
  return Math.round(amountCents * exchangeRate);
}

/**
 * Clear the rate cache. Useful for testing.
 */
export function clearRateCache(): void {
  rateCache.clear();
}
