export function formatCents(cents: number, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(cents / 100);
}

export function parseToCents(value: string): number {
  const num = parseFloat(value);
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

export function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}
