import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The Auth.js wiring in auth.ts: which providers it registers, how its signIn
// callback hands OIDC and Google sign-ins to their policies (tested in their
// own files), and which sign-ins it logs.
const { nextAuth, authMock, google, logger, checkGoogleSignIn, checkOidcSignIn, db } = vi.hoisted(() => ({
  nextAuth: vi.fn(),
  authMock: vi.fn(),
  google: vi.fn((options: unknown) => ({ id: 'google', options })),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  checkGoogleSignIn: vi.fn(),
  checkOidcSignIn: vi.fn(),
  db: { user: { findUnique: vi.fn() } },
}));
vi.mock('next-auth', () => ({ default: nextAuth }));
vi.mock('@auth/prisma-adapter', () => ({ PrismaAdapter: vi.fn(() => ({})) }));
vi.mock('next-auth/providers/credentials', () => ({ default: vi.fn(() => ({ id: 'credentials' })) }));
vi.mock('next-auth/providers/google', () => ({ default: google }));
vi.mock('next-auth/providers/nodemailer', () => ({ default: vi.fn(() => ({ id: 'nodemailer' })) }));
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

interface CapturedConfig {
  callbacks: { signIn: (params: Record<string, unknown>) => Promise<boolean | string> };
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
];

async function loadAuth(env: Record<string, string> = {}): Promise<CapturedConfig> {
  for (const key of AUTH_ENV) vi.stubEnv(key, '');
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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Google provider registration', () => {
  test('registers Google under the id the signIn callback checks, with its account chooser', async () => {
    await loadAuth(GOOGLE_ENV);
    expect(google).toHaveBeenCalledWith({
      id: 'google',
      clientId: 'id.apps.googleusercontent.com',
      clientSecret: 'g-secret',
      authorization: { params: { prompt: 'select_account' } },
      profile: expect.any(Function),
    });
  });

  test("maps Google's profile like an OIDC one: name capped at 100 characters, web image URLs only", async () => {
    await loadAuth(GOOGLE_ENV);
    const { profile } = google.mock.calls[0]?.[0] as { profile: (claims: Record<string, unknown>) => unknown };
    expect(
      profile({ sub: 'g-1', name: 'A'.repeat(150), email: 'Alice@Gmail.com', picture: 'javascript:alert(1)' }),
    ).toEqual({ id: 'g-1', name: 'A'.repeat(100), email: 'alice@gmail.com', image: null });
  });

  test('registers no Google provider without both variables', async () => {
    await loadAuth({ GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com' });
    expect(google).not.toHaveBeenCalled();
  });
});

describe('signIn callback', () => {
  const googleSignIn = {
    user: { email: 'alice@gmail.com' },
    account: { provider: 'google', providerAccountId: 'g-1' },
    profile: { sub: 'g-1', email: 'alice@gmail.com', email_verified: true },
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

  test('logs nothing for password sign-ins', async () => {
    const config = await loadAuth();
    config.events.signIn({ user: { id: 'u1' }, account: { provider: 'credentials' } });
    expect(logger.info).not.toHaveBeenCalled();
  });
});
