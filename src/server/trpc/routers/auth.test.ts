import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('hashed'), compare: vi.fn() },
}));

const mockDb = {
  systemSetting: { findUnique: vi.fn() },
  systemInvite: { findUnique: vi.fn() },
  user: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const OIDC_ENV = {
  OIDC_ISSUER: 'https://auth.example.com/application/o/sharetab/',
  OIDC_CLIENT_ID: 'sharetab',
  OIDC_CLIENT_SECRET: 's3cret',
  OIDC_DISPLAY_NAME: 'Authentik',
};

async function caller(session: { user: { id: string } } | null = null) {
  const { authRouter } = await import('./auth');
  const ctx = { session, db: mockDb, headers: new Headers(), impersonating: null };
  return authRouter.createCaller(ctx as unknown as Parameters<typeof authRouter.createCaller>[0]);
}

function stubEnv(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Start from a clean auth env regardless of the developer's .env
  for (const key of [
    ...Object.keys(OIDC_ENV),
    'DISABLE_PASSWORD_LOGIN',
    'EMAIL_SERVER_HOST',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ]) {
    vi.stubEnv(key, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('auth.getLoginOptions', () => {
  test('defaults to password login only', async () => {
    const api = await caller();
    expect(await api.getLoginOptions()).toEqual({ passwordLogin: true, magicLink: false, oidc: null });
  });

  test('exposes the OIDC button name but never the issuer or secret', async () => {
    stubEnv({ ...OIDC_ENV, EMAIL_SERVER_HOST: 'smtp.example.com', DISABLE_PASSWORD_LOGIN: 'true' });
    const api = await caller();
    const options = await api.getLoginOptions();
    expect(options).toEqual({ passwordLogin: false, magicLink: true, oidc: { name: 'Authentik' } });
    expect(JSON.stringify(options)).not.toContain('s3cret');
    expect(JSON.stringify(options)).not.toContain('auth.example.com');
  });
});

describe('password login disabled', () => {
  beforeEach(() => {
    stubEnv({ ...OIDC_ENV, DISABLE_PASSWORD_LOGIN: 'true' });
  });

  test('register is refused before touching the database', async () => {
    const api = await caller();
    await expect(
      api.register({ name: 'Alice', email: 'alice@example.com', password: 'password123' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Registration is currently closed.' });
    expect(mockDb.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test('getRegistrationMode reports closed regardless of the admin setting', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: 'registrationMode', value: 'open' });
    const api = await caller();
    expect(await api.getRegistrationMode()).toEqual({ mode: 'closed' });
  });
});

describe('auth.register duplicate check', () => {
  test('refuses an email that differs from an existing one only by case', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue(null);
    mockDb.$queryRaw.mockResolvedValue([{ id: 'bob' }]);
    mockDb.user.findMany.mockResolvedValue([{ id: 'bob', email: 'Bob@example.com' }]);
    const api = await caller();
    await expect(
      api.register({ name: 'Mallory', email: 'bob@example.com', password: 'password123' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

describe('password login enabled', () => {
  test('getRegistrationMode returns the admin setting', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: 'registrationMode', value: 'invite-only' });
    const api = await caller();
    expect(await api.getRegistrationMode()).toEqual({ mode: 'invite-only' });
  });
});

describe('auth.getProfile', () => {
  test('reports whether the user has a password without returning the hash', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      name: 'Alice',
      email: 'alice@example.com',
      venmoUsername: null,
      locale: 'en',
      defaultCurrency: 'USD',
      passwordHash: 'hashed',
    });
    const api = await caller({ user: { id: 'user-1' } });
    const profile = await api.getProfile();
    expect(profile.hasPassword).toBe(true);
    expect(profile).not.toHaveProperty('passwordHash');
  });

  test('hasPassword is false for OIDC-only users', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      name: 'Alice',
      email: 'alice@example.com',
      venmoUsername: null,
      locale: 'en',
      defaultCurrency: 'USD',
      passwordHash: null,
    });
    const api = await caller({ user: { id: 'user-1' } });
    expect((await api.getProfile()).hasPassword).toBe(false);
  });
});
