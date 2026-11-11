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

/**
 * Currencies with no minor unit in use (#335): those Intl shows with no decimals under CLDR 48
 * (ICU 78.3, which Node 22 and Node 26 both ship). Kept here rather than asked of Intl at run
 * time, since browsers and servers ship other ICU versions, whose currency data can differ (#335
 * was filed listing six of ShareTab's currencies as having no decimals; ICU 78.3 also counts
 * COP), and the server refuses an expense or payment amount in one of these that isn't whole
 * (except a payment that pays off a debt exactly): the page and the server must agree on which
 * they are. `money.test.ts` compares the list with the runtime's.
 */
const ZERO_DECIMAL_CODES =
  'AFN ALL BIF CLP COP DJF GNF HUF IDR IQD IRR ISK JPY KMF KPW KRW LAK LBP MGA MMK PKR PYG RWF SLL SOS SYP UGX VND VUV XAF XOF XPF YER';
const ZERO_DECIMAL_CURRENCIES = new Set(ZERO_DECIMAL_CODES.split(' '));

/**
 * The smallest amount of `currency` in the hundredths every amount is stored in (#335): 100 for a
 * currency with no decimals (¥1 is 100), 1 for any other. Amounts in a currency with no decimals
 * are entered (`parseToCents`), checked by the server for an expense, a receipt expense's total or
 * a payment, split (`allocateProportionally`) and converted into (`convertAmount`) in steps of
 * this size.
 */
export function currencyStep(currency?: string | null): 1 | 100 {
  return currency && ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 100 : 1;
}

/** The decimals an amount in `currency` is shown and entered with: none, or two */
function currencyDecimals(currency: string): 0 | 2 {
  return currencyStep(currency) === 100 ? 0 : 2;
}

export function formatCents(cents: number, currency = 'USD', locale: string = defaultLocale): string {
  // The decimals follow currencyStep rather than Intl's data for the currency, so what is shown
  // is what can be entered and saved, whichever ICU the browser has (#335)
  const decimals = currencyDecimals(currency);
  return new Intl.NumberFormat(moneyLocales[locale] ?? locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(cents / 100);
}

/**
 * An amount as typed ("12.99", "1,000") in hundredths, or 0 when it isn't a number. With a
 * `currency` that has no decimals, an amount with a fraction ("1000.50" yen) counts as not a number
 * too (#335). Digits past the second decimal are dropped.
 */
export function parseToCents(value: string, currency?: string): number {
  const cents = parseHundredths(value);
  return currency === undefined || cents % currencyStep(currency) === 0 ? cents : 0;
}

function parseHundredths(value: string): number {
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

/** An amount as an input field takes it: "12.99", or "333" in a currency with no decimals (#335) */
export function centsToDecimal(cents: number, currency = 'USD'): string {
  return (cents / 100).toFixed(currencyDecimals(currency));
}

/** The `step`, and smallest `min`, of a number input for an amount in `currency`: "0.01", or "1" (#335) */
export function amountInputStep(currency?: string): string {
  return centsToDecimal(currencyStep(currency), currency);
}

/**
 * `amount` converted at `exchangeRate` (1 unit of its currency is that many of `currency`'s),
 * rounded to the nearest hundredth, or whole unit when `currency` has no decimals (#335). The
 * server stores this as an expense's or payment's amount in the group's currency.
 */
export function convertAmount(amount: number, exchangeRate: number, currency: string): number {
  const step = currencyStep(currency);
  return Math.round((amount * exchangeRate) / step) * step;
}

/**
 * Splits `amount` cents in proportion to `weights` (nonnegative) so the shares add up to `amount`
 * exactly and each is within a cent of its exact value (#331): each share is rounded down, and the
 * cents left over go to the largest remainders, earliest first on a tie, so the order of `weights`
 * decides only who gets a tied cent. A zero weight gets nothing. Weights that are all zero count as
 * equal. Rounding each share on its own, with the last taking what's left, could leave that last
 * share several cents off everyone else's, or below zero.
 *
 * With a `step` (`currencyStep`: 100 for a currency with no decimals, #335) the shares are whole
 * steps, each within a step of its exact value, the leftover steps handed out the same way. An
 * amount that isn't itself whole steps (one saved before #335, or a receipt item price the scan's
 * discount folding or an item split left with hundredths) has hundredths left below a step: those
 * are shared the same way on top, so the shares still add up to `amount`.
 *
 * `amount` and `weights` must be integers. The arithmetic is done in BigInt, since an amount times
 * a weight (an expense's share, when converting it) can pass 2^53, where a number can't hold the
 * exact remainder, so a tied or nearly tied cent would go by rounding noise rather than to the
 * larger remainder, or by order on a tie.
 */
export function allocateProportionally(amount: number, weights: number[], step = 1): number[] {
  if (step !== 1) {
    // The remainder takes the sign of amount, so steps and remainder share out the same way
    const belowStep = amount % step;
    const steps = allocateProportionally((amount - belowStep) / step, weights);
    const rest = allocateProportionally(belowStep, weights);
    return steps.map((share, i) => share * step + rest[i]!);
  }
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
