import { defaultLocale, type Locale } from '@/i18n/routing';

/** Maximum monetary value in cents — Postgres int4 max, the DB column type for all money fields. */
export const MAX_MONEY_CENTS = 2_147_483_647;

const moneyLocales: Record<string, string> = {
  en: 'en-US',
  es: 'es-ES',
  sv: 'sv-SE',
  fr: 'fr-FR',
  de: 'de-DE',
  'pt-BR': 'pt-BR',
  ja: 'ja-JP',
  'zh-CN': 'zh-CN',
  ko: 'ko-KR',
} satisfies Record<Locale, string>;

export function formatCents(cents: number, currency = 'USD', locale: string = defaultLocale): string {
  return new Intl.NumberFormat(moneyLocales[locale] ?? locale, {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

export function parseToCents(value: string): number {
  const trimmed = value.trim().replace(/,/g, '');
  if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) return 0;
  const negative = trimmed.startsWith('-');
  const abs = negative ? trimmed.slice(1) : trimmed;
  const dotIndex = abs.lastIndexOf('.');
  if (dotIndex === -1) return (parseInt(abs, 10) || 0) * 100 * (negative ? -1 : 1);
  const intPart = abs.slice(0, dotIndex) || '0';
  const fracPart = abs
    .slice(dotIndex + 1)
    .padEnd(2, '0')
    .slice(0, 2);
  const cents = (parseInt(intPart, 10) || 0) * 100 + parseInt(fracPart, 10);
  return cents * (negative ? -1 : 1);
}

export function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Splits `amount` cents in proportion to `weights` (nonnegative) so the shares add up to `amount`
 * exactly and each is within a cent of its exact value (#331): each share is rounded down, and the
 * cents left over go to the largest remainders, earliest first on a tie, so the order of `weights`
 * decides only who gets a tied cent. A zero weight gets nothing. Weights that are all zero count as
 * equal. Rounding each share on its own, with the last taking what's left, could leave that last
 * share several cents off everyone else's, or below zero.
 *
 * `amount` and `weights` must be integers. The arithmetic is done in BigInt, since an amount times
 * a weight (an expense's share, when converting it) can pass 2^53, where a number can't hold the
 * exact remainder, so a tied or nearly tied cent would go by rounding noise rather than to the
 * larger remainder, or by order on a tie.
 */
export function allocateProportionally(amount: number, weights: number[]): number[] {
  if (weights.length === 0) {
    if (amount !== 0) throw new RangeError(`No one to allocate ${amount} cents to`);
    return [];
  }
  const zero = BigInt(0);
  const one = BigInt(1);
  const cents = BigInt(Math.abs(amount));
  const anyWeight = weights.some((w) => w > 0);
  const parts = weights.map((w) => BigInt(anyWeight ? w : 1));
  const partTotal = parts.reduce((a, b) => a + b, zero);
  // Nonnegative BigInt division rounds down
  const shares = parts.map((w) => (cents * w) / partTotal);
  const remainders = parts.map((w, i) => ({ i, remainder: cents * w - shares[i]! * partTotal }));
  remainders.sort((a, b) => (a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1));
  let left = cents - shares.reduce((a, b) => a + b, zero);
  for (const { i } of remainders) {
    if (left <= zero) break;
    shares[i]! += one;
    left -= one;
  }
  return shares.map((share) => Number(amount < 0 ? -share : share));
}
