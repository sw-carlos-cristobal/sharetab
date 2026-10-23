/**
 * Password reset links (#397). "Forgot password?" emails one (when email is configured), and an
 * admin can make one to hand over themselves (`admin.createPasswordResetLink`), the only way back
 * in for a locked-out user on an instance without email.
 *
 * A link carries a random 256-bit token (src/lib/password-reset-link.ts); only its SHA-256 hash
 * is stored, so a database leak gives no working links. Each user has at most one live link:
 * issuing a new one replaces the earlier ones. Using a link deletes all of the user's links, as
 * does changing the password in Settings. A link stops working once its user is suspended or
 * deleted.
 */

import { createHash, randomBytes } from 'crypto';
import type { PrismaClient } from '@/generated/prisma/client';
import { defaultLocale } from '@/i18n/routing';
import { isSupportedLocale } from '@/lib/locale-paths';
import { resetPasswordPath } from '@/lib/password-reset-link';
import { logger } from './logger';
import { createMailTransport, mailFrom, publicBaseUrl } from './mailer';
import { passwordResetEmail } from './password-reset-email';
import { AmbiguousEmailError, findUserByEmail } from './user-email';

/** How long an emailed link works. */
export const RESET_LINK_TTL_MS = 60 * 60 * 1000;
/** How long a link an admin makes works: they hand it over themselves, which can take a while. */
export const ADMIN_RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;

type ResetUser = { isPlaceholder: boolean; suspendedAt: Date | null };

/** Whether this account can sign in at all: not suspended, and not a placeholder or deleted user. */
export function canResetPassword(user: ResetUser): boolean {
  return !user.isPlaceholder && user.suspendedAt === null;
}

export function newResetToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Makes a reset link's token for a user, replacing any earlier ones. */
export async function issuePasswordResetToken(db: PrismaClient, userId: string, ttlMs: number, now = new Date()) {
  const token = newResetToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await db.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({ where: { userId } });
    await tx.passwordResetToken.create({ data: { userId, tokenHash: hashResetToken(token), expiresAt } });
  });
  return { token, expiresAt };
}

const tokenSelect = {
  id: true,
  expiresAt: true,
  user: { select: { id: true, email: true, isPlaceholder: true, suspendedAt: true } },
} as const;

type TokenRow = { expiresAt: Date; user: ResetUser } | null;

function isUsable(row: TokenRow, now: Date): row is NonNullable<TokenRow> {
  return row !== null && row.expiresAt > now && canResetPassword(row.user);
}

/**
 * The user a reset link would set the password for, or null if it wouldn't work. A cheap check
 * before the password is hashed, so a bad link costs no bcrypt work.
 */
export async function findValidResetToken(db: PrismaClient, token: string, now = new Date()) {
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
    select: tokenSelect,
  });
  return isUsable(row, now) ? { userId: row.user.id } : null;
}

/**
 * Sets a user's password with a reset link's token, which it uses up along with the user's other
 * links. Null, setting nothing, if the link is unknown, expired, already used (also by a request
 * at the same moment: only one of them deletes the row), or its user can't sign in.
 */
export async function resetPasswordWithToken(db: PrismaClient, token: string, passwordHash: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    const row = await tx.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(token) },
      select: tokenSelect,
    });
    if (!isUsable(row, now)) return null;

    const { count } = await tx.passwordResetToken.deleteMany({ where: { id: row.id } });
    if (count === 0) return null;

    await tx.user.update({ where: { id: row.user.id }, data: { passwordHash } });
    await tx.passwordResetToken.deleteMany({ where: { userId: row.user.id } });
    return { userId: row.user.id, email: row.user.email };
  });
}

/**
 * Emails a reset link to the account with this address, if there is one that can sign in;
 * otherwise does nothing. `auth.requestPasswordReset` runs it without waiting, so its answer
 * doesn't depend on whether the address has an account.
 */
export async function emailPasswordResetLink(db: PrismaClient, email: string, now = new Date()) {
  let user;
  try {
    user = await findUserByEmail(db, email);
  } catch (error) {
    if (!(error instanceof AmbiguousEmailError)) throw error;
    logger.warn('auth.password_reset_skipped', { reason: 'ambiguous_email' });
    return;
  }
  if (!user || !canResetPassword(user)) return;

  const { token } = await issuePasswordResetToken(db, user.id, RESET_LINK_TTL_MS, now);
  const locale = isSupportedLocale(user.locale) ? user.locale : defaultLocale;
  const url = `${publicBaseUrl()}${resetPasswordPath(locale, token)}`;
  await createMailTransport().sendMail({
    from: mailFrom(),
    to: user.email,
    ...passwordResetEmail(locale, { email: user.email, url }),
  });
  logger.info('auth.password_reset_sent', { userId: user.id });
}
