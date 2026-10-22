import { defaultLocale, locales, type Locale } from '@/i18n/routing';

// The page's language, sent with each tRPC call and upload so the server can answer errors
// in it (#266). The browser's Accept-Language is the browser's language, not the one chosen
// in ShareTab.
export const LOCALE_HEADER = 'x-locale';

export function localeFromHeader(value: string | null): Locale {
  return locales.find((l) => l === value) ?? defaultLocale;
}

// The page's <html lang> is its locale (src/app/[locale]/layout.tsx)
export function localeHeaders(): Record<string, string> {
  return typeof document === 'undefined' ? {} : { [LOCALE_HEADER]: document.documentElement.lang };
}
