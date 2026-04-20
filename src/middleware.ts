import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { isSupportedLocale, withLocalePrefix } from "@/lib/locale-paths";

const intlMiddleware = createIntlMiddleware(routing);

const publicPages = ["/login", "/register", "/verify-request", "/invite", "/split"];

function isPublicPage(pathname: string): boolean {
  return publicPages.some(
    (page) => pathname === page || pathname.startsWith(page + "/")
  );
}

export async function middleware(request: NextRequest) {
  const intlResponse = intlMiddleware(request);
  const pathname = request.nextUrl.pathname;
  const callbackUrl = `${pathname}${request.nextUrl.search}`;
  const localePrefix = routing.locales.find(
    (locale) => pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`
  );
  const strippedPathname = localePrefix
    ? pathname.replace(`/${localePrefix}`, "") || "/"
    : pathname;

  const isSecure = request.nextUrl.protocol === "https:";
  const cookieName = isSecure
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";

  let token;
  try {
    token = await getToken({
      req: request,
      secret: process.env.AUTH_SECRET,
      cookieName,
    });
  } catch {
    // Malformed or forged JWT — treat as unauthenticated
  }

  const tokenLocale =
    typeof token?.locale === "string" && isSupportedLocale(token.locale)
      ? token.locale
      : null;

  if (!localePrefix && tokenLocale) {
    return NextResponse.redirect(new URL(withLocalePrefix(callbackUrl, tokenLocale), request.url));
  }

  if (isPublicPage(strippedPathname) || strippedPathname === "/") {
    return intlResponse;
  }

  if (!token) {
    // For unprefixed routes (e.g. /dashboard), intlMiddleware will redirect to
    // the locale-prefixed URL. Return that redirect so locale is resolved first;
    // auth will be re-checked on the resulting locale-prefixed request.
    if (!localePrefix && intlResponse.status >= 300 && intlResponse.status < 400) {
      return intlResponse;
    }
    const locale = localePrefix ?? tokenLocale ?? routing.defaultLocale;
    const loginUrl = new URL(`/${locale}/login`, request.url);
    loginUrl.searchParams.set("callbackUrl", callbackUrl);
    return NextResponse.redirect(loginUrl);
  }

  return intlResponse;
}

export const config = {
  matcher: [
    "/((?!api|_next|_vercel|favicon\\.png|icon\\.svg|icons|manifest\\.json|.*\\..*).*)",
  ],
};
