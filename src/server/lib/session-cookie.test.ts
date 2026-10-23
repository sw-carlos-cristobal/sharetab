import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { encode } from 'next-auth/jwt';
import { sessionCookieSubject } from './session-cookie';

const PLAIN = 'authjs.session-token';
const SECURE = '__Secure-authjs.session-token';

// Real Auth.js encoding: the cookie name is the salt, so a cookie only decodes under its own name
async function sessionCookie(name: string, secret: string, sub = 'u7') {
  return `${name}=${await encode({ token: { sub }, secret, salt: name })}`;
}

function request(cookie: string, extra: Record<string, string> = {}) {
  return new Headers({ cookie, ...extra });
}

const ENV = [
  'AUTH_SECRET',
  'NEXTAUTH_SECRET',
  'AUTH_SECRET_1',
  'AUTH_SECRET_2',
  'AUTH_SECRET_3',
  'AUTH_URL',
  'NEXTAUTH_URL',
];

beforeEach(() => {
  // Unset, not empty: Auth.js treats an empty AUTH_SECRET or AUTH_URL as set
  for (const key of ENV) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sessionCookieSubject', () => {
  test('reads the cookie Auth.js uses over https, and not a plain one left from before', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    vi.stubEnv('NEXTAUTH_URL', 'https://tabs.example.com');
    expect(await sessionCookieSubject(request(await sessionCookie(SECURE, 'auth-secret')))).toBe('u7');
    // Auth.js ignores it there, and signing out can't clear it, so it mustn't refuse a sign-in
    expect(await sessionCookieSubject(request(await sessionCookie(PLAIN, 'auth-secret')))).toBeNull();
  });

  test('over http it reads the plain cookie, and not a __Secure- one', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    vi.stubEnv('NEXTAUTH_URL', 'http://sharetab.lan:3000');
    expect(await sessionCookieSubject(request(await sessionCookie(PLAIN, 'auth-secret')))).toBe('u7');
    expect(await sessionCookieSubject(request(await sessionCookie(SECURE, 'auth-secret')))).toBeNull();
  });

  test('AUTH_URL decides over NEXTAUTH_URL, as it does for Auth.js', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    vi.stubEnv('AUTH_URL', 'https://tabs.example.com');
    vi.stubEnv('NEXTAUTH_URL', 'http://sharetab.lan:3000');
    expect(await sessionCookieSubject(request(await sessionCookie(SECURE, 'auth-secret')))).toBe('u7');
  });

  test('a configured URL that can’t be parsed falls back to the forwarded protocol', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    vi.stubEnv('AUTH_URL', 'not a url');
    const secure = await sessionCookie(SECURE, 'auth-secret');
    expect(await sessionCookieSubject(request(secure, { 'x-forwarded-proto': 'https' }))).toBe('u7');
  });

  test('without a configured URL it goes by the forwarded protocol, as Next.js does', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    const secure = await sessionCookie(SECURE, 'auth-secret');
    expect(await sessionCookieSubject(request(secure, { 'x-forwarded-proto': 'https' }))).toBe('u7');
    // Next.js takes any protocol list that includes https as https
    expect(await sessionCookieSubject(request(secure, { 'x-forwarded-proto': 'https,http' }))).toBe('u7');
    expect(await sessionCookieSubject(request(await sessionCookie(PLAIN, 'auth-secret')))).toBe('u7');
  });

  test('uses AUTH_SECRET over NEXTAUTH_SECRET when both are set, as Auth.js does', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    vi.stubEnv('NEXTAUTH_SECRET', 'nextauth-secret');
    expect(await sessionCookieSubject(request(await sessionCookie(PLAIN, 'auth-secret')))).toBe('u7');
    expect(await sessionCookieSubject(request(await sessionCookie(PLAIN, 'nextauth-secret')))).toBeNull();
  });

  test('uses NEXTAUTH_SECRET without AUTH_SECRET, and else any of AUTH_SECRET_1..3', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', 'nextauth-secret');
    expect(await sessionCookieSubject(request(await sessionCookie(PLAIN, 'nextauth-secret')))).toBe('u7');

    vi.stubEnv('NEXTAUTH_SECRET', undefined);
    vi.stubEnv('AUTH_SECRET_1', 'old-secret');
    vi.stubEnv('AUTH_SECRET_3', 'new-secret');
    expect(await sessionCookieSubject(request(await sessionCookie(PLAIN, 'old-secret')))).toBe('u7');
    expect(await sessionCookieSubject(request(await sessionCookie(PLAIN, 'new-secret')))).toBe('u7');
  });

  test('a cookie it can’t decode, under a name Auth.js doesn’t use, or none at all is nobody', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    expect(await sessionCookieSubject(request(await sessionCookie(PLAIN, 'other-secret')))).toBeNull();
    expect(
      await sessionCookieSubject(request(await sessionCookie('next-auth.session-token', 'auth-secret'))),
    ).toBeNull();
    expect(await sessionCookieSubject(request(`${PLAIN}=garbage`))).toBeNull();
    expect(await sessionCookieSubject(request(''))).toBeNull();
  });

  test('reads only the cookie, never an Authorization header', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    const bearer = (await sessionCookie(PLAIN, 'auth-secret')).slice(`${PLAIN}=`.length);
    expect(await sessionCookieSubject(request('', { authorization: `Bearer ${bearer}` }))).toBeNull();
  });

  test('without any secret configured, it reports nobody instead of failing', async () => {
    expect(await sessionCookieSubject(request(`${PLAIN}=anything`))).toBeNull();
  });
});
