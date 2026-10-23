import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from './logger';

// The session cookie as Auth.js clears it, plain or __Secure-, whole or one of its chunks
const CLEARED_SESSION_COOKIE = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?=;/;

// Per Auth.js request: whether the jwt callback couldn't read the session's password version
const versionCheck = new AsyncLocalStorage<{ unread: boolean }>();

/**
 * Called by the jwt callback (auth.ts) when it couldn't read the user's password version, so it
 * ended the session for this request only. Outside an Auth.js route (`auth()` from a page or a
 * tRPC call) there's no cookie to keep, and this does nothing.
 */
export function markPasswordVersionUnread(): void {
  const state = versionCheck.getStore();
  if (state) state.unread = true;
}

/**
 * The jwt callback (auth.ts) ends a session whose password version it can't read (#397), and on
 * the session endpoint Auth.js then clears the session cookie. `SessionProvider` reads that
 * endpoint whenever a page loads or a tab becomes visible, so a database error there would sign
 * the browser out for good. This runs an Auth.js route handler and, when the jwt callback said it
 * couldn't read the version (`markPasswordVersionUnread`) and the answer clears the session
 * cookie, answers 503 with the cookie left alone instead: the session works again once the
 * database answers. A session that really ended (its password changed) still has its cookie
 * cleared. Every other answer passes through unchanged.
 */
export async function keepSessionWhileDatabaseDown<R extends Request>(
  request: R,
  handle: (request: R) => Promise<Response>,
): Promise<Response> {
  const state = { unread: false };
  const response = await versionCheck.run(state, () => handle(request));
  if (!state.unread) return response;
  if (!response.headers.getSetCookie().some((cookie) => CLEARED_SESSION_COOKIE.test(cookie))) return response;

  logger.warn('auth.session_kept_database_down', { path: new URL(request.url).pathname });
  return Response.json({ error: 'Service unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
}
