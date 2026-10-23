/**
 * Password reset links (#397). "Forgot password?" emails one (when email is configured), and an
 * admin can make one to hand over themselves (`admin.createPasswordResetLink`), which is how a
 * password user gets back in on an instance without email.
 *
 * A link carries a random 256-bit token (src/lib/password-reset-link.ts); only its SHA-256 hash
 * is stored, so a database leak gives no working links. A user has at most one link (one
 * PasswordResetToken row per user): issuing a new one replaces it. Using it, changing the
 * password in Settings, suspending or deleting the user deletes it. Setting the password records
 * a new `passwordChangedAt`, which ends every session signed in under the old one (the jwt
 * callback in auth.ts).
 *
 * Lock order: the user row, then their token row, as in `auth.changePassword` and
 * `admin.deleteUser`/`suspendUser` (which write the user, then delete the token).
 */

import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import { defaultLocale, type Locale } from '@/i18n/routing';
import { isSupportedLocale } from '@/lib/locale-paths';
import { resetPasswordPath } from '@/lib/password-reset-link';
import { AppError } from './app-error';
import { isTransactionManagerError } from './guest-transaction';
import { logger } from './logger';
import { createMailTransport, mailFrom, publicBaseUrl } from './mailer';
import { passwordChangedEmail, passwordResetEmail } from './password-reset-email';
import { checkRateLimit, refundRateLimit } from './rate-limit';
import { AmbiguousEmailError, findUserByEmail } from './user-email';

/** How long an emailed link works. */
export const RESET_LINK_TTL_MS = 60 * 60 * 1000;
/** How long a link an admin makes works: they hand it over themselves, which can take a while. */
export const ADMIN_RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Reset emails one account gets an hour, however many addresses (letter cases) or clients ask:
 * enough for a lost email, too few to flood an inbox. Keyed by the account, so client-chosen
 * keys can't evict it, and over it a request still gets the usual answer.
 */
export const RESET_EMAILS_PER_ACCOUNT = 5;
const RESET_EMAIL_WINDOW_MS = 60 * 60 * 1000;

// maxWait: getting a pool connection under load; timeout: the user row lock wait plus a cost-12
// bcrypt hash
const RESET_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 };

/** Whether this account can use ShareTab: not suspended, and not a placeholder or deleted user. */
export function canResetPassword(user: { isPlaceholder: boolean; suspendedAt: Date | null }): boolean {
  return !user.isPlaceholder && user.suspendedAt === null;
}

export function newResetToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function localeOf(user: { locale: string }): Locale {
  return isSupportedLocale(user.locale) ? user.locale : defaultLocale;
}

/**
 * Locks the user's row and returns it if they can still use ShareTab (canResetPassword). Prisma
 * has no row-lock API; the row returned is the one current once the lock is held, so a suspend or
 * delete that committed meanwhile is seen.
 */
async function lockUserForReset(tx: Prisma.TransactionClient, userId: string) {
  const [user] = await tx.$queryRaw<
    { id: string; email: string; locale: string; isPlaceholder: boolean; suspendedAt: Date | null }[]
  >`
    SELECT "id", "email", "locale", "isPlaceholder", "suspendedAt" FROM "User"
    WHERE "id" = ${userId}
    FOR NO KEY UPDATE`;
  return user && canResetPassword(user) ? user : null;
}

/**
 * Makes a reset link's token for a user, replacing their earlier one in the same write. Null if
 * they can't use ShareTab (suspended, a placeholder or deleted), checked under the user row's lock so
 * a suspend can't slip in between.
 */
export async function issuePasswordResetToken(db: PrismaClient, userId: string, ttlMs: number, now = new Date()) {
  const token = newResetToken();
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(now.getTime() + ttlMs);
  const issued = await passwordTransaction(db, async (tx) => {
    if (!(await lockUserForReset(tx, userId))) return false;
    await tx.passwordResetToken.upsert({
      where: { userId },
      create: { userId, tokenHash, expiresAt },
      update: { tokenHash, expiresAt, createdAt: now },
    });
    return true;
  });
  return issued ? { token, expiresAt } : null;
}

/**
 * A transaction that writes a user's password or reset link, with room for a bcrypt hash. A full
 * connection pool or a transaction that runs out of time (P2028) is reported as busy
 * (SERVICE_UNAVAILABLE `serverBusy`), not as an unexpected error; nothing it did is kept.
 */
export async function passwordTransaction<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await db.$transaction(fn, RESET_TRANSACTION_OPTIONS);
  } catch (error) {
    if (isTransactionManagerError(error)) {
      logger.warn('auth.password_transaction_busy', { code: 'P2028', message: error.message });
      throw new AppError('SERVICE_UNAVAILABLE', 'serverBusy', undefined, { cause: error });
    }
    throw error;
  }
}

/**
 * Sets a user's password with a reset link's token, using the link up. Null, setting nothing, if
 * the link is unknown, expired, already used, or its user can't use ShareTab.
 *
 * An unknown or expired link is turned away before any transaction. Otherwise the password is
 * hashed only after the link is claimed, inside the transaction: requests with the same link
 * wait for the user's row lock, then find the link gone, so sending one link many times at once
 * costs one bcrypt. A full connection pool or a transaction that runs out of time is reported as
 * busy (SERVICE_UNAVAILABLE), not as a bad link; the link is then still unused.
 */
export async function resetPasswordWithToken(db: PrismaClient, token: string, password: string, now = new Date()) {
  const tokenHash = hashResetToken(token);
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { userId: true, expiresAt: true },
  });
  if (!row || row.expiresAt <= now) return null;

  return passwordTransaction(db, async (tx) => {
    const user = await lockUserForReset(tx, row.userId);
    if (!user) return null;

    // By hash: a link issued meanwhile reuses the row with a new hash, and this one is then dead
    const { count } = await tx.passwordResetToken.deleteMany({ where: { tokenHash, expiresAt: { gt: now } } });
    if (count === 0) return null;

    // Cost as at registration
    const passwordHash = await bcrypt.hash(password, 12);
    // Stamped now, after the lock wait and the hash: the new password version (auth.ts)
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date() } });
    return { userId: user.id, email: user.email, locale: localeOf(user) };
  });
}

/**
 * Emails a reset link to the account with this address, if there is one that can use ShareTab and
 * hasn't had RESET_EMAILS_PER_ACCOUNT of them this hour; otherwise does nothing.
 * `auth.requestPasswordReset` doesn't wait for it, so its answer doesn't depend on whether the
 * address has an account.
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

  // Checked before the budget is spent or the user's current link is replaced: a URL that
  // can't be parsed fails here
  const baseUrl = publicBaseUrl();
  const { hostname, protocol } = new URL(baseUrl);
  if (hostname === 'localhost') {
    // NEXTAUTH_URL left at its default: the link won't open anywhere but on the server itself
    logger.warn('auth.password_reset_link_localhost', { baseUrl });
  } else if (protocol === 'http:') {
    // Fine on a home network, but the link can be read on the way
    logger.warn('auth.password_reset_link_insecure', { baseUrl });
  }

  const budgetKey = `password-reset-email:${user.id}`;
  if (!checkRateLimit(budgetKey, RESET_EMAILS_PER_ACCOUNT, RESET_EMAIL_WINDOW_MS).allowed) {
    logger.info('auth.password_reset_throttled', { userId: user.id });
    return;
  }

  // The budget counts links made, each replacing the user's last one, not emails delivered: a
  // send that fails still counts, so a refusing SMTP server doesn't let anyone replace a user's
  // link (an admin-made one, say) without limit. No link made, no count
  let issued = null;
  try {
    issued = await issuePasswordResetToken(db, user.id, RESET_LINK_TTL_MS, now);
  } finally {
    if (!issued) refundRateLimit(budgetKey);
  }
  if (!issued) return;
  const locale = localeOf(user);
  await createMailTransport().sendMail({
    from: mailFrom(),
    to: user.email,
    ...passwordResetEmail(locale, { email: user.email, url: `${baseUrl}${resetPasswordPath(locale, issued.token)}` }),
  });
  logger.info('auth.password_reset_sent', { userId: user.id });
}

/**
 * Tells an account its password was just changed (a reset or Settings), so its owner notices a
 * change they didn't make. Callers send it only when email is configured, and don't wait for it
 * (`notifyPasswordChanged` in the auth router).
 */
export async function emailPasswordChanged(user: { email: string; locale: string }) {
  const locale = localeOf(user);
  await createMailTransport().sendMail({
    from: mailFrom(),
    to: user.email,
    ...passwordChangedEmail(locale, { email: user.email, resetUrl: `${publicBaseUrl()}/${locale}/forgot-password` }),
  });
}
