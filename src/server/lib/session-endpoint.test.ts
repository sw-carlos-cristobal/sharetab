import { describe, expect, test, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { keepSessionWhileDatabaseDown } from './session-endpoint';
import { logger } from './logger';

const SESSION = 'http://localhost:3000/api/auth/session';
const SIGNED_IN = 'authjs.session-token=abc';

function request(url: string, cookie = SIGNED_IN) {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

/** What Auth.js answers when the jwt callback ended the session: no body, the cookie cleared */
function clearingResponse(name = 'authjs.session-token') {
  const response = Response.json(null);
  response.headers.append('set-cookie', `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly`);
  return response;
}

const down = () => Promise.reject(new Error('connection refused'));
const up = () => Promise.resolve();

describe('keepSessionWhileDatabaseDown', () => {
  test('answers 503 without touching the cookie when the session ended only because the database is down', async () => {
    const answer = await keepSessionWhileDatabaseDown(request(SESSION), clearingResponse(), down);
    expect(answer.status).toBe(503);
    expect(answer.headers.getSetCookie()).toEqual([]);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(logger.warn).toHaveBeenCalledWith('auth.session_kept_database_down', { error: 'Error' });
  });

  test('a database that doesn’t answer within a few seconds counts as down', async () => {
    vi.useFakeTimers();
    try {
      const pending = keepSessionWhileDatabaseDown(request(SESSION), clearingResponse(), () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await pending).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  test('passes the cleared cookie on when the database answers: the session really ended', async () => {
    const response = clearingResponse();
    expect(await keepSessionWhileDatabaseDown(request(SESSION), response, up)).toBe(response);
  });

  test('also keeps a chunked or __Secure- session cookie', async () => {
    for (const name of ['authjs.session-token.0', '__Secure-authjs.session-token']) {
      const answer = await keepSessionWhileDatabaseDown(request(SESSION, `${name}=abc`), clearingResponse(name), down);
      expect(answer.status).toBe(503);
    }
  });

  test('leaves every other answer alone, without asking the database', async () => {
    const ping = vi.fn(down);
    // A session that's still good
    const kept = Response.json({ user: { id: 'u1' } });
    expect(await keepSessionWhileDatabaseDown(request(SESSION), kept, ping)).toBe(kept);
    // Signing out clears the cookie on purpose
    const signedOut = clearingResponse();
    expect(await keepSessionWhileDatabaseDown(request('http://localhost:3000/api/auth/signout'), signedOut, ping)).toBe(
      signedOut,
    );
    // No session cookie came in, so there is nothing to keep
    const anonymous = clearingResponse();
    expect(await keepSessionWhileDatabaseDown(request(SESSION, ''), anonymous, ping)).toBe(anonymous);
    expect(ping).not.toHaveBeenCalled();
  });
});
