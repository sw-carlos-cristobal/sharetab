import { describe, expect, test, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { keepSessionWhileDatabaseDown, markPasswordVersionUnread } from './session-endpoint';
import { logger } from './logger';

const SESSION = 'http://localhost:3000/api/auth/session';

function request(url = SESSION) {
  return new Request(url, { headers: { cookie: 'authjs.session-token=abc' } });
}

/** What Auth.js answers when the jwt callback ended the session: no body, the cookie cleared */
function clearingResponse(name = 'authjs.session-token') {
  const response = Response.json(null);
  response.headers.append('set-cookie', `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly`);
  return response;
}

/** An Auth.js handler whose jwt callback couldn't read the password version */
function unreadHandler(response: Response) {
  return async () => {
    // As the callback does, after an await inside the handler
    await Promise.resolve();
    markPasswordVersionUnread();
    return response;
  };
}

describe('keepSessionWhileDatabaseDown', () => {
  test('answers 503 without touching the cookie when the jwt callback couldn’t read the version', async () => {
    const answer = await keepSessionWhileDatabaseDown(request(), unreadHandler(clearingResponse()));
    expect(answer.status).toBe(503);
    expect(answer.headers.getSetCookie()).toEqual([]);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(logger.warn).toHaveBeenCalledWith('auth.session_kept_database_down', { path: '/api/auth/session' });
  });

  test('passes the cleared cookie on when the version was read: the session really ended', async () => {
    // Even if the database fails right after: what counts is whether this request's read failed
    const response = clearingResponse();
    expect(await keepSessionWhileDatabaseDown(request(), async () => response)).toBe(response);
  });

  test('also keeps a chunked or __Secure- session cookie', async () => {
    for (const name of ['authjs.session-token.0', '__Secure-authjs.session-token']) {
      const answer = await keepSessionWhileDatabaseDown(request(), unreadHandler(clearingResponse(name)));
      expect(answer.status).toBe(503);
    }
  });

  test('leaves an answer that keeps the cookie alone, even when the version wasn’t read', async () => {
    // A sign-in whose read failed keeps its session (auth.ts), so nothing is cleared
    const kept = Response.json({ user: { id: 'u1' } });
    expect(await keepSessionWhileDatabaseDown(request(), unreadHandler(kept))).toBe(kept);
  });

  test('one request’s failed read doesn’t reach another running at the same time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const failing = keepSessionWhileDatabaseDown(request(), async () => {
      await gate;
      markPasswordVersionUnread();
      return clearingResponse();
    });
    const ended = clearingResponse();
    const other = keepSessionWhileDatabaseDown(request(), async () => {
      release();
      await gate;
      return ended;
    });
    expect((await failing).status).toBe(503);
    expect(await other).toBe(ended);
  });

  test('outside an Auth.js route, marking does nothing', () => {
    expect(() => markPasswordVersionUnread()).not.toThrow();
  });
});
