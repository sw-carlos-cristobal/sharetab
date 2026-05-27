/**
 * Common ISO 4217 currencies for the currency selector.
 * Ordered by global usage / relevance.
 */
export const COMMON_CURRENCIES = [
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "EUR", name: "Euro", symbol: "€" },
  { code: "GBP", name: "British Pound", symbol: "£" },
  { code: "JPY", name: "Japanese Yen", symbol: "¥" },
  { code: "CAD", name: "Canadian Dollar", symbol: "CA$" },
  { code: "AUD", name: "Australian Dollar", symbol: "A$" },
  { code: "CHF", name: "Swiss Franc", symbol: "CHF" },
  { code: "CNY", name: "Chinese Yuan", symbol: "¥" },
  { code: "SEK", name: "Swedish Krona", symbol: "kr" },
  { code: "NOK", name: "Norwegian Krone", symbol: "kr" },
  { code: "DKK", name: "Danish Krone", symbol: "kr" },
  { code: "NZD", name: "New Zealand Dollar", symbol: "NZ$" },
  { code: "MXN", name: "Mexican Peso", symbol: "MX$" },
  { code: "BRL", name: "Brazilian Real", symbol: "R$" },
  { code: "KRW", name: "South Korean Won", symbol: "₩" },
  { code: "INR", name: "Indian Rupee", symbol: "₹" },
  { code: "HKD", name: "Hong Kong Dollar", symbol: "HK$" },
  { code: "SGD", name: "Singapore Dollar", symbol: "S$" },
  { code: "TWD", name: "New Taiwan Dollar", symbol: "NT$" },
  { code: "PLN", name: "Polish Zloty", symbol: "zł" },
  { code: "THB", name: "Thai Baht", symbol: "฿" },
  { code: "ZAR", name: "South African Rand", symbol: "R" },
  { code: "CZK", name: "Czech Koruna", symbol: "Kč" },
  { code: "ILS", name: "Israeli Shekel", symbol: "₪" },
  { code: "CLP", name: "Chilean Peso", symbol: "CLP$" },
  { code: "PHP", name: "Philippine Peso", symbol: "₱" },
  { code: "COP", name: "Colombian Peso", symbol: "COL$" },
  { code: "ARS", name: "Argentine Peso", symbol: "ARS$" },
  { code: "TRY", name: "Turkish Lira", symbol: "₺" },
  { code: "HUF", name: "Hungarian Forint", symbol: "Ft" },
  { code: "ISK", name: "Icelandic Krona", symbol: "kr" },
  { code: "RON", name: "Romanian Leu", symbol: "lei" },
  { code: "BGN", name: "Bulgarian Lev", symbol: "лв" },
  { code: "HRK", name: "Croatian Kuna", symbol: "kn" },
  { code: "IDR", name: "Indonesian Rupiah", symbol: "Rp" },
  { code: "MYR", name: "Malaysian Ringgit", symbol: "RM" },
] as const;

export type CurrencyCode = (typeof COMMON_CURRENCIES)[number]["code"];

/**
 * Get the display label for a currency code.
 */
export function getCurrencyLabel(code: string): string {
  const upper = code.toUpperCase();
  const found = COMMON_CURRENCIES.find((c) => c.code === upper);
  return found ? `${found.code} - ${found.name}` : upper;
}
