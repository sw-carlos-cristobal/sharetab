import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockDb = {
  $queryRaw: vi.fn(),
  user: { findMany: vi.fn() },
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }),
  parsePositiveInt: (_value: string | undefined, fallback: number) => fallback,
}));
vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn().mockResolvedValue(true) },
}));

const { authorizePasswordLogin, loginRateLimitKey } = await import('./password-login');
const { checkRateLimit } = await import('@/server/lib/rate-limit');
const { logger } = await import('@/server/lib/logger');

const BOB = {
  id: 'bob',
  name: 'Bob',
  email: 'Bob@example.com',
  image: null,
  locale: 'en',
  passwordHash: 'hash',
  passwordChangedAt: new Date('2026-10-01T00:00:00Z') as Date | null,
};

function usersFound(rows: (typeof BOB)[]) {
  mockDb.$queryRaw.mockResolvedValue(rows.map(({ id }) => ({ id })));
  mockDb.user.findMany.mockResolvedValue(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authorizePasswordLogin', () => {
  test('signs in regardless of the email case typed', async () => {
    usersFound([BOB]);
    await expect(
      authorizePasswordLogin({ email: 'bob@EXAMPLE.com', password: 'password123' }, new Headers()),
    ).resolves.toStrictEqual({
      id: 'bob',
      name: 'Bob',
      email: 'Bob@example.com',
      image: null,
      locale: 'en',
      // The password version read with the hash it verified: the session is stamped with it (#397)
      passwordChangedAt: new Date('2026-10-01T00:00:00Z'),
    });
  });

  test('passes a password that never changed as version null', async () => {
    usersFound([{ ...BOB, passwordChangedAt: null }]);
    await expect(
      authorizePasswordLogin({ email: 'bob@example.com', password: 'password123' }, new Headers()),
    ).resolves.toMatchObject({ passwordChangedAt: null });
  });

  test('case variants share one per-email rate-limit bucket', async () => {
    usersFound([BOB]);
    await authorizePasswordLogin({ email: 'BOB@example.com', password: 'password123' }, new Headers());
    // AUTH_RATE_LIMIT_MAX's default in 15 minutes, the window Settings guesses share
    expect(checkRateLimit).toHaveBeenCalledWith('login:bob@example.com', 5, 15 * 60 * 1000);
    // The key a password reset clears
    expect(loginRateLimitKey('Bob@Example.com')).toBe('login:bob@example.com');
  });

  test('returns null and logs when several accounts match ignoring case', async () => {
    usersFound([BOB, { ...BOB, id: 'bob2', email: 'BOB@example.com' }]);
    await expect(
      authorizePasswordLogin({ email: 'bob@example.com', password: 'password123' }, new Headers()),
    ).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('auth.login_failed', {
      email: 'bob@example.com',
      reason: 'ambiguous_email',
    });
  });

  test('other lookup failures still throw', async () => {
    mockDb.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(
      authorizePasswordLogin({ email: 'bob@example.com', password: 'password123' }, new Headers()),
    ).rejects.toThrow('db down');
  });

  test('returns null for an unknown email or malformed credentials', async () => {
    usersFound([]);
    await expect(
      authorizePasswordLogin({ email: 'nobody@example.com', password: 'password123' }, new Headers()),
    ).resolves.toBeNull();
    await expect(authorizePasswordLogin({ email: 'not-an-email', password: 'x' }, new Headers())).resolves.toBeNull();
  });
});
