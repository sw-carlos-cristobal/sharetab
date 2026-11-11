import { afterEach, describe, expect, test, vi } from 'vitest';
// `Auth` is only exported by @auth/core, and next-auth's own entry imports `next/server` without
// an extension, which Vitest can't load: next-auth re-exports `CredentialsSignin` from
// @auth/core/errors, so password-credentials.ts gets that class here. This holds while next-auth
// uses this one @auth/core copy.
import { Auth } from '@auth/core';
import { CredentialsSignin } from '@auth/core/errors';
import Credentials from 'next-auth/providers/credentials';
import { rateLimitedMinutes } from '@/lib/sign-in-rate-limit';

vi.mock('next-auth', () => ({ CredentialsSignin }));
vi.mock('./db', () => ({
  db: {
    $queryRaw: vi.fn(async () => [{ id: 'bob' }]),
    user: {
      findMany: vi.fn(async () => [
        { id: 'bob', name: 'Bob', email: 'bob@example.com', passwordHash: 'hash', passwordChangedAt: null },
      ]),
    },
  },
}));
vi.mock('./lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('bcryptjs', () => ({ default: { compare: vi.fn(async () => false) } }));

const { authorizeCredentials } = await import('./lib/password-credentials');

// The Credentials provider as auth.ts registers it, run through the real Auth.js the way the login
// page's signIn('credentials', { redirect: false }) calls it, and read the way next-auth/react
// reads the answer (`code` from the URL it returns). An Auth.js upgrade that stops passing a
// refusal's code to the page fails here (#401).

const ORIGIN = 'http://localhost:3000';
const config = {
  secret: 'x'.repeat(32),
  trustHost: true,
  basePath: '/api/auth',
  // Auth.js logs every refused sign-in as an error; these are expected.
  logger: { error: vi.fn() },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: authorizeCredentials,
    }),
  ],
};

const cookiesOf = (response: Response) => response.headers.getSetCookie().map((c) => c.split(';')[0] ?? '');

/** One password sign-in, as next-auth/react sends it; returns the `error` and `code` it reads. */
async function passwordSignIn() {
  const csrf = await Auth(new Request(`${ORIGIN}/api/auth/csrf`), config);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const response = await Auth(
    new Request(`${ORIGIN}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-auth-return-redirect': '1',
        cookie: cookiesOf(csrf).join('; '),
      },
      body: new URLSearchParams({ email: 'bob@example.com', password: 'wrong-password', csrfToken }),
    }),
    config,
  );
  const url = new URL(((await response.json()) as { url: string }).url);
  return { error: url.searchParams.get('error'), code: url.searchParams.get('code') ?? undefined };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a password sign-in refused by the login limit, through the real Auth.js', () => {
  test('reaches the page as a rate-limited code, not as a wrong password', async () => {
    vi.stubEnv('AUTH_RATE_LIMIT_MAX', '1');

    const wrongPassword = await passwordSignIn();
    expect(wrongPassword).toStrictEqual({ error: 'CredentialsSignin', code: 'credentials' });
    expect(rateLimitedMinutes(wrongPassword.code)).toBeNull();

    const limited = await passwordSignIn();
    expect(limited.error).toBe('CredentialsSignin');
    expect(rateLimitedMinutes(limited.code)).toBe(15);
  });
});
