import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDb = {
  $queryRaw: vi.fn(),
  user: { findMany: vi.fn() },
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The right password for every account in these tests
const RIGHT = 'password123';
const WRONG = 'wrong-password';
vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn(async (password: string) => password === 'password123') },
}));

const { LoginRateLimited, authorizePasswordLogin, loginRateLimitKey } = await import('./password-login');
const bcrypt = (await import('bcryptjs')).default;
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

// The rate limiter is the real one, whose counters live as long as the module: each test uses
// addresses and client IPs of its own.
let unique = 0;
function newEmail() {
  unique += 1;
  return `user${unique}@example.com`;
}
function fromIp() {
  unique += 1;
  return new Headers({ 'x-real-ip': `203.0.113.${unique % 250}`, 'x-forwarded-for': `10.0.${unique}.1` });
}

function signIn(email: string, password: string, headers = new Headers()) {
  return authorizePasswordLogin({ email, password }, headers);
}

const WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMITED = { name: 'LoginRateLimited', retryAfterMs: expect.any(Number) };

beforeEach(() => {
  vi.clearAllMocks();
  usersFound([BOB]);
  vi.stubEnv('AUTH_RATE_LIMIT_MAX', '5');
  vi.stubEnv('AUTH_IP_RATE_LIMIT_MAX', '30');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('authorizePasswordLogin', () => {
  test('signs in regardless of the email case typed', async () => {
    await expect(signIn('bob@EXAMPLE.com', RIGHT)).resolves.toStrictEqual({
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
    await expect(signIn(newEmail(), RIGHT)).resolves.toMatchObject({ passwordChangedAt: null });
  });

  test('returns null and logs when several accounts match ignoring case', async () => {
    usersFound([BOB, { ...BOB, id: 'bob2', email: 'BOB@example.com' }]);
    await expect(signIn('bob@example.com', RIGHT)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('auth.login_failed', {
      email: 'bob@example.com',
      reason: 'ambiguous_email',
    });
  });

  test('other lookup failures still throw', async () => {
    mockDb.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(signIn(newEmail(), RIGHT)).rejects.toThrow('db down');
  });

  test('returns null for an unknown email or malformed credentials', async () => {
    usersFound([]);
    await expect(signIn('nobody@example.com', RIGHT)).resolves.toBeNull();
    await expect(authorizePasswordLogin({ email: 'not-an-email', password: 'x' }, new Headers())).resolves.toBeNull();
  });
});

describe('the per-address login limit (#401)', () => {
  test('any number of successful sign-ins never reaches it', async () => {
    const email = newEmail();
    for (let i = 0; i < 20; i++) {
      await expect(signIn(email, RIGHT), `sign-in ${i + 1}`).resolves.toMatchObject({ id: 'bob' });
    }
  });

  test('after AUTH_RATE_LIMIT_MAX wrong passwords, even the right one is refused as rate limited', async () => {
    const email = newEmail();
    for (let i = 0; i < 5; i++) {
      await expect(signIn(email, WRONG)).resolves.toBeNull();
    }
    const refused = signIn(email, RIGHT);
    await expect(refused).rejects.toBeInstanceOf(LoginRateLimited);
    // Most of the 15-minute window is left
    await expect(refused).rejects.toMatchObject({ retryAfterMs: expect.closeTo(WINDOW_MS, -3) });
    // Refused before the password is checked
    expect(bcrypt.compare).toHaveBeenCalledTimes(5);
    expect(logger.warn).toHaveBeenCalledWith('auth.rate_limited', { email });
  });

  test('a successful sign-in clears the wrong passwords before it', async () => {
    const email = newEmail();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) {
        await expect(signIn(email, WRONG)).resolves.toBeNull();
      }
      await expect(signIn(email, RIGHT), `round ${round + 1}`).resolves.toMatchObject({ id: 'bob' });
    }
  });

  test('the refusal says how long is left, and the limit lifts when the window ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    const email = newEmail();
    for (let i = 0; i < 5; i++) await signIn(email, WRONG);

    vi.setSystemTime(new Date('2026-11-11T12:05:30Z'));
    await expect(signIn(email, RIGHT)).rejects.toMatchObject({ retryAfterMs: WINDOW_MS - 330_000 });

    vi.setSystemTime(new Date('2026-11-11T12:15:01Z'));
    await expect(signIn(email, RIGHT)).resolves.toMatchObject({ id: 'bob' });
  });

  test('case variants of an address share it', async () => {
    const email = newEmail();
    for (const typed of [email, email.toUpperCase(), email, email.toUpperCase(), email]) {
      await expect(signIn(typed, WRONG)).resolves.toBeNull();
    }
    await expect(signIn(email.toUpperCase(), RIGHT)).rejects.toMatchObject(RATE_LIMITED);
    // The key a password reset clears
    expect(loginRateLimitKey('Bob@Example.com')).toBe('login:bob@example.com');
  });

  test('attempts on an address with no account count the same way', async () => {
    usersFound([]);
    const email = newEmail();
    for (let i = 0; i < 5; i++) {
      await expect(signIn(email, RIGHT)).resolves.toBeNull();
    }
    await expect(signIn(email, RIGHT)).rejects.toMatchObject(RATE_LIMITED);
  });

  test('guesses sent at once are held: each is counted before its password is checked', async () => {
    const email = newEmail();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => signIn(email, WRONG)));
    expect(results.filter((r) => r.status === 'fulfilled' && r.value === null)).toHaveLength(5);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof LoginRateLimited)).toHaveLength(5);
    expect(bcrypt.compare).toHaveBeenCalledTimes(5);
  });

  test('AUTH_RATE_LIMIT_MAX sets it', async () => {
    vi.stubEnv('AUTH_RATE_LIMIT_MAX', '2');
    const email = newEmail();
    await signIn(email, WRONG);
    await signIn(email, WRONG);
    await expect(signIn(email, RIGHT)).rejects.toMatchObject(RATE_LIMITED);
  });
});

describe('the per-IP login limit', () => {
  test('successful sign-ins never reach it', async () => {
    vi.stubEnv('AUTH_IP_RATE_LIMIT_MAX', '3');
    const headers = fromIp();
    for (let i = 0; i < 10; i++) {
      await expect(signIn(newEmail(), RIGHT, headers), `sign-in ${i + 1}`).resolves.toMatchObject({ id: 'bob' });
    }
  });

  test('wrong passwords across addresses reach it, and the refusal is rate limited', async () => {
    vi.stubEnv('AUTH_IP_RATE_LIMIT_MAX', '3');
    const headers = fromIp();
    for (let i = 0; i < 3; i++) {
      await expect(signIn(newEmail(), WRONG, headers)).resolves.toBeNull();
    }
    const email = newEmail();
    await expect(signIn(email, RIGHT, headers)).rejects.toMatchObject(RATE_LIMITED);
    expect(logger.warn).toHaveBeenCalledWith('auth.rate_limited_ip', { ip: headers.get('x-real-ip') });

    // A refusal by the IP limit doesn't charge the address's own limit
    vi.stubEnv('AUTH_RATE_LIMIT_MAX', '1');
    await expect(signIn(email, RIGHT, fromIp())).resolves.toMatchObject({ id: 'bob' });
  });

  test('is skipped when no header identifies the client', async () => {
    vi.stubEnv('AUTH_IP_RATE_LIMIT_MAX', '1');
    await expect(signIn(newEmail(), WRONG)).resolves.toBeNull();
    await expect(signIn(newEmail(), RIGHT)).resolves.toMatchObject({ id: 'bob' });
  });
});
