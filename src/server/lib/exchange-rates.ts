/**
 * Exchange rate fetcher using frankfurter.app (free, no API key, ECB data).
 * Caches rates in memory with a configurable TTL.
 */

import { z } from 'zod';
import { AppError } from './app-error';
import { MAX_MONEY_CENTS, convertAmount, currencyStep } from '@/lib/money';

/** A rate entered by hand (1 unit of the expense's currency = rate units of the group's) */
export const exchangeRateSchema = z.number().positive().finite().max(1_000_000);

const FRANKFURTER_BASE = 'https://api.frankfurter.app';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type CacheEntry = {
  rate: number;
  fetchedAt: number;
};

// Cache key format: "FROM:TO:DATE" where DATE is YYYY-MM-DD or "latest"
const rateCache = new Map<string, CacheEntry>();

function cacheKey(from: string, to: string, date?: string): string {
  return `${from}:${to}:${date ?? 'latest'}`;
}

/**
 * Fetch the exchange rate for converting `from` currency to `to` currency.
 *
 * @param from - ISO 4217 currency code (e.g., "EUR")
 * @param to - ISO 4217 currency code (e.g., "USD")
 * @param date - Optional YYYY-MM-DD date for historical rate. Omit for latest.
 * @returns The exchange rate (1 unit of `from` = rate units of `to`), or null if fetch fails.
 */
export async function getExchangeRate(from: string, to: string, date?: string): Promise<number | null> {
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
    if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) {
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
 * @param currency - The target currency (the group's)
 * @returns Amount in cents in the target currency, rounded to the nearest cent, or to the nearest
 *   whole unit when the target currency has no decimals (#335)
 * @throws AppError if the converted amount exceeds the Int4 money column range
 */
export function convertCents(amountCents: number, exchangeRate: number, currency: string): number {
  const converted = convertAmount(amountCents, exchangeRate, currency);
  if (!Number.isFinite(converted) || Math.abs(converted) > MAX_MONEY_CENTS) {
    throw new AppError('BAD_REQUEST', 'convertedAmountTooLarge');
  }
  return converted;
}

/**
 * Refuse amounts that aren't whole units of `currency` when it has no decimals: ¥1,000.50, or
 * ¥1,000 shared as ¥333.34, ¥333.33 and ¥333.33 (#335). Amounts are stored in hundredths of any
 * currency, so the server is what keeps one like JPY in whole yen.
 */
export function requireWholeUnits(currency: string, amounts: number[]): void {
  const step = currencyStep(currency);
  if (amounts.some((amount) => amount % step !== 0)) {
    throw new AppError('BAD_REQUEST', 'amountNotWholeUnits', { currency });
  }
}

/**
 * Clear the rate cache. Useful for testing.
 */
export function clearRateCache(): void {
  rateCache.clear();
}
