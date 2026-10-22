import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { AppError } from '@/server/lib/app-error';
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../init';
import { checkRateLimit, parsePositiveInt } from '../../lib/rate-limit';
import { getClientIp } from '../../lib/client-ip';
import { locales } from '@/i18n/routing';
import { stripUndefined } from '../../lib/strip-undefined';
import { parseAuthConfig } from '../../lib/auth-config';
import { findUsersByEmail } from '../../lib/user-email';
import { Prisma } from '@/generated/prisma/client';

export const authRouter = createTRPCRouter({
  getSession: publicProcedure.query(({ ctx }) => {
    return ctx.session;
  }),

  // Which sign-in methods the login page should offer. Never includes the
  // OIDC issuer or secrets — only what the UI renders.
  getLoginOptions: publicProcedure.query(() => {
    const config = parseAuthConfig(process.env);
    return {
      passwordLogin: config.passwordLogin,
      magicLink: config.magicLink,
      oidc: config.oidc ? { name: config.oidc.displayName } : null,
    };
  }),

  getRegistrationMode: publicProcedure.query(async ({ ctx }) => {
    // The register form creates password accounts; with password login
    // disabled it is closed whatever the admin setting says.
    if (!parseAuthConfig(process.env).passwordLogin) {
      return { mode: 'closed' as const };
    }
    const setting = await ctx.db.systemSetting.findUnique({
      where: { key: 'registrationMode' },
    });
    return { mode: (setting?.value ?? 'open') as 'open' | 'invite-only' | 'closed' };
  }),

  register: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        email: z.string().email(),
        password: z.string().min(8).max(100),
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
      const modeSetting = await ctx.db.systemSetting.findUnique({
        where: { key: 'registrationMode' },
      });
      const mode = modeSetting?.value ?? 'open';

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
        newPassword: z.string().min(8).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.user.id },
      });
      if (!user?.passwordHash) {
        throw new AppError('BAD_REQUEST', 'noPasswordToChange');
      }

      const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
      if (!valid) {
        throw new AppError('UNAUTHORIZED', 'wrongPassword');
      }

      const passwordHash = await bcrypt.hash(input.newPassword, 12);
      await ctx.db.user.update({
        where: { id: ctx.user.id },
        data: { passwordHash },
      });

      return { success: true };
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
