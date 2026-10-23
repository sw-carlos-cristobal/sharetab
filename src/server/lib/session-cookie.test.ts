import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { encode } from 'next-auth/jwt';
import { sessionCookieSubject } from './session-cookie';

// Real Auth.js encoding: the cookie name is the salt, so a cookie only decodes under its own name
async function sessionCookie(name: string, secret: string, sub = 'u7') {
  return `${name}=${await encode({ token: { sub }, secret, salt: name })}`;
}

const SECRETS = ['AUTH_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET_1', 'AUTH_SECRET_2', 'AUTH_SECRET_3'];

beforeEach(() => {
  // Unset, not empty: Auth.js treats an empty AUTH_SECRET as set
  for (const key of SECRETS) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sessionCookieSubject', () => {
  test('reads the user from either session cookie Auth.js sets, plain or __Secure-', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    expect(await sessionCookieSubject(await sessionCookie('authjs.session-token', 'auth-secret'))).toBe('u7');
    expect(await sessionCookieSubject(await sessionCookie('__Secure-authjs.session-token', 'auth-secret'))).toBe('u7');
  });

  test('uses AUTH_SECRET over NEXTAUTH_SECRET when both are set, as Auth.js does', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    vi.stubEnv('NEXTAUTH_SECRET', 'nextauth-secret');
    expect(await sessionCookieSubject(await sessionCookie('authjs.session-token', 'auth-secret'))).toBe('u7');
    expect(await sessionCookieSubject(await sessionCookie('authjs.session-token', 'nextauth-secret'))).toBeNull();
  });

  test('uses NEXTAUTH_SECRET without AUTH_SECRET, and else any of AUTH_SECRET_1..3', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', 'nextauth-secret');
    expect(await sessionCookieSubject(await sessionCookie('authjs.session-token', 'nextauth-secret'))).toBe('u7');

    vi.stubEnv('NEXTAUTH_SECRET', undefined);
    vi.stubEnv('AUTH_SECRET_1', 'old-secret');
    vi.stubEnv('AUTH_SECRET_3', 'new-secret');
    expect(await sessionCookieSubject(await sessionCookie('authjs.session-token', 'old-secret'))).toBe('u7');
    expect(await sessionCookieSubject(await sessionCookie('authjs.session-token', 'new-secret'))).toBe('u7');
  });

  test('a cookie it can’t decode, under a name it doesn’t use, or none at all is nobody', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    expect(await sessionCookieSubject(await sessionCookie('authjs.session-token', 'other-secret'))).toBeNull();
    expect(await sessionCookieSubject(await sessionCookie('next-auth.session-token', 'auth-secret'))).toBeNull();
    expect(await sessionCookieSubject('authjs.session-token=garbage')).toBeNull();
    expect(await sessionCookieSubject('')).toBeNull();
  });

  test('without any secret configured, it reports nobody instead of failing', async () => {
    expect(await sessionCookieSubject('authjs.session-token=anything')).toBeNull();
  });
});
