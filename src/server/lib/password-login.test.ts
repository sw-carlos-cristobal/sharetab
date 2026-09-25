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

const { authorizePasswordLogin } = await import('./password-login');
const { checkRateLimit } = await import('@/server/lib/rate-limit');
const { logger } = await import('@/server/lib/logger');

const BOB = {
  id: 'bob',
  name: 'Bob',
  email: 'Bob@example.com',
  image: null,
  locale: 'en',
  passwordHash: 'hash',
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
    ).resolves.toEqual({ id: 'bob', name: 'Bob', email: 'Bob@example.com', image: null, locale: 'en' });
  });

  test('case variants share one per-email rate-limit bucket', async () => {
    usersFound([BOB]);
    await authorizePasswordLogin({ email: 'BOB@example.com', password: 'password123' }, new Headers());
    expect(checkRateLimit).toHaveBeenCalledWith('login:bob@example.com', expect.any(Number), expect.any(Number));
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
