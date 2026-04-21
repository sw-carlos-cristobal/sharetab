import { locales, type Locale } from "@/i18n/routing";

function splitPathSuffix(path: string) {
  const suffixIndex = path.search(/[?#]/);
  if (suffixIndex === -1) {
    return { pathname: path, suffix: "" };
  }

  return {
    pathname: path.slice(0, suffixIndex),
    suffix: path.slice(suffixIndex),
  };
}

export function isSafeInternalPath(path: string | null): path is string {
  return !!path && path.startsWith("/") && !path.startsWith("//");
}

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return !!value && locales.includes(value as Locale);
}

export function hasLocalePrefix(path: string): boolean {
  const { pathname } = splitPathSuffix(path);
  return locales.some((locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`));
}

export function stripLocalePrefix(path: string): string {
  const { pathname, suffix } = splitPathSuffix(path);
  const locale = locales.find((value) => pathname === `/${value}` || pathname.startsWith(`/${value}/`));
  if (!locale) return path;

  const stripped = pathname.slice(locale.length + 1);
  const normalized = stripped.startsWith("/") ? stripped : `/${stripped}`;
  return `${normalized}${suffix}`;
}

export function withLocalePrefix(path: string, locale: Locale): string {
  const { pathname, suffix } = splitPathSuffix(path);
  if (hasLocalePrefix(path)) {
    return `${pathname}${suffix}`;
  }

  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const localized = normalized === "/" ? `/${locale}` : `/${locale}${normalized}`;
  return `${localized}${suffix}`;
}

export function normalizeCallbackPath(rawCallbackUrl: string | null, locale: Locale): string {
  if (!isSafeInternalPath(rawCallbackUrl)) {
    return `/${locale}/dashboard`;
  }

  return withLocalePrefix(rawCallbackUrl, locale);
}
