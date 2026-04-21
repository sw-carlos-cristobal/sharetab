import { defaultLocale } from "@/i18n/routing";

const moneyLocales: Record<string, string> = {
  en: "en-US",
  es: "es-ES",
};

export function formatCents(cents: number, currency = "USD", locale: string = defaultLocale): string {
  return new Intl.NumberFormat(moneyLocales[locale] ?? locale, {
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
