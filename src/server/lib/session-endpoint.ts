import { logger } from './logger';

// The session cookie, plain or __Secure-, whole or one of its chunks (`.0`, `.1`, ...)
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?authjs\.session-token(?:\.\d+)?=/;
const CLEARED_SESSION_COOKIE = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?=;/;
// A database that doesn't answer in time counts as down: the pool has no connect timeout of its own
const PING_TIMEOUT_MS = 3_000;

/**
 * The jwt callback (auth.ts) ends a session whose password version it can't read (#397), and on
 * the session endpoint Auth.js then clears the session cookie. `SessionProvider` reads that
 * endpoint whenever a page loads or a tab becomes visible, so a database outage would sign every
 * open browser out. When the endpoint is about to clear the cookie of a request that sent one,
 * this asks the database (`ping`): if it doesn't answer, the session ended only because of the
 * outage, so the answer is 503 with the cookie left alone, and the session works again once the
 * database is back. A session that really ended (its password changed) still has its cookie
 * cleared. Every other answer passes through unchanged.
 */
export async function keepSessionWhileDatabaseDown(
  request: Request,
  response: Response,
  ping: () => Promise<unknown>,
): Promise<Response> {
  if (!new URL(request.url).pathname.endsWith('/session')) return response;
  if (!SESSION_COOKIE.test(request.headers.get('cookie') ?? '')) return response;
  if (!response.headers.getSetCookie().some((cookie) => CLEARED_SESSION_COOKIE.test(cookie))) return response;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Database ping timed out')), PING_TIMEOUT_MS);
      }),
    ]);
    return response;
  } catch (error) {
    logger.warn('auth.session_kept_database_down', { error: error instanceof Error ? error.name : 'unknown' });
    return Response.json({ error: 'Service unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  } finally {
    clearTimeout(timer);
  }
}
