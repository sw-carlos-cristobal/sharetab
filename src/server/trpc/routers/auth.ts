import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { AppError } from '@/server/lib/app-error';
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../init';
import { checkRateLimit, clearRateLimit, parsePositiveInt, peekRateLimit } from '../../lib/rate-limit';
import { FALLBACK_IP, getClientIp } from '../../lib/client-ip';
import { locales } from '@/i18n/routing';
import { stripUndefined } from '../../lib/strip-undefined';
import { parseAuthConfig } from '../../lib/auth-config';
import { readRegistrationMode } from '../../lib/registration-mode';
import { findUsersByEmail } from '../../lib/user-email';
import { logger } from '../../lib/logger';
import { emailPasswordChanged, emailPasswordResetLink, resetPasswordWithToken } from '../../lib/password-reset';
import { LOGIN_WINDOW_MS, loginAttemptsPerEmail, loginRateLimitKey } from '../../lib/password-login';
import { describeMailError } from '../../lib/mailer';
import { Prisma } from '@/generated/prisma/client';

// Per client address, across email addresses (the per-account limit on emails is in
// password-reset.ts). Configurable like the other per-IP limits, for test runs that share one IP
const resetRequestsPerIp = () => parsePositiveInt(process.env.PASSWORD_RESET_RATE_LIMIT_MAX, 20);
const RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000;
// Links submitted per client address. A token can't be guessed; this bounds the database work
// (and a held connection while a valid link is used) one client can cause
const resetSubmitsPerIp = () => parsePositiveInt(process.env.PASSWORD_RESET_RATE_LIMIT_MAX, 30);
const RESET_SUBMIT_WINDOW_MS = 15 * 60 * 1000;

// Every password ShareTab sets: registration, Settings, reset links
const newPasswordSchema = z.string().min(8).max(100);

/** Tells the account its password changed, when email is configured; doesn't wait for the send. */
function notifyPasswordChanged(user: { email: string; locale: string }) {
  if (!parseAuthConfig(process.env).magicLink) return;
  void emailPasswordChanged(user).catch((error: unknown) => {
    logger.warn('auth.password_changed_email_failed', describeMailError(error));
  });
}

/**
 * Per-IP limit for the reset routes, skipped when no header names the client, as for password
 * login. That's rare under `next start`, which fills in x-forwarded-for; behind a proxy that
 * forwards no client address, every client shares one bucket (src/server/lib/client-ip.ts).
 */
function checkClientLimit(headers: Headers, key: string, max: number, windowMs: number) {
  const ip = getClientIp(headers);
  if (ip !== FALLBACK_IP && !checkRateLimit(`${key}:${ip}`, max, windowMs).allowed) {
    throw new AppError('TOO_MANY_REQUESTS', 'passwordResetRateLimited');
  }
}

export const authRouter = createTRPCRouter({
  getSession: publicProcedure.query(({ ctx }) => {
    return ctx.session;
  }),

  // Which sign-in methods the login page should offer. Never includes the
  // OIDC issuer, client ids or secrets — only what the UI renders.
  getLoginOptions: publicProcedure.query(() => {
    const config = parseAuthConfig(process.env);
    return {
      passwordLogin: config.passwordLogin,
      // "Forgot password?" emails a reset link; without email, only an admin can make one
      passwordReset: config.passwordLogin && config.magicLink,
      magicLink: config.magicLink,
      oidc: config.oidc ? { name: config.oidc.displayName } : null,
      google: config.google !== null,
    };
  }),

  getRegistrationMode: publicProcedure.query(async ({ ctx }) => {
    // The register form creates password accounts; with password login
    // disabled it is closed whatever the admin setting says.
    if (!parseAuthConfig(process.env).passwordLogin) {
      return { mode: 'closed' as const };
    }
    return { mode: await readRegistrationMode(ctx.db) };
  }),

  register: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        email: z.string().email(),
        password: newPasswordSchema,
        inviteCode: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!parseAuthConfig(process.env).passwordLogin) {
        throw new AppError('FORBIDDEN', 'registrationClosed');
      }

      // Rate limit: 10 registrations per hour per IP (fall back to global key)
      const ip = getClientIp(ctx.headers);
      const maxRegAttempts = parsePositiveInt(process.env.REGISTER_RATE_LIMIT_MAX, 10);
      const { allowed } = checkRateLimit(`register:${ip}`, maxRegAttempts, 60 * 60 * 1000);
      if (!allowed) {
        throw new AppError('TOO_MANY_REQUESTS', 'registerRateLimited');
      }

      // Check registration mode
      const mode = await readRegistrationMode(ctx.db);

      if (mode === 'closed') {
        throw new AppError('FORBIDDEN', 'registrationClosed');
      }

      if (mode === 'invite-only') {
        if (!input.inviteCode) {
          throw new AppError('FORBIDDEN', 'inviteCodeRequired');
        }

        const invite = await ctx.db.systemInvite.findUnique({
          where: { code: input.inviteCode },
        });
        if (!invite || invite.revokedAt || invite.usedAt || (invite.expiresAt && invite.expiresAt < new Date())) {
          throw new AppError('FORBIDDEN', 'inviteCodeInvalid');
        }
      }

      // Case-insensitive: `Bob@x` and `bob@x` are treated as the same address, and
      // every sign-in method matches users by email ignoring case.
      const existing = await findUsersByEmail(ctx.db, input.email);
      if (existing.length > 0) {
        throw new AppError('CONFLICT', 'emailTaken');
      }

      const passwordHash = await bcrypt.hash(input.password, 12);
      const user = await ctx.db.$transaction(async (tx) => {
        const created = await tx.user
          .create({
            data: {
              name: input.name,
              email: input.email,
              passwordHash,
            },
          })
          .catch((error: unknown) => {
            // A concurrent sign-up for this address, in any letter case, got
            // in after the check above; the unique indexes on email and on
            // lower(email) (prisma/after-push/) reject this one.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
              throw new AppError('CONFLICT', 'emailTaken');
            }
            throw error;
          });

        if (input.inviteCode && mode === 'invite-only') {
          const claimed = await tx.systemInvite.updateMany({
            where: {
              code: input.inviteCode,
              usedAt: null,
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            data: { usedById: created.id, usedAt: new Date() },
          });
          if (claimed.count === 0) {
            throw new AppError('FORBIDDEN', 'inviteCodeInvalid');
          }
        }

        return created;
      });

      return { id: user.id, name: user.name, email: user.email };
    }),

  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: newPasswordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.user.id },
      });
      if (!user?.passwordHash) {
        throw new AppError('BAD_REQUEST', 'noPasswordToChange');
      }

      // Wrong current passwords are limited like attempts at the login form, so a session someone
      // else holds can't guess the password here faster than there. A counter of its own: one
      // shared with the login form would let anyone who knows the address block this change
      const guessKey = `password-change:${user.id}`;
      if (!peekRateLimit(guessKey, loginAttemptsPerEmail()).allowed) {
        throw new AppError('TOO_MANY_REQUESTS');
      }
      const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
      if (!valid) {
        checkRateLimit(guessKey, loginAttemptsPerEmail(), LOGIN_WINDOW_MS);
        throw new AppError('UNAUTHORIZED', 'wrongPassword');
      }

      const passwordHash = await bcrypt.hash(input.newPassword, 12);
      await ctx.db.$transaction(async (tx) => {
        // Only while the password is still the one just checked: a reset link used meanwhile
        // wins, and this change is refused. Writes the user row before the token row, the lock
        // order resetPasswordWithToken uses. passwordChangedAt ends every session signed in
        // under the old password, this one included (auth.ts); the Settings page signs in again
        const { count } = await tx.user.updateMany({
          where: { id: ctx.user.id, passwordHash: user.passwordHash },
          data: { passwordHash, passwordChangedAt: new Date() },
        });
        if (count === 0) {
          throw new AppError('CONFLICT');
        }
        // A reset link sent before the change would otherwise still undo it
        await tx.passwordResetToken.deleteMany({ where: { userId: ctx.user.id } });
      });

      // The current password was just proven: failed sign-ins before don't keep the new one out
      // (the Settings page signs in again with it)
      clearRateLimit(loginRateLimitKey(user.email));
      notifyPasswordChanged(user);
      return { success: true };
    }),

  // "Forgot password?" (#397). The answer is the same whether or not the address has an
  // account: the lookup and the email aren't waited for, so neither its content nor its timing
  // tells. A failed email is only logged, and an account's email budget (password-reset.ts)
  // running out is silent.
  requestPasswordReset: publicProcedure
    .input(z.object({ email: z.string().trim().email().max(254) }))
    .mutation(({ ctx, input }) => {
      const config = parseAuthConfig(process.env);
      if (!config.passwordLogin) {
        throw new AppError('FORBIDDEN', 'passwordLoginDisabled');
      }
      if (!config.magicLink) {
        throw new AppError('PRECONDITION_FAILED', 'passwordResetUnavailable');
      }

      // The same for every address, so being limited doesn't tell whether it has an account
      checkClientLimit(ctx.headers, 'password-reset-ip', resetRequestsPerIp(), RESET_REQUEST_WINDOW_MS);

      // The server is a long-running Node process (standalone or `next start`), so the work
      // carries on after the answer is sent.
      void emailPasswordResetLink(ctx.db, input.email).catch((error: unknown) => {
        logger.warn('auth.password_reset_email_failed', describeMailError(error));
      });
      return { ok: true };
    }),

  // Sets a new password with a reset link's token (#397), from an emailed link or one an admin made
  resetPassword: publicProcedure
    .input(z.object({ token: z.string().min(1).max(200), password: newPasswordSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!parseAuthConfig(process.env).passwordLogin) {
        throw new AppError('FORBIDDEN', 'passwordLoginDisabled');
      }
      checkClientLimit(ctx.headers, 'password-reset-submit-ip', resetSubmitsPerIp(), RESET_SUBMIT_WINDOW_MS);
      // Hashes the password only once the link is claimed, so a bad or reused link costs no bcrypt
      const user = await resetPasswordWithToken(ctx.db, input.token, input.password);
      if (!user) {
        throw new AppError('BAD_REQUEST', 'resetLinkInvalid');
      }

      // The link proved who they are, so failed sign-ins from before the reset don't keep the
      // new password out
      clearRateLimit(loginRateLimitKey(user.email));
      logger.info('auth.password_reset', { userId: user.userId });
      notifyPasswordChanged(user);
      return { ok: true };
    }),

  getProfile: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        venmoUsername: true,
        locale: true,
        defaultCurrency: true,
        passwordHash: true,
      },
    });
    if (!user) {
      throw new AppError('NOT_FOUND', 'userNotFound');
    }
    const { passwordHash, ...profile } = user;
    return { ...profile, hasPassword: passwordHash !== null };
  }),

  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100).optional(),
        defaultCurrency: z.string().length(3).optional(),
        locale: z.enum(locales).optional(),
        venmoUsername: z.string().max(50).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const data = {
        ...stripUndefined(input),
        ...(input.venmoUsername !== undefined ? { venmoUsername: input.venmoUsername?.trim() || null } : {}),
      };
      const user = await ctx.db.user.update({
        where: { id: ctx.user.id },
        data,
      });
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        locale: user.locale,
        venmoUsername: user.venmoUsername,
      };
    }),
});
