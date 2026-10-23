import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn() } }));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const findUserByEmail = vi.fn();
vi.mock('./user-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./user-email')>()),
  findUserByEmail: (...args: unknown[]) => findUserByEmail(...args),
}));

import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { AmbiguousEmailError } from './user-email';
import { logger } from './logger';
import { checkRateLimit } from './rate-limit';
import {
  ADMIN_RESET_LINK_TTL_MS,
  RESET_EMAILS_PER_ACCOUNT,
  RESET_LINK_TTL_MS,
  emailPasswordChanged,
  emailPasswordResetLink,
  hashResetToken,
  issuePasswordResetToken,
  newResetToken,
  passwordTransaction,
  resetPasswordWithToken,
} from './password-reset';
import { readResetToken } from '@/lib/password-reset-link';

// The transaction client is its own object, so a query sent outside the transaction shows up
// on `mockDb` instead
const tx = {
  passwordResetToken: { upsert: vi.fn(), deleteMany: vi.fn() },
  user: { update: vi.fn() },
  $queryRaw: vi.fn(),
};
const mockDb = {
  passwordResetToken: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  user: { update: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
};
const db = mockDb as unknown as Parameters<typeof issuePasswordResetToken>[0];

const NOW = new Date('2026-10-23T12:00:00Z');
const LATER = new Date(NOW.getTime() + 60_000);

// The token belongs to "token-owner"; nothing else in the fixtures uses that id
const lockedUser = {
  id: 'token-owner',
  email: 'owner@example.com',
  locale: 'fr',
  isPlaceholder: false,
  suspendedAt: null as Date | null,
};
const activeUser = { ...lockedUser, id: 'bob', email: 'bob@example.com', locale: 'en' };

let emailSeq = 0;
/** A user for an email test, with its own per-account email budget */
function freshUser(overrides: Partial<typeof activeUser> = {}) {
  emailSeq += 1;
  return { ...activeUser, id: `email-user-${emailSeq}`, ...overrides };
}

function expectNothingOutsideTransaction() {
  expect(mockDb.passwordResetToken.upsert).not.toHaveBeenCalled();
  expect(mockDb.passwordResetToken.deleteMany).not.toHaveBeenCalled();
  expect(mockDb.user.update).not.toHaveBeenCalled();
  expect(mockDb.$queryRaw).not.toHaveBeenCalled();
}

function lockStatement(): { sql: string; values: unknown[] } {
  const [strings, ...values] = tx.$queryRaw.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
  return { sql: strings.join('?'), values };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
  mockDb.passwordResetToken.findUnique.mockResolvedValue({ userId: 'token-owner', expiresAt: LATER });
  tx.$queryRaw.mockResolvedValue([lockedUser]);
  tx.passwordResetToken.deleteMany.mockResolvedValue({ count: 1 });
  vi.mocked(bcrypt.hash).mockResolvedValue('new-hash' as never);
  sendMail.mockResolvedValue({});
  vi.stubEnv('EMAIL_SERVER_HOST', 'smtp.example.com');
  vi.stubEnv('EMAIL_FROM', 'ShareTab <noreply@example.com>');
  vi.stubEnv('AUTH_URL', '');
  vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com/');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('documented limits', () => {
  test('emailed links last 1 hour, admin links 24, and an account gets 5 emails an hour', () => {
    // The emails, the pages and the README say these numbers
    expect(RESET_LINK_TTL_MS).toBe(60 * 60 * 1000);
    expect(ADMIN_RESET_LINK_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(RESET_EMAILS_PER_ACCOUNT).toBe(5);
  });
});

describe('reset tokens', () => {
  test('a new token is 256 random bits in URL-safe base64', () => {
    const token = newResetToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newResetToken()).not.toBe(token);
  });

  test('only a SHA-256 hash of the token is stored', () => {
    const hash = hashResetToken('the-token');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashResetToken('the-token'));
    expect(hash).not.toBe(hashResetToken('the-token2'));
  });
});

describe('issuePasswordResetToken', () => {
  test('locks the user, then replaces their link in a single write, storing its hash and expiry', async () => {
    const issued = await issuePasswordResetToken(db, 'token-owner', RESET_LINK_TTL_MS, NOW);

    expect(issued).not.toBeNull();
    const { token, expiresAt } = issued!;
    expect(expiresAt).toEqual(new Date(NOW.getTime() + RESET_LINK_TTL_MS));
    expect(lockStatement().values).toEqual(['token-owner']);
    expect(lockStatement().sql).toContain('FOR NO KEY UPDATE');
    // One row per user (userId is unique), so two links issued at once can't both stay live
    expect(tx.passwordResetToken.upsert).toHaveBeenCalledWith({
      where: { userId: 'token-owner' },
      create: { userId: 'token-owner', tokenHash: hashResetToken(token), expiresAt },
      update: { tokenHash: hashResetToken(token), expiresAt, createdAt: NOW },
    });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.passwordResetToken.upsert.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(tx.passwordResetToken.upsert.mock.calls)).not.toContain(token);
    expectNothingOutsideTransaction();
  });

  test('issues nothing for a user suspended, deleted or turned into a placeholder meanwhile', async () => {
    for (const row of [
      { ...lockedUser, suspendedAt: NOW },
      { ...lockedUser, isPlaceholder: true },
    ]) {
      tx.$queryRaw.mockResolvedValueOnce([row]);
      expect(await issuePasswordResetToken(db, 'token-owner', RESET_LINK_TTL_MS, NOW)).toBeNull();
    }
    tx.$queryRaw.mockResolvedValueOnce([]);
    expect(await issuePasswordResetToken(db, 'token-owner', RESET_LINK_TTL_MS, NOW)).toBeNull();
    expect(tx.passwordResetToken.upsert).not.toHaveBeenCalled();
  });

  test('a full connection pool or a timed-out transaction is reported as busy', async () => {
    mockDb.$transaction.mockRejectedValue(Object.assign(new Error('Transaction already closed'), { code: 'P2028' }));
    await expect(issuePasswordResetToken(db, 'token-owner', RESET_LINK_TTL_MS, NOW)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      messageKey: 'serverBusy',
    });
  });

  test('issues a link to an account without a password, which can then add one', async () => {
    // As README says: an account made with a magic link, SSO or Google can set a password this way.
    // The lock reads no password column, so nothing turns such an account away
    expect(await issuePasswordResetToken(db, 'token-owner', RESET_LINK_TTL_MS, NOW)).not.toBeNull();
    const { sql } = lockStatement();
    expect(sql).not.toContain('passwordHash');
  });
});

describe('passwordTransaction', () => {
  test('runs with room for a bcrypt hash, and reports a full pool as busy, with the cause and a log line', async () => {
    const fn = vi.fn();
    mockDb.$transaction.mockImplementation(async (callback: unknown) => (callback === fn ? 'done' : undefined));
    expect(await passwordTransaction(db, fn)).toBe('done');
    expect(mockDb.$transaction).toHaveBeenCalledWith(fn, { maxWait: 5_000, timeout: 15_000 });

    const busy = Object.assign(new Error('Unable to start a transaction in the given time'), { code: 'P2028' });
    mockDb.$transaction.mockRejectedValue(busy);
    await expect(passwordTransaction(db, fn)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      messageKey: 'serverBusy',
      cause: busy,
    });
    expect(logger.warn).toHaveBeenCalledWith('auth.password_transaction_busy', {
      code: 'P2028',
      message: busy.message,
    });
  });

  test('passes any other error on as it is', async () => {
    const conflict = Object.assign(new Error('changed meanwhile'), { code: 'CONFLICT' });
    mockDb.$transaction.mockRejectedValue(conflict);
    await expect(passwordTransaction(db, vi.fn())).rejects.toBe(conflict);
  });
});

describe('resetPasswordWithToken', () => {
  test('sets the password and a new password version, in one transaction', async () => {
    expect(await resetPasswordWithToken(db, 'tok', 'new-password', NOW)).toEqual({
      userId: 'token-owner',
      email: 'owner@example.com',
      locale: 'fr',
    });

    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.passwordResetToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashResetToken('tok') } }),
    );
    expect(bcrypt.hash).toHaveBeenCalledWith('new-password', 12);
    const update = tx.user.update.mock.calls[0]![0] as { where: unknown; data: { passwordChangedAt: Date } };
    // The user the lock returned, which is the one the token belongs to
    expect(update.where).toEqual({ id: 'token-owner' });
    expect(update.data).toEqual({ passwordHash: 'new-hash', passwordChangedAt: expect.any(Date) });
    expect(mockDb.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 5_000, timeout: 15_000 });
    expectNothingOutsideTransaction();
  });

  test('stamps the new password version after the hash, not when the request arrived', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    vi.mocked(bcrypt.hash).mockImplementation(async () => {
      vi.setSystemTime(new Date('2030-01-01T00:00:01Z'));
      return 'new-hash' as never;
    });

    await resetPasswordWithToken(db, 'tok', 'new-password', NOW);

    const update = tx.user.update.mock.calls[0]![0] as { data: { passwordChangedAt: Date } };
    expect(update.data.passwordChangedAt).toEqual(new Date('2030-01-01T00:00:01Z'));
  });

  test('locks the token owner’s row, then claims the link, before any bcrypt work', async () => {
    await resetPasswordWithToken(db, 'tok', 'new-password', NOW);

    const { sql, values } = lockStatement();
    expect(sql).toContain('FROM "User"');
    expect(sql).toContain('FOR NO KEY UPDATE');
    expect(values).toEqual(['token-owner']);
    // The claim matches the link's hash, not just the row: issuing a new link reuses the row
    expect(tx.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: hashResetToken('tok'), expiresAt: { gt: NOW } },
    });

    const lock = tx.$queryRaw.mock.invocationCallOrder[0]!;
    const claim = tx.passwordResetToken.deleteMany.mock.invocationCallOrder[0]!;
    const hash = vi.mocked(bcrypt.hash).mock.invocationCallOrder[0]!;
    const write = tx.user.update.mock.invocationCallOrder[0]!;
    expect(lock).toBeLessThan(claim);
    expect(claim).toBeLessThan(hash);
    expect(hash).toBeLessThan(write);
  });

  test('a link already claimed by another request sets nothing and costs no bcrypt', async () => {
    tx.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 });

    expect(await resetPasswordWithToken(db, 'tok', 'new-password', NOW)).toBeNull();
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  test('an unknown or expired link sets nothing and opens no transaction', async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue(null);
    expect(await resetPasswordWithToken(db, 'tok', 'new-password', NOW)).toBeNull();

    mockDb.passwordResetToken.findUnique.mockResolvedValue({ userId: 'token-owner', expiresAt: NOW });
    expect(await resetPasswordWithToken(db, 'tok', 'new-password', NOW)).toBeNull();

    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });

  test('a link for a user who can no longer sign in sets nothing', async () => {
    for (const rows of [[{ ...lockedUser, suspendedAt: NOW }], [{ ...lockedUser, isPlaceholder: true }], []]) {
      tx.$queryRaw.mockResolvedValueOnce(rows);
      expect(await resetPasswordWithToken(db, 'tok', 'new-password', NOW)).toBeNull();
    }
    expect(tx.passwordResetToken.deleteMany).not.toHaveBeenCalled();
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  test('a full connection pool or a timed-out transaction is reported as busy, not as a bad link', async () => {
    mockDb.$transaction.mockRejectedValue(Object.assign(new Error('Unable to start a transaction'), { code: 'P2028' }));
    await expect(resetPasswordWithToken(db, 'tok', 'new-password', NOW)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      messageKey: 'serverBusy',
    });
  });

  test('any other database error is passed on as it is', async () => {
    const failure = Object.assign(new Error('connection reset'), { code: 'P1017' });
    mockDb.$transaction.mockRejectedValue(failure);
    await expect(resetPasswordWithToken(db, 'tok', 'new-password', NOW)).rejects.toBe(failure);
  });
});

describe('emailPasswordResetLink', () => {
  test('emails an active user a link to the configured public URL, in their language', async () => {
    const user = freshUser({ email: 'Bob@Example.com', locale: 'de' });
    findUserByEmail.mockResolvedValue(user);
    tx.$queryRaw.mockResolvedValue([user]);

    await emailPasswordResetLink(db, 'bob@example.com', NOW);

    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.com' }));
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0]![0] as { from: string; to: string; subject: string; text: string };
    expect(mail.from).toBe('ShareTab <noreply@example.com>');
    // To the address on the account, not the casing that was typed
    expect(mail.to).toBe('Bob@Example.com');
    expect(mail.subject).toBe('ShareTab-Passwort zurücksetzen');

    const link = mail.text.match(/https:\/\/sharetab\.example\.com\/de\/reset-password#token=\S+/)?.[0];
    expect(link).toBeDefined();
    const token = readResetToken(new URL(link!).hash);
    expect(token).not.toBeNull();
    expect(tx.passwordResetToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          userId: user.id,
          tokenHash: hashResetToken(token!),
          expiresAt: new Date(NOW.getTime() + RESET_LINK_TTL_MS),
        },
      }),
    );
  });

  test('sends at most a few emails per account an hour, quietly skipping the rest', async () => {
    const user = freshUser();
    findUserByEmail.mockResolvedValue(user);
    for (let i = 0; i < RESET_EMAILS_PER_ACCOUNT + 2; i++) {
      await emailPasswordResetLink(db, i % 2 ? 'BOB@example.com' : 'bob@example.com', NOW);
    }
    expect(sendMail).toHaveBeenCalledTimes(RESET_EMAILS_PER_ACCOUNT);
    // The requests past the limit don't replace the link either: they stop before any transaction
    expect(mockDb.$transaction).toHaveBeenCalledTimes(RESET_EMAILS_PER_ACCOUNT);
    expect(tx.passwordResetToken.upsert).toHaveBeenCalledTimes(RESET_EMAILS_PER_ACCOUNT);
    expect(logger.info).toHaveBeenCalledWith('auth.password_reset_throttled', { userId: user.id });
    // Kept in the main store, keyed by the account: client-chosen keys can't evict it
    expect(checkRateLimit(`password-reset-email:${user.id}`, RESET_EMAILS_PER_ACCOUNT, 1).allowed).toBe(false);
  });

  test('the budget is per hour', async () => {
    vi.useFakeTimers();
    const user = freshUser();
    findUserByEmail.mockResolvedValue(user);
    for (let i = 0; i < RESET_EMAILS_PER_ACCOUNT; i++) await emailPasswordResetLink(db, 'bob@example.com', NOW);

    vi.advanceTimersByTime(59 * 60 * 1000);
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    expect(sendMail).toHaveBeenCalledTimes(RESET_EMAILS_PER_ACCOUNT);

    vi.advanceTimersByTime(2 * 60 * 1000);
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    expect(sendMail).toHaveBeenCalledTimes(RESET_EMAILS_PER_ACCOUNT + 1);
  });

  /** How many reset emails the account can still be sent this hour */
  async function emailsLeft(email = 'bob@example.com') {
    sendMail.mockClear();
    for (let i = 0; i < RESET_EMAILS_PER_ACCOUNT + 1; i++) await emailPasswordResetLink(db, email, NOW);
    return sendMail.mock.calls.length;
  }

  test('a failed send still counts: the link it carried replaced the one the user had', async () => {
    findUserByEmail.mockResolvedValue(freshUser());
    sendMail.mockRejectedValueOnce(new Error('smtp down'));
    await expect(emailPasswordResetLink(db, 'bob@example.com', NOW)).rejects.toThrow('smtp down');
    expect(tx.passwordResetToken.upsert).toHaveBeenCalledTimes(1);

    expect(await emailsLeft()).toBe(RESET_EMAILS_PER_ACCOUNT - 1);
  });

  test('no link made, because the user was suspended meanwhile or the database failed, doesn’t count', async () => {
    findUserByEmail.mockResolvedValue(freshUser());
    tx.$queryRaw.mockResolvedValueOnce([{ ...lockedUser, suspendedAt: NOW }]);
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    mockDb.$transaction.mockRejectedValueOnce(new Error('connection reset'));
    await expect(emailPasswordResetLink(db, 'bob@example.com', NOW)).rejects.toThrow('connection reset');

    expect(await emailsLeft()).toBe(RESET_EMAILS_PER_ACCOUNT);
  });

  test('a public URL that can’t be parsed fails before the old link is replaced or the budget is spent', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'not a url');
    findUserByEmail.mockResolvedValue(freshUser());
    await expect(emailPasswordResetLink(db, 'bob@example.com', NOW)).rejects.toThrow();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();

    vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com');
    expect(await emailsLeft()).toBe(RESET_EMAILS_PER_ACCOUNT);
  });

  test('a public URL without an http(s) scheme fails before the old link is replaced or the budget is spent', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'sharetab.lan:3000');
    findUserByEmail.mockResolvedValue(freshUser());
    await expect(emailPasswordResetLink(db, 'bob@example.com', NOW)).rejects.toThrow('http');
    expect(logger.warn).toHaveBeenCalledWith('mail.public_url_invalid', { baseUrl: 'sharetab.lan:3000' });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();

    vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com');
    expect(await emailsLeft()).toBe(RESET_EMAILS_PER_ACCOUNT);
  });

  test('warns when the link would travel over plain HTTP', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'http://sharetab.lan:3000');
    findUserByEmail.mockResolvedValue(freshUser());
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    expect(logger.warn).toHaveBeenCalledWith('auth.password_reset_link_insecure', {
      baseUrl: 'http://sharetab.lan:3000',
    });
  });

  test('warns about nothing for an https public URL', async () => {
    findUserByEmail.mockResolvedValue(freshUser());
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a failed lookup is passed on, not mistaken for an ambiguous address', async () => {
    findUserByEmail.mockRejectedValue(new Error('pool timeout'));
    await expect(emailPasswordResetLink(db, 'bob@example.com', NOW)).rejects.toThrow('pool timeout');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a user whose language ShareTab no longer has gets an English email and link', async () => {
    findUserByEmail.mockResolvedValue(freshUser({ locale: 'xx' }));

    await emailPasswordResetLink(db, 'bob@example.com', NOW);

    const mail = sendMail.mock.calls[0]![0] as { subject: string; text: string };
    expect(mail.subject).toBe('Reset your ShareTab password');
    expect(mail.text).toContain('https://sharetab.example.com/en/reset-password#token=');
  });

  test('AUTH_URL wins over NEXTAUTH_URL, as it does for Auth.js', async () => {
    vi.stubEnv('AUTH_URL', 'https://auth-url.example.com');
    findUserByEmail.mockResolvedValue(freshUser());

    await emailPasswordResetLink(db, 'bob@example.com', NOW);

    expect(sendMail.mock.calls[0]![0].text).toContain('https://auth-url.example.com/en/reset-password#token=');
  });

  test('warns when the link would point at localhost, the default when NEXTAUTH_URL is unset', async () => {
    vi.stubEnv('NEXTAUTH_URL', '');
    findUserByEmail.mockResolvedValue(freshUser());

    await emailPasswordResetLink(db, 'bob@example.com', NOW);

    expect(logger.warn).toHaveBeenCalledWith('auth.password_reset_link_localhost', {
      baseUrl: 'http://localhost:3000',
    });
  });

  test('a failed send rejects, for the caller to log', async () => {
    findUserByEmail.mockResolvedValue(freshUser());
    sendMail.mockRejectedValue(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));

    await expect(emailPasswordResetLink(db, 'bob@example.com', NOW)).rejects.toMatchObject({ code: 'EAUTH' });
  });

  test('sends nothing for an unknown address', async () => {
    findUserByEmail.mockResolvedValue(null);
    await emailPasswordResetLink(db, 'nobody@example.com', NOW);
    expect(sendMail).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test('sends nothing to a suspended or deleted user, nor one suspended while the link was being made', async () => {
    findUserByEmail.mockResolvedValue(freshUser({ suspendedAt: new Date(NOW.getTime() - 1) }));
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    findUserByEmail.mockResolvedValue(freshUser({ isPlaceholder: true }));
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    // Active when looked up, suspended by the time the user row was locked
    findUserByEmail.mockResolvedValue(freshUser());
    tx.$queryRaw.mockResolvedValueOnce([{ ...lockedUser, suspendedAt: NOW }]);
    await emailPasswordResetLink(db, 'bob@example.com', NOW);

    expect(sendMail).not.toHaveBeenCalled();
    expect(tx.passwordResetToken.upsert).not.toHaveBeenCalled();
  });

  test('sends nothing when several accounts share the address ignoring case and none matches exactly', async () => {
    findUserByEmail.mockRejectedValue(new AmbiguousEmailError());
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    expect(sendMail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('auth.password_reset_skipped', { reason: 'ambiguous_email' });
  });

  test('never logs the token', async () => {
    findUserByEmail.mockResolvedValue(freshUser());
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    const token = readResetToken(new URL(sendMail.mock.calls[0]![0].text.match(/https:\S+/)[0]).hash);
    const logged = JSON.stringify([
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.warn).mock.calls,
      vi.mocked(logger.error).mock.calls,
      vi.mocked(logger.debug).mock.calls,
    ]);
    expect(logged).not.toContain(token!);
    expect(logged).not.toContain(hashResetToken(token!));
  });
});

describe('emailPasswordChanged', () => {
  test('tells the account its password changed, in its language, with a way to reset it', async () => {
    await emailPasswordChanged({ email: 'bob@example.com', locale: 'ja' });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0]![0] as { from: string; to: string; subject: string; text: string };
    expect(mail.to).toBe('bob@example.com');
    expect(mail.from).toBe('ShareTab <noreply@example.com>');
    expect(mail.subject).not.toBe('Your ShareTab password was changed');
    expect(mail.text).toContain('https://sharetab.example.com/ja/forgot-password');
  });

  test('falls back to English for a language ShareTab no longer has', async () => {
    await emailPasswordChanged({ email: 'bob@example.com', locale: 'xx' });
    const mail = sendMail.mock.calls[0]![0] as { subject: string; text: string };
    expect(mail.subject).toBe('Your ShareTab password was changed');
    expect(mail.text).toContain('/en/forgot-password');
  });
});
