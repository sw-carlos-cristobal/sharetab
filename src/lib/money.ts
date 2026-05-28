import { defaultLocale, type Locale } from "@/i18n/routing";

const moneyLocales: Record<string, string> = {
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
  return new Intl.NumberFormat(moneyLocales[locale] ?? locale, {
    style: "currency",
    currency,
  }).format(cents / 100);
}

export function parseToCents(value: string): number {
  const trimmed = value.trim().replace(/,/g, "");
  if (!trimmed || isNaN(Number(trimmed))) return 0;
  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  const dotIndex = abs.lastIndexOf(".");
  if (dotIndex === -1) return (parseInt(abs, 10) || 0) * 100 * (negative ? -1 : 1);
  const intPart = abs.slice(0, dotIndex) || "0";
  const fracPart = abs.slice(dotIndex + 1).padEnd(2, "0").slice(0, 2);
  const cents = (parseInt(intPart, 10) || 0) * 100 + parseInt(fracPart, 10);
  return cents * (negative ? -1 : 1);
}

export function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}
