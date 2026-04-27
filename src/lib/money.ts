import { defaultLocale, type Locale } from "@/i18n/routing";

const moneyLocales = {
  en: "en-US",
  es: "es-ES",
  sv: "sv-SE",
  fr: "fr-FR",
  de: "de-DE",
  "pt-BR": "pt-BR",
  ja: "ja-JP",
  "zh-CN": "zh-CN",
  ko: "ko-KR",
} satisfies Record<Locale, string>;

export function formatCents(cents: number, currency = "USD", locale: string = defaultLocale): string {
  return new Intl.NumberFormat((moneyLocales as Record<string, string>)[locale] ?? locale, {
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
