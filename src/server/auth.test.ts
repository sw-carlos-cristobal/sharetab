import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The Auth.js wiring in auth.ts: which providers it registers, how its signIn
// callback hands OIDC and Google sign-ins to their policies (tested in their
// own files), which sign-ins it logs, the jwt callback's profile refresh and password version
// check (#397), and the session-cookie fallback the policies get.
const { nextAuth, authMock, google, nodemailer, getToken, logger, checkGoogleSignIn, checkOidcSignIn, db } = vi.hoisted(
  () => ({
    nextAuth: vi.fn(),
    authMock: vi.fn(),
    google: vi.fn((options: unknown) => ({ id: 'google', options })),
    nodemailer: vi.fn((options: unknown) => ({ id: 'nodemailer', options })),
    getToken: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    checkGoogleSignIn: vi.fn(),
    checkOidcSignIn: vi.fn(),
    db: { user: { findUnique: vi.fn() } },
  }),
);
vi.mock('next-auth', () => ({ default: nextAuth }));
vi.mock('@auth/prisma-adapter', () => ({ PrismaAdapter: vi.fn(() => ({})) }));
vi.mock('next-auth/providers/credentials', () => ({ default: vi.fn(() => ({ id: 'credentials' })) }));
vi.mock('next-auth/providers/google', () => ({ default: google }));
vi.mock('next-auth/providers/nodemailer', () => ({ default: nodemailer }));
vi.mock('next-auth/jwt', () => ({ getToken }));
const requestHeaders = vi.hoisted(() => ({ value: new Headers() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => requestHeaders.value) }));
vi.mock('bcryptjs', () => ({ default: { compare: vi.fn() } }));
vi.mock('./db', () => ({ db }));
vi.mock('./lib/logger', () => ({ logger }));
vi.mock('./lib/google-sign-in', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/google-sign-in')>()),
  checkGoogleSignIn,
}));
vi.mock('./lib/oidc-sign-in', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/oidc-sign-in')>()),
  checkOidcSignIn,
}));

interface CapturedProvider {
  id: string;
  profile?: (claims: Record<string, unknown>) => unknown;
  [key: string]: unknown;
}

interface CapturedConfig {
  providers: CapturedProvider[];
  callbacks: {
    signIn: (params: Record<string, unknown>) => Promise<boolean | string>;
    jwt: (params: {
      token: Record<string, unknown>;
      user?: Record<string, unknown>;
    }) => Promise<Record<string, unknown> | null>;
  };
  events: { signIn: (message: Record<string, unknown>) => void };
}

// Every variable parseAuthConfig or the callbacks read, blanked so the
// developer's .env can't leak in.
const AUTH_ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_DISPLAY_NAME',
  'OIDC_AUTO_REGISTER',
  'OIDC_ALLOW_EMAIL_LINKING',
  'OIDC_TOKEN_AUTH_METHOD',
  'EMAIL_SERVER_HOST',
  'DISABLE_PASSWORD_LOGIN',
  'ADMIN_EMAIL',
  'AUTH_SECRET',
  'NEXTAUTH_SECRET',
  'AUTH_SECRET_1',
  'AUTH_SECRET_2',
  'AUTH_SECRET_3',
  'AUTH_URL',
  'NEXTAUTH_URL',
];

async function loadAuth(env: Record<string, string> = {}): Promise<CapturedConfig> {
  // Unset, not empty: Auth.js treats an empty AUTH_URL or AUTH_SECRET as set
  for (const key of AUTH_ENV) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  let config: CapturedConfig | undefined;
  nextAuth.mockImplementation((c: CapturedConfig) => {
    config = c;
    return { handlers: {}, auth: authMock, signIn: vi.fn(), signOut: vi.fn() };
  });
  await import('./auth');
  if (!config) throw new Error('NextAuth was not called');
  return config;
}

const GOOGLE_ENV = { GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'g-secret' };
const OIDC_ENV = {
  OIDC_ISSUER: 'https://auth.example.com/application/o/sharetab/',
  OIDC_CLIENT_ID: 'sharetab',
  OIDC_CLIENT_SECRET: 's3cret',
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so a test's rejection can't reach the next one.
  authMock.mockResolvedValue(null);
  getToken.mockResolvedValue(null);
  requestHeaders.value = new Headers();
  checkGoogleSignIn.mockResolvedValue(true);
  checkOidcSignIn.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Google provider registration', () => {
  test('registers Google under the id the signIn callback checks, with its account chooser', async () => {
    const config = await loadAuth(GOOGLE_ENV);
    expect(config.providers.map((p) => p.id)).toContain('google');
    expect(google).toHaveBeenCalledWith({
      id: 'google',
      clientId: 'id.apps.googleusercontent.com',
      clientSecret: 'g-secret',
      authorization: { params: { prompt: 'select_account' } },
    });
  });

  test('registers no Google provider without both variables, and logs which one is missing', async () => {
    const config = await loadAuth({ GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com' });
    expect(config.providers.map((p) => p.id)).not.toContain('google');
    expect(google).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('auth.config', {
      warning: expect.stringContaining('GOOGLE_CLIENT_SECRET') as unknown,
    });
  });
});

describe('other providers', () => {
  test('registers the password form unless DISABLE_PASSWORD_LOGIN turns it off', async () => {
    expect((await loadAuth()).providers.map((p) => p.id)).toContain('credentials');
    const ssoOnly = await loadAuth({ ...OIDC_ENV, DISABLE_PASSWORD_LOGIN: 'true' });
    expect(ssoOnly.providers.map((p) => p.id)).not.toContain('credentials');
  });

  test('registers OIDC with UserInfo profiles, its email-linking setting and the profile caps', async () => {
    const oidcOf = (config: CapturedConfig) => config.providers.find((p) => p.id === 'oidc');
    const oidc = oidcOf(await loadAuth({ ...OIDC_ENV, OIDC_DISPLAY_NAME: 'Authentik' }));
    expect(oidc).toMatchObject({
      type: 'oidc',
      name: 'Authentik',
      issuer: OIDC_ENV.OIDC_ISSUER,
      clientId: OIDC_ENV.OIDC_CLIENT_ID,
      clientSecret: OIDC_ENV.OIDC_CLIENT_SECRET,
      idToken: false,
      allowDangerousEmailAccountLinking: false,
      client: { token_endpoint_auth_method: 'client_secret_basic' },
    });
    expect(oidc?.profile?.({ sub: 's', name: 'A'.repeat(150), picture: 'javascript:alert(1)' })).toMatchObject({
      name: 'A'.repeat(100),
      image: null,
    });
    const linking = oidcOf(await loadAuth({ ...OIDC_ENV, OIDC_ALLOW_EMAIL_LINKING: 'true' }));
    expect(linking).toMatchObject({ allowDangerousEmailAccountLinking: true });
  });
});

describe('signIn callback', () => {
  const googleSignIn = {
    user: { email: 'alice@gmail.com' },
    account: { provider: 'google', providerAccountId: 'g-1' },
    profile: { sub: 'g-1', email: 'alice@gmail.com', email_verified: true },
  };
  const oidcSignIn = {
    user: { email: 'alice@example.com' },
    account: { provider: 'oidc', providerAccountId: 'sub-1' },
    profile: { sub: 'sub-1' },
  };

  test("hands a Google sign-in to the Google policy with the browser's session, the ID token's claims and ADMIN_EMAIL", async () => {
    const config = await loadAuth({ ...GOOGLE_ENV, ADMIN_EMAIL: 'admin@example.com' });
    authMock.mockResolvedValue({ user: { id: 'u9' } });
    checkGoogleSignIn.mockResolvedValue('/login?error=GoogleSessionActive');

    expect(await config.callbacks.signIn(googleSignIn)).toBe('/login?error=GoogleSessionActive');
    expect(checkGoogleSignIn).toHaveBeenCalledWith(db, {
      providerAccountId: 'g-1',
      email: 'alice@gmail.com',
      claims: googleSignIn.profile,
      sessionUserId: 'u9',
      adminEmail: 'admin@example.com',
    });
    expect(checkOidcSignIn).not.toHaveBeenCalled();
  });

  test.each(['google', 'oidc'] as const)(
    'fails closed: an error in the %s policy fails the sign-in (Auth.js refuses it)',
    async (provider) => {
      const config = await loadAuth({ ...GOOGLE_ENV, ...OIDC_ENV });
      authMock.mockResolvedValue(null);
      checkGoogleSignIn.mockRejectedValue(new Error('connection lost'));
      checkOidcSignIn.mockRejectedValue(new Error('connection lost'));
      const signIn = provider === 'google' ? googleSignIn : oidcSignIn;
      await expect(config.callbacks.signIn(signIn)).rejects.toThrow('connection lost');
    },
  );

  test.each(['google', 'oidc'] as const)(
    'fails closed: an error reading the session fails the %s sign-in, rather than seeing nobody signed in',
    async (provider) => {
      const config = await loadAuth({ ...GOOGLE_ENV, ...OIDC_ENV });
      authMock.mockRejectedValue(new Error('session read failed'));
      const signIn = provider === 'google' ? googleSignIn : oidcSignIn;
      await expect(config.callbacks.signIn(signIn)).rejects.toThrow('session read failed');
      expect(checkGoogleSignIn).not.toHaveBeenCalled();
      expect(checkOidcSignIn).not.toHaveBeenCalled();
    },
  );

  describe('a session the jwt callback ended (#397): the cookie is read as Auth.js reads it', () => {
    type TokenParams = { req: { headers: Headers }; secret: string[]; secureCookie: boolean };
    // A cookie only getToken can read: auth() reports nobody for an ended session
    function staleCookie(name: string, sub = 'u7') {
      getToken.mockImplementation(async ({ req, secureCookie }: TokenParams) => {
        const cookieName = secureCookie ? '__Secure-authjs.session-token' : 'authjs.session-token';
        return req.headers.get('cookie')?.includes(`${cookieName}=`) && cookieName === name ? { sub } : null;
      });
    }

    test.each(['google', 'oidc'] as const)('the %s policy still sees its user', async (provider) => {
      const config = await loadAuth({
        ...GOOGLE_ENV,
        ...OIDC_ENV,
        AUTH_SECRET: 'test-secret',
        NEXTAUTH_URL: 'http://sharetab.lan:3000',
      });
      requestHeaders.value = new Headers({ cookie: 'authjs.session-token=stale' });
      staleCookie('authjs.session-token');

      await config.callbacks.signIn(provider === 'google' ? googleSignIn : oidcSignIn);

      const check = provider === 'google' ? checkGoogleSignIn : checkOidcSignIn;
      expect(check).toHaveBeenCalledWith(db, expect.objectContaining({ sessionUserId: 'u7' }));
      expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ secret: ['test-secret'], secureCookie: false }));
    });

    test('over https it reads only the secure cookie, the one Auth.js uses there', async () => {
      const config = await loadAuth({
        ...GOOGLE_ENV,
        AUTH_SECRET: 'test-secret',
        NEXTAUTH_URL: 'https://tabs.example.com',
      });
      // A plain cookie left from before the move to https isn't a session Auth.js would see
      requestHeaders.value = new Headers({ cookie: 'authjs.session-token=left-over' });
      staleCookie('authjs.session-token');

      await config.callbacks.signIn(googleSignIn);

      expect(checkGoogleSignIn).toHaveBeenCalledWith(db, expect.objectContaining({ sessionUserId: null }));
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ secureCookie: true }));
    });

    test('with no URL configured it goes by the forwarded protocol', async () => {
      const config = await loadAuth({ ...GOOGLE_ENV, AUTH_SECRET: 'test-secret' });
      requestHeaders.value = new Headers({
        cookie: '__Secure-authjs.session-token=stale',
        'x-forwarded-proto': 'https',
      });
      staleCookie('__Secure-authjs.session-token');

      await config.callbacks.signIn(googleSignIn);

      expect(checkGoogleSignIn).toHaveBeenCalledWith(db, expect.objectContaining({ sessionUserId: 'u7' }));
    });

    test('reads only the cookie, never an Authorization header, as Auth.js does', async () => {
      const config = await loadAuth({ ...GOOGLE_ENV, AUTH_SECRET: 'test-secret' });
      requestHeaders.value = new Headers({ cookie: 'other=1', authorization: 'Bearer some-token' });

      await config.callbacks.signIn(googleSignIn);

      const { req } = getToken.mock.calls[0]![0] as TokenParams;
      expect(req.headers.get('authorization')).toBeNull();
      expect(req.headers.get('cookie')).toBe('other=1');
    });

    test('uses the secrets Auth.js uses: AUTH_SECRET, else NEXTAUTH_SECRET, else AUTH_SECRET_3..1', async () => {
      let config = await loadAuth({ ...GOOGLE_ENV, NEXTAUTH_SECRET: 'legacy-secret' });
      await config.callbacks.signIn(googleSignIn);
      expect(getToken).toHaveBeenLastCalledWith(expect.objectContaining({ secret: ['legacy-secret'] }));

      config = await loadAuth({ ...GOOGLE_ENV, AUTH_SECRET_1: 'one', AUTH_SECRET_3: 'three' });
      await config.callbacks.signIn(googleSignIn);
      expect(getToken).toHaveBeenLastCalledWith(expect.objectContaining({ secret: ['three', 'one'] }));
    });
  });

  test('passes a null email to the Google policy when Auth.js has none', async () => {
    const config = await loadAuth(GOOGLE_ENV);
    authMock.mockResolvedValue(null);
    checkGoogleSignIn.mockResolvedValue('/login?error=GoogleEmailUnverified');

    await config.callbacks.signIn({ ...googleSignIn, user: {} });
    expect(checkGoogleSignIn).toHaveBeenCalledWith(db, expect.objectContaining({ email: null }));
  });

  test('passes no session user to the Google policy when nobody is signed in', async () => {
    const config = await loadAuth(GOOGLE_ENV);
    authMock.mockResolvedValue(null);
    checkGoogleSignIn.mockResolvedValue(true);

    expect(await config.callbacks.signIn(googleSignIn)).toBe(true);
    expect(checkGoogleSignIn).toHaveBeenCalledWith(db, expect.objectContaining({ sessionUserId: null }));
  });

  test('hands an OIDC sign-in to the OIDC policy with the session, the UserInfo claims and the OIDC settings', async () => {
    const config = await loadAuth({ ...OIDC_ENV, OIDC_ALLOW_EMAIL_LINKING: 'true' });
    authMock.mockResolvedValue({ user: { id: 'u9' } });
    checkOidcSignIn.mockResolvedValue('/login?error=OidcSessionActive');

    expect(
      await config.callbacks.signIn({
        user: { email: 'alice@example.com' },
        account: { provider: 'oidc', providerAccountId: 'sub-1' },
        profile: { sub: 'sub-1', email_verified: 'false' },
      }),
    ).toBe('/login?error=OidcSessionActive');
    expect(checkOidcSignIn).toHaveBeenCalledWith(db, {
      providerAccountId: 'sub-1',
      email: 'alice@example.com',
      emailVerified: false,
      sessionUserId: 'u9',
      autoRegister: true,
      allowEmailLinking: true,
      passwordLogin: true,
    });
    expect(checkGoogleSignIn).not.toHaveBeenCalled();
  });

  test('tells the OIDC policy when password login is off', async () => {
    const config = await loadAuth({ ...OIDC_ENV, DISABLE_PASSWORD_LOGIN: 'true', OIDC_ALLOW_EMAIL_LINKING: 'true' });
    authMock.mockResolvedValue(null);
    checkOidcSignIn.mockResolvedValue(true);

    await config.callbacks.signIn({
      user: { email: 'alice@example.com' },
      account: { provider: 'oidc', providerAccountId: 'sub-1' },
      profile: { sub: 'sub-1' },
    });
    expect(checkOidcSignIn).toHaveBeenCalledWith(db, expect.objectContaining({ passwordLogin: false }));
  });

  test("passes the OIDC settings' defaults, and OIDC_AUTO_REGISTER=false", async () => {
    authMock.mockResolvedValue(null);
    checkOidcSignIn.mockResolvedValue(true);
    const oidcSignIn = {
      user: { email: 'alice@example.com' },
      account: { provider: 'oidc', providerAccountId: 'sub-1' },
      profile: { sub: 'sub-1' },
    };

    await (await loadAuth(OIDC_ENV)).callbacks.signIn(oidcSignIn);
    expect(checkOidcSignIn).toHaveBeenLastCalledWith(
      db,
      expect.objectContaining({ allowEmailLinking: false, autoRegister: true }),
    );

    await (await loadAuth({ ...OIDC_ENV, OIDC_AUTO_REGISTER: 'false' })).callbacks.signIn(oidcSignIn);
    expect(checkOidcSignIn).toHaveBeenLastCalledWith(
      db,
      expect.objectContaining({ allowEmailLinking: false, autoRegister: false }),
    );
  });

  test('lets an "oidc" sign-in through untouched when OIDC is not configured (no such provider)', async () => {
    const config = await loadAuth(GOOGLE_ENV);
    expect(
      await config.callbacks.signIn({ user: { id: 'u1' }, account: { provider: 'oidc', providerAccountId: 's' } }),
    ).toBe(true);
    expect(checkOidcSignIn).not.toHaveBeenCalled();
  });

  test('leaves password and magic-link sign-ins to their providers', async () => {
    const config = await loadAuth({ ...GOOGLE_ENV, ...OIDC_ENV });
    for (const provider of ['credentials', 'nodemailer']) {
      expect(
        await config.callbacks.signIn({ user: { id: 'u1' }, account: { provider, providerAccountId: 'u1' } }),
      ).toBe(true);
    }
    expect(checkGoogleSignIn).not.toHaveBeenCalled();
    expect(checkOidcSignIn).not.toHaveBeenCalled();
    expect(authMock).not.toHaveBeenCalled();
  });
});

describe('signIn event', () => {
  test.each([
    ['google', 'auth.google_login'],
    ['oidc', 'auth.oidc_login'],
  ])('logs %s sign-ins as %s, new accounts included', async (provider, event) => {
    const config = await loadAuth({ ...GOOGLE_ENV, ...OIDC_ENV });
    config.events.signIn({ user: { id: 'u1', email: 'alice@gmail.com' }, account: { provider }, isNewUser: true });
    expect(logger.info).toHaveBeenCalledWith(event, { userId: 'u1', email: 'alice@gmail.com', isNewUser: true });
  });

  test('logs isNewUser false when Auth.js leaves it out', async () => {
    const config = await loadAuth(GOOGLE_ENV);
    config.events.signIn({ user: { id: 'u1', email: 'alice@gmail.com' }, account: { provider: 'google' } });
    expect(logger.info).toHaveBeenCalledWith('auth.google_login', {
      userId: 'u1',
      email: 'alice@gmail.com',
      isNewUser: false,
    });
  });

  test('logs nothing for password sign-ins', async () => {
    const config = await loadAuth();
    config.events.signIn({ user: { id: 'u1' }, account: { provider: 'credentials' } });
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('magic link provider', () => {
  test('sends with the shared SMTP settings and sender', async () => {
    await loadAuth({
      EMAIL_SERVER_HOST: 'smtp.example.com',
      EMAIL_SERVER_PORT: '465',
      EMAIL_FROM: 'Tabs <t@example.com>',
    });
    const { smtpOptions, mailFrom } = await import('./lib/mailer');
    expect(nodemailer).toHaveBeenCalledWith({ server: smtpOptions(), from: mailFrom() });
    expect(smtpOptions()).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true });
  });
});

describe('jwt callback', () => {
  test("refreshes the signed-in user's name and locale from the database", async () => {
    const config = await loadAuth();
    db.user.findUnique.mockResolvedValue({ name: 'New Name', locale: 'de' });
    expect(await config.callbacks.jwt({ token: { id: 'u1', name: 'Old', locale: 'en' } })).toMatchObject({
      id: 'u1',
      name: 'New Name',
      locale: 'de',
    });
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { name: true, locale: true, passwordChangedAt: true },
    });
  });

  test("puts the user's id, name, locale and password version on the token at sign-in", async () => {
    const config = await loadAuth();
    db.user.findUnique.mockResolvedValue({ name: 'Ada', locale: 'de', passwordChangedAt: new Date(2_000) });
    const token = await config.callbacks.jwt({
      token: {},
      user: { id: 'u1', name: 'Ada', locale: 'de', passwordChangedAt: new Date(2_000) },
    });
    expect(token).toMatchObject({ id: 'u1', name: 'Ada', locale: 'de', passwordStamp: 2_000 });
  });

  test('a user whose password never changed gets version 0', async () => {
    const config = await loadAuth();
    db.user.findUnique.mockResolvedValue({ name: 'Ada', locale: 'de', passwordChangedAt: null });
    expect(
      await config.callbacks.jwt({ token: {}, user: { id: 'u1', name: 'Ada', locale: 'de', passwordChangedAt: null } }),
    ).toMatchObject({ passwordStamp: 0 });
  });

  test('ends a session signed in under an earlier password (#397)', async () => {
    const config = await loadAuth();
    db.user.findUnique.mockResolvedValue({ name: 'Ada', locale: 'en', passwordChangedAt: new Date(2_000) });
    expect(await config.callbacks.jwt({ token: { id: 'u1', passwordStamp: 1_000 } })).toBeNull();
  });

  test('ends a sign-in whose password was replaced while it was being checked', async () => {
    // Password login read the user before a reset committed; the refresh reads the new version
    const config = await loadAuth();
    db.user.findUnique.mockResolvedValue({ name: 'Ada', locale: 'en', passwordChangedAt: new Date(2_000) });
    expect(
      await config.callbacks.jwt({ token: {}, user: { id: 'u1', name: 'Ada', passwordChangedAt: null } }),
    ).toBeNull();
  });

  test('a provider that passes no password version gets the current one, and stays signed in', async () => {
    const config = await loadAuth();
    db.user.findUnique.mockResolvedValue({ name: 'Ada', locale: 'en', passwordChangedAt: new Date(2_000) });
    const token = await config.callbacks.jwt({ token: {}, user: { id: 'u1', name: 'Ada' } });
    expect(token).toMatchObject({ id: 'u1', passwordStamp: 2_000 });
  });

  test('ends a session stamped with a version the database no longer has, newer or older', async () => {
    const config = await loadAuth();
    db.user.findUnique.mockResolvedValue({ name: 'Ada', locale: 'en', passwordChangedAt: new Date(2_000) });
    expect(await config.callbacks.jwt({ token: { id: 'u1', passwordStamp: 3_000 } })).toBeNull();
  });

  test('keeps a session signed in under the current password', async () => {
    const config = await loadAuth();
    db.user.findUnique.mockResolvedValue({ name: 'Ada', locale: 'en', passwordChangedAt: new Date(2_000) });
    expect(await config.callbacks.jwt({ token: { id: 'u1', passwordStamp: 2_000 } })).toMatchObject({ id: 'u1' });
  });

  test('a session from before password versions were recorded ends only once the password changes', async () => {
    const config = await loadAuth();
    db.user.findUnique.mockResolvedValue({ name: 'Ada', locale: 'en', passwordChangedAt: null });
    expect(await config.callbacks.jwt({ token: { id: 'u1' } })).toMatchObject({ id: 'u1' });
    db.user.findUnique.mockResolvedValue({ name: 'Ada', locale: 'en', passwordChangedAt: new Date(2_000) });
    expect(await config.callbacks.jwt({ token: { id: 'u1' } })).toBeNull();
  });

  test('keeps the session when the refresh fails, so auth() still reports who is signed in', async () => {
    const config = await loadAuth();
    db.user.findUnique.mockRejectedValue(new Error('pool timeout'));
    expect(await config.callbacks.jwt({ token: { id: 'u1', name: 'Old', locale: 'en' } })).toEqual({
      id: 'u1',
      name: 'Old',
      locale: 'en',
    });
    expect(logger.warn).toHaveBeenCalledWith('auth.session_refresh_failed', { error: 'Error' });
  });
});
