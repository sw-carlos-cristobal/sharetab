import { defineRouting } from "next-intl/routing";

export const locales = ["en", "es", "fr", "de", "pt-BR", "ja", "zh-CN", "ko"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export const rtlLocales: Locale[] = [];

export const languageConfig: Record<Locale, { flag: string; name: string }> = {
  en: { flag: "\u{1F1FA}\u{1F1F8}", name: "English" },
  es: { flag: "\u{1F1EA}\u{1F1F8}", name: "Espa\u00F1ol" },
  fr: { flag: "\u{1F1EB}\u{1F1F7}", name: "Fran\u00E7ais" },
  de: { flag: "\u{1F1E9}\u{1F1EA}", name: "Deutsch" },
  "pt-BR": { flag: "\u{1F1E7}\u{1F1F7}", name: "Portugu\u00EAs" },
  ja: { flag: "\u{1F1EF}\u{1F1F5}", name: "\u65E5\u672C\u8A9E" },
  "zh-CN": { flag: "\u{1F1E8}\u{1F1F3}", name: "\u4E2D\u6587" },
  ko: { flag: "\u{1F1F0}\u{1F1F7}", name: "\uD55C\uAD6D\uC5B4" },
};

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: "always",
});
