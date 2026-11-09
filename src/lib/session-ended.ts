import type { Locale } from '@/i18n/routing';
import { stripLocalePrefix } from '@/lib/locale-paths';
import { isPublicPage } from '@/lib/public-pages';

/** The login page's query parameter that shows "You were signed out" (#461) */
export const SIGNED_OUT_PARAM = 'signedOut';

/** How long the session check waits for the session endpoint before it keeps the page */
const SESSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * Whether a tRPC error is a procedure refusing a request for its session: `protectedProcedure`
 * throws UNAUTHORIZED without a message key when `auth()` reports nobody (a session ended by a
 * password reset or change, #397, or one whose password version the database couldn't give), or
 * when the session's user row no longer exists. Only the session endpoint can tell which
 * (`sessionEndpointSaysSignedOut`). A wrong current password in Settings is UNAUTHORIZED too,
 * with its own key.
 */
export function isSessionEndedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false;
  const data = (error as { data: unknown }).data;
  if (typeof data !== 'object' || data === null) return false;
  const { code, messageKey } = data as { code?: unknown; messageKey?: unknown };
  return code === 'UNAUTHORIZED' && messageKey == null;
}

/**
 * The sign-in page that brings the person back to this page and says they were signed out, or
 * null on a page the middleware lets through signed out (`isPublicPage`).
 */
export function signInAgainUrl(location: { pathname: string; search: string }, locale: Locale): string | null {
  if (isPublicPage(stripLocalePrefix(location.pathname))) return null;
  const params = new URLSearchParams({
    callbackUrl: `${location.pathname}${location.search}`,
    [SIGNED_OUT_PARAM]: '1',
  });
  return `/${locale}/login?${params}`;
}

/**
 * Whether the Auth.js session endpoint says nobody is signed in. It also clears the cookie of a
 * session that ended. While the database is down it answers 503 and keeps the session
 * (session-endpoint.ts), and a request that fails or takes too long says nothing either way:
 * neither counts. Not next-auth's `getSession()`, which answers null for a 503 and a failed
 * request alike.
 */
export async function sessionEndpointSaysSignedOut(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl('/api/auth/session', {
      cache: 'no-store',
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const session = (await response.json()) as { user?: unknown } | null;
    return !session?.user;
  } catch {
    return false;
  }
}

/**
 * The browser's query retry (providers.tsx): React Query's default of three retries, which also
 * starts the session check on the first failure that may mean the session ended, so a page whose
 * session ended goes to sign-in without waiting out the backoff, while a query that failed the
 * same way because the database blipped (#397) keeps retrying as before.
 */
export function retryCheckingSession(
  onSessionEnded: (error: unknown) => unknown,
): (failureCount: number, error: unknown) => boolean {
  return (failureCount, error) => {
    if (failureCount === 0 && isSessionEndedError(error)) void onSessionEnded(error);
    return failureCount < 3;
  };
}

/**
 * The query and mutation caches' error handler (providers.tsx), also started by
 * `retryCheckingSession`: on a page the middleware doesn't let through signed out, an error
 * saying the request had no session sends the browser to sign-in, once the session endpoint
 * confirms the session ended. Errors that arrive while it asks share one check, and once the
 * page is leaving the rest are ignored.
 */
export function createSessionEndedHandler(deps: {
  checkSession: () => Promise<boolean>;
  navigate: (url: string) => void;
  location: () => { pathname: string; search: string };
  locale: () => Locale;
}): (error: unknown) => Promise<void> {
  let check: Promise<void> | null = null;
  let leaving = false;

  return (error) => {
    if (leaving || !isSessionEndedError(error)) return Promise.resolve();
    if (check) return check;
    if (!signInAgainUrl(deps.location(), deps.locale())) return Promise.resolve();

    check = deps
      .checkSession()
      .then((signedOut) => {
        // The page the person is on now: a link they followed may have moved them meanwhile
        const target = signedOut ? signInAgainUrl(deps.location(), deps.locale()) : null;
        if (!target) return;
        leaving = true;
        deps.navigate(target);
      })
      .finally(() => {
        check = null;
      });
    return check;
  };
}
