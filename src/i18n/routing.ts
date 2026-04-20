import { defineRouting } from "next-intl/routing";

export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export const rtlLocales: Locale[] = [];

export const languageConfig: Record<Locale, { flag: string; name: string }> = {
  en: { flag: "\u{1F1FA}\u{1F1F8}", name: "English" },
  es: { flag: "\u{1F1EA}\u{1F1F8}", name: "Espa\u00F1ol" },
};

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: "always",
});
