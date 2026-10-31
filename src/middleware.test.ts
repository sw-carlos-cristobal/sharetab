import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';
import { middleware } from './middleware';

// next-intl's ESM build imports `next/server` without an extension, which Node can't resolve under
// Vitest. These tests are about the session check, so the locale step just passes requests through.
vi.mock('next-intl/middleware', () => ({ default: () => () => NextResponse.next() }));

const PLAIN = 'authjs.session-token';
const SECURE = '__Secure-authjs.session-token';

// Real Auth.js encoding: the cookie name is the salt, so a cookie only decodes under its own name
async function sessionCookie(name: string, secret = 'auth-secret') {
  return `${name}=${await encode({ token: { sub: 'u7' }, secret, salt: name })}`;
}

/** A page request as Next.js hands it to the middleware: its URL and x-forwarded-proto agree */
function pageRequest(url: string, cookie?: string) {
  const headers = new Headers({ 'x-forwarded-proto': new URL(url).protocol.replace(':', '') });
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(url, { headers });
}

function redirectsToLogin(response: Response) {
  const location = response.headers.get('location');
  return location !== null && new URL(location).pathname === '/en/login';
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

describe('middleware session cookie (#409)', () => {
  test('behind an https proxy with an http NEXTAUTH_URL, it reads the plain cookie Auth.js set', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    vi.stubEnv('NEXTAUTH_URL', 'http://192.168.1.10:3000');
    const response = await middleware(
      pageRequest('https://sharetab.example.com/en/dashboard', await sessionCookie(PLAIN)),
    );
    expect(redirectsToLogin(response)).toBe(false);
  });

  test('with an https NEXTAUTH_URL and an http hop to the app, it reads the __Secure- cookie', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com');
    const response = await middleware(
      pageRequest('http://sharetab.example.com/en/dashboard', await sessionCookie(SECURE)),
    );
    expect(redirectsToLogin(response)).toBe(false);
  });

  test('AUTH_URL decides over NEXTAUTH_URL, as it does for Auth.js', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    vi.stubEnv('AUTH_URL', 'http://192.168.1.10:3000');
    vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com');
    const response = await middleware(
      pageRequest('https://sharetab.example.com/en/dashboard', await sessionCookie(PLAIN)),
    );
    expect(redirectsToLogin(response)).toBe(false);
  });

  test('ignores a cookie of the name Auth.js does not use, as Auth.js does', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    vi.stubEnv('NEXTAUTH_URL', 'http://192.168.1.10:3000');
    const response = await middleware(
      pageRequest('https://sharetab.example.com/en/dashboard', await sessionCookie(SECURE)),
    );
    expect(redirectsToLogin(response)).toBe(true);
  });

  test('without a configured URL it goes by the request, as before', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    const secure = await middleware(
      pageRequest('https://sharetab.example.com/en/dashboard', await sessionCookie(SECURE)),
    );
    expect(redirectsToLogin(secure)).toBe(false);
    const plain = await middleware(pageRequest('http://192.168.1.10:3000/en/dashboard', await sessionCookie(PLAIN)));
    expect(redirectsToLogin(plain)).toBe(false);
  });

  test('reads a session signed with NEXTAUTH_SECRET when AUTH_SECRET is unset, as Auth.js does', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', 'nextauth-secret');
    vi.stubEnv('NEXTAUTH_URL', 'http://192.168.1.10:3000');
    const response = await middleware(
      pageRequest('http://192.168.1.10:3000/en/dashboard', await sessionCookie(PLAIN, 'nextauth-secret')),
    );
    expect(redirectsToLogin(response)).toBe(false);
  });

  test('sends a request with no session to the login page', async () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret');
    vi.stubEnv('NEXTAUTH_URL', 'http://192.168.1.10:3000');
    const response = await middleware(pageRequest('https://sharetab.example.com/en/dashboard'));
    expect(redirectsToLogin(response)).toBe(true);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('callbackUrl')).toBe('/en/dashboard');
  });
});
