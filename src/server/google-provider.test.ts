import { describe, expect, test, vi } from 'vitest';
// `Auth` is only exported by @auth/core. next-auth re-exports `customFetch`, but
// its entry imports `next/server` without an extension, which Vitest's resolver
// for dependencies can't load. This holds while next-auth and
// @auth/prisma-adapter share one @auth/core copy (0.41.3 for both today).
import { Auth, customFetch } from '@auth/core';
import Google from 'next-auth/providers/google';
import { googleProviderOptions } from './lib/google-sign-in';

// The Google provider options auth.ts uses, run through the real Auth.js with
// Google's endpoints stubbed: the authorization URL it sends the browser to,
// what the signIn callback (and so the Google policy) gets back, and that a
// refused or failed sign-in creates no user, links no account and starts no
// session. An Auth.js upgrade, or an edit to the options, that changes any of
// these fails here.

const ORIGIN = 'http://localhost:3000';
const DISCOVERY = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  code_challenge_methods_supported: ['plain', 'S256'],
};

const OPTIONS = googleProviderOptions({ clientId: 'client-id', clientSecret: 'client-secret' });

const now = Math.floor(Date.now() / 1000);
const ID_TOKEN_CLAIMS = {
  iss: DISCOVERY.issuer,
  aud: 'client-id',
  sub: 'g-123',
  email: 'Alice@Example.COM',
  email_verified: true,
  hd: 'example.com',
  name: 'Alice',
  iat: now,
  exp: now + 3600,
};
const encode = (part: unknown) => Buffer.from(JSON.stringify(part)).toString('base64url');
// Auth.js takes the ID token from the token endpoint's TLS answer without checking its signature.
const ID_TOKEN = [encode({ alg: 'RS256', typ: 'JWT' }), encode(ID_TOKEN_CLAIMS), 'signature'].join('.');

/** Google's discovery document, and its token endpoint's answer to the code exchange. */
function googleEndpoints(input: string | URL | Request): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  if (url === DISCOVERY.token_endpoint) {
    return Promise.resolve(
      Response.json({ access_token: 'access', token_type: 'Bearer', id_token: ID_TOKEN, expires_in: 3600 }),
    );
  }
  if (url === `${DISCOVERY.issuer}/.well-known/openid-configuration`) return Promise.resolve(Response.json(DISCOVERY));
  // Anything else (a JWKS fetch, say) means Auth.js changed how it talks to Google.
  return Promise.reject(new Error(`unexpected fetch: ${url}`));
}

function authConfig(options: Parameters<typeof Google>[0], signIn?: () => Promise<string | boolean>) {
  return {
    secret: 'x'.repeat(32),
    trustHost: true,
    basePath: '/api/auth',
    ...(signIn ? { callbacks: { signIn } } : {}),
    providers: [Google({ ...options, [customFetch]: googleEndpoints })],
  };
}

const cookiesOf = (response: Response) => response.headers.getSetCookie().map((c) => c.split(';')[0] ?? '');

/** An adapter with no users, recording any attempt to create one or link an account. */
function emptyAdapter() {
  return {
    getUserByAccount: vi.fn(() => Promise.resolve(null)),
    getUserByEmail: vi.fn((): Promise<{ id: string; email: string; emailVerified: null } | null> =>
      Promise.resolve(null),
    ),
    createUser: vi.fn((user: { email: string }) => Promise.resolve({ ...user, id: 'new-user', emailVerified: null })),
    linkAccount: vi.fn(() => Promise.resolve()),
  };
}

/** Runs a Google sign-in through to its callback, with this adapter and JWT sessions. */
async function finishSignIn(signIn: () => Promise<string | boolean>, adapter: ReturnType<typeof emptyAdapter>) {
  const config = { ...authConfig(OPTIONS, signIn), adapter, session: { strategy: 'jwt' as const } };
  const { url, cookies } = await startSignIn(config);
  return Auth(
    new Request(`${ORIGIN}/api/auth/callback/google?code=code&state=${url.searchParams.get('state') ?? ''}`, {
      headers: { cookie: cookies.join('; ') },
    }),
    config,
  );
}

const startsSession = (response: Response) => cookiesOf(response).some((c) => c.startsWith('authjs.session-token='));

/** Starts a Google sign-in the way the login page's button does; returns Google's URL and the cookies set. */
async function startSignIn(config: ReturnType<typeof authConfig>) {
  const csrf = await Auth(new Request(`${ORIGIN}/api/auth/csrf`), config);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const csrfCookies = cookiesOf(csrf);
  const signIn = await Auth(
    new Request(`${ORIGIN}/api/auth/signin/google`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-auth-return-redirect': '1',
        cookie: csrfCookies.join('; '),
      },
      body: new URLSearchParams({ csrfToken, callbackUrl: '/en/groups' }),
    }),
    config,
  );
  const url = new URL(((await signIn.json()) as { url: string }).url);
  return { url, cookies: [...csrfCookies, ...cookiesOf(signIn)] };
}

describe('Google sign-in through the real Auth.js', () => {
  test("sends the browser to Google's account chooser with the callback/google redirect URI", async () => {
    const { url } = await startSignIn(authConfig(OPTIONS));
    expect(url.origin + url.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/google`);
    // The policy needs the email and email_verified claims the email scope brings.
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['openid', 'email']));
  });

  test('sends no prompt without the authorization option, so the test above is not vacuous', async () => {
    const { id, clientId, clientSecret } = OPTIONS;
    const { url } = await startSignIn(authConfig({ id, clientId, clientSecret }));
    expect(url.searchParams.get('prompt')).toBeNull();
  });

  test("hands the signIn callback Google's ID-token claims, a lowercased email and the sub, and redirects a refusal", async () => {
    const signIn = vi.fn(() => Promise.resolve('/login?error=GoogleEmailUnverified'));
    const callback = await finishSignIn(signIn, emptyAdapter());

    // What auth.ts passes to checkGoogleSignIn: user.email, account.providerAccountId, and profile as the claims.
    expect(signIn).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ email: 'alice@example.com' }) as unknown,
        account: expect.objectContaining({ provider: 'google', providerAccountId: 'g-123' }) as unknown,
        profile: expect.objectContaining({ email_verified: true, hd: 'example.com' }) as unknown,
      }),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${ORIGIN}/login?error=GoogleEmailUnverified`);
  });

  test.each([
    ['refuses', () => Promise.resolve('/login?error=GoogleEmailUnverified'), '/login?error=GoogleEmailUnverified'],
    // auth.ts lets a policy's failure (a database error, say) throw.
    ['throws', () => Promise.reject(new Error('connection lost')), '/api/auth/error?error=AccessDenied'],
  ])('when the signIn callback %s, nothing is created and no session starts', async (_, signIn, location) => {
    const adapter = emptyAdapter();
    const callback = await finishSignIn(signIn, adapter);

    expect(callback.headers.get('location')).toBe(`${ORIGIN}${location}`);
    expect(adapter.createUser).not.toHaveBeenCalled();
    expect(adapter.linkAccount).not.toHaveBeenCalled();
    expect(startsSession(callback)).toBe(false);
  });

  test('when the signIn callback allows it, the user is created, Google linked and a session started, so the test above can fail', async () => {
    const adapter = emptyAdapter();
    const callback = await finishSignIn(() => Promise.resolve(true), adapter);

    expect(adapter.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'alice@example.com' }));
    expect(adapter.linkAccount).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', providerAccountId: 'g-123', userId: 'new-user' }),
    );
    expect(startsSession(callback)).toBe(true);
  });

  test('never links Google to an account that has its email, even when the signIn callback allows it', async () => {
    const adapter = emptyAdapter();
    adapter.getUserByEmail.mockResolvedValue({ id: 'u1', email: 'alice@example.com', emailVerified: null });
    const callback = await finishSignIn(() => Promise.resolve(true), adapter);

    // No pages.error in this config, so Auth.js sends the error to its own sign-in page.
    expect(callback.headers.get('location')).toBe(`${ORIGIN}/api/auth/signin?error=OAuthAccountNotLinked`);
    expect(adapter.linkAccount).not.toHaveBeenCalled();
    expect(startsSession(callback)).toBe(false);
  });
});
