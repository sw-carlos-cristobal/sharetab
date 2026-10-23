import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMail = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const findUserByEmail = vi.fn();
vi.mock('./user-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./user-email')>()),
  findUserByEmail: (...args: unknown[]) => findUserByEmail(...args),
}));

import nodemailer from 'nodemailer';
import { AmbiguousEmailError } from './user-email';
import { logger } from './logger';
import {
  RESET_LINK_TTL_MS,
  emailPasswordResetLink,
  findValidResetToken,
  hashResetToken,
  issuePasswordResetToken,
  newResetToken,
  resetPasswordWithToken,
} from './password-reset';
import { readResetToken } from '@/lib/password-reset-link';

const mockDb = {
  passwordResetToken: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  user: { update: vi.fn() },
  $transaction: vi.fn(),
};
const db = mockDb as unknown as Parameters<typeof issuePasswordResetToken>[0];

const NOW = new Date('2026-10-23T12:00:00Z');
const LATER = new Date(NOW.getTime() + 60_000);
const EARLIER = new Date(NOW.getTime() - 1);

const activeUser = {
  id: 'bob',
  email: 'bob@example.com',
  locale: 'en',
  isPlaceholder: false,
  suspendedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  mockDb.passwordResetToken.deleteMany.mockResolvedValue({ count: 1 });
  sendMail.mockResolvedValue({});
  vi.stubEnv('EMAIL_SERVER_HOST', 'smtp.example.com');
  vi.stubEnv('EMAIL_FROM', 'ShareTab <noreply@example.com>');
  vi.stubEnv('AUTH_URL', '');
  vi.stubEnv('NEXTAUTH_URL', 'https://sharetab.example.com/');
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  test('issuing a token replaces the user’s earlier ones and stores its hash and expiry', async () => {
    const { token, expiresAt } = await issuePasswordResetToken(db, 'bob', RESET_LINK_TTL_MS, NOW);

    expect(expiresAt).toEqual(new Date(NOW.getTime() + RESET_LINK_TTL_MS));
    expect(mockDb.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'bob' } });
    expect(mockDb.passwordResetToken.create).toHaveBeenCalledWith({
      data: { userId: 'bob', tokenHash: hashResetToken(token), expiresAt },
    });
    expect(JSON.stringify(mockDb.passwordResetToken.create.mock.calls)).not.toContain(token);
  });
});

describe('findValidResetToken', () => {
  test('finds the user of an unexpired token', async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue({
      id: 't1',
      expiresAt: LATER,
      user: activeUser,
    });
    expect(await findValidResetToken(db, 'tok', NOW)).toEqual({ userId: 'bob' });
    expect(mockDb.passwordResetToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashResetToken('tok') } }),
    );
  });

  test('refuses an unknown or expired token', async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue(null);
    expect(await findValidResetToken(db, 'tok', NOW)).toBeNull();
    mockDb.passwordResetToken.findUnique.mockResolvedValue({ id: 't1', expiresAt: NOW, user: activeUser });
    expect(await findValidResetToken(db, 'tok', NOW)).toBeNull();
  });

  test('refuses a token for a suspended or deleted user', async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue({
      id: 't1',
      expiresAt: LATER,
      user: { ...activeUser, suspendedAt: EARLIER },
    });
    expect(await findValidResetToken(db, 'tok', NOW)).toBeNull();
    mockDb.passwordResetToken.findUnique.mockResolvedValue({
      id: 't1',
      expiresAt: LATER,
      user: { ...activeUser, isPlaceholder: true },
    });
    expect(await findValidResetToken(db, 'tok', NOW)).toBeNull();
  });
});

describe('resetPasswordWithToken', () => {
  test('sets the password and uses up every reset link the user has', async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue({ id: 't1', expiresAt: LATER, user: activeUser });

    expect(await resetPasswordWithToken(db, 'tok', 'new-hash', NOW)).toEqual({
      userId: 'bob',
      email: 'bob@example.com',
    });
    expect(mockDb.passwordResetToken.deleteMany).toHaveBeenNthCalledWith(1, { where: { id: 't1' } });
    expect(mockDb.user.update).toHaveBeenCalledWith({ where: { id: 'bob' }, data: { passwordHash: 'new-hash' } });
    expect(mockDb.passwordResetToken.deleteMany).toHaveBeenNthCalledWith(2, { where: { userId: 'bob' } });
  });

  test('a link used at the same moment by another request sets nothing', async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue({ id: 't1', expiresAt: LATER, user: activeUser });
    mockDb.passwordResetToken.deleteMany.mockResolvedValueOnce({ count: 0 });

    expect(await resetPasswordWithToken(db, 'tok', 'new-hash', NOW)).toBeNull();
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  test('an expired link, or one for a user who can no longer sign in, sets nothing', async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue({ id: 't1', expiresAt: EARLIER, user: activeUser });
    expect(await resetPasswordWithToken(db, 'tok', 'new-hash', NOW)).toBeNull();

    mockDb.passwordResetToken.findUnique.mockResolvedValue({
      id: 't1',
      expiresAt: LATER,
      user: { ...activeUser, suspendedAt: EARLIER },
    });
    expect(await resetPasswordWithToken(db, 'tok', 'new-hash', NOW)).toBeNull();

    mockDb.passwordResetToken.findUnique.mockResolvedValue(null);
    expect(await resetPasswordWithToken(db, 'tok', 'new-hash', NOW)).toBeNull();

    expect(mockDb.user.update).not.toHaveBeenCalled();
  });
});

describe('emailPasswordResetLink', () => {
  test('emails an active user a link to the configured public URL, in their language', async () => {
    findUserByEmail.mockResolvedValue({ ...activeUser, email: 'Bob@Example.com', locale: 'de' });

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
    expect(mockDb.passwordResetToken.create).toHaveBeenCalledWith({
      data: {
        userId: 'bob',
        tokenHash: hashResetToken(token!),
        expiresAt: new Date(NOW.getTime() + RESET_LINK_TTL_MS),
      },
    });
  });

  test('AUTH_URL wins over NEXTAUTH_URL, as it does for Auth.js', async () => {
    vi.stubEnv('AUTH_URL', 'https://auth-url.example.com');
    findUserByEmail.mockResolvedValue(activeUser);

    await emailPasswordResetLink(db, 'bob@example.com', NOW);

    expect(sendMail.mock.calls[0]![0].text).toContain('https://auth-url.example.com/en/reset-password#token=');
  });

  test('sends nothing for an unknown address', async () => {
    findUserByEmail.mockResolvedValue(null);
    await emailPasswordResetLink(db, 'nobody@example.com', NOW);
    expect(sendMail).not.toHaveBeenCalled();
    expect(mockDb.passwordResetToken.create).not.toHaveBeenCalled();
  });

  test('sends nothing to a suspended or deleted user', async () => {
    findUserByEmail.mockResolvedValue({ ...activeUser, suspendedAt: EARLIER });
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    findUserByEmail.mockResolvedValue({ ...activeUser, isPlaceholder: true });
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    expect(sendMail).not.toHaveBeenCalled();
    expect(mockDb.passwordResetToken.create).not.toHaveBeenCalled();
  });

  test('sends nothing when several accounts share the address ignoring case', async () => {
    findUserByEmail.mockRejectedValue(new AmbiguousEmailError());
    await emailPasswordResetLink(db, 'bob@example.com', NOW);
    expect(sendMail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('auth.password_reset_skipped', { reason: 'ambiguous_email' });
  });

  test('never logs the token', async () => {
    findUserByEmail.mockResolvedValue(activeUser);
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
