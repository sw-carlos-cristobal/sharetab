import { z } from "zod";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure, protectedProcedure } from "../init";
import { checkRateLimit } from "../../lib/rate-limit";

export const authRouter = createTRPCRouter({
  getSession: publicProcedure.query(({ ctx }) => {
    return ctx.session;
  }),

  getRegistrationMode: publicProcedure.query(async ({ ctx }) => {
    const setting = await ctx.db.systemSetting.findUnique({
      where: { key: "registrationMode" },
    });
    return { mode: (setting?.value ?? "open") as "open" | "invite-only" | "closed" };
  }),

  register: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        email: z.string().email(),
        password: z.string().min(8).max(100),
        inviteCode: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Rate limit: 10 registrations per hour per IP (fall back to global key)
      const ip = ctx.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "global";
      const maxRegAttempts = parseInt(process.env.REGISTER_RATE_LIMIT_MAX ?? "10");
      const { allowed } = checkRateLimit(`register:${ip}`, maxRegAttempts, 60 * 60 * 1000);
      if (!allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many registration attempts. Please try again later.",
        });
      }

      // Check registration mode
      const modeSetting = await ctx.db.systemSetting.findUnique({
        where: { key: "registrationMode" },
      });
      const mode = modeSetting?.value ?? "open";

      if (mode === "closed") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Registration is currently closed.",
        });
      }

      if (mode === "invite-only") {
        if (!input.inviteCode) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "An invite code is required to register.",
          });
        }

        const invite = await ctx.db.systemInvite.findUnique({
          where: { code: input.inviteCode },
        });

        if (
          !invite ||
          invite.revokedAt ||
          invite.usedAt ||
          (invite.expiresAt && invite.expiresAt < new Date())
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Invalid or expired invite code.",
          });
        }
      }

      const existing = await ctx.db.user.findUnique({
        where: { email: input.email },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Unable to create account. Please try a different email or sign in.",
        });
      }

      const passwordHash = await bcrypt.hash(input.password, 12);
      const user = await ctx.db.user.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash,
        },
      });

      // Mark invite as used if provided
      if (input.inviteCode && mode === "invite-only") {
        await ctx.db.systemInvite.update({
          where: { code: input.inviteCode },
          data: { usedById: user.id, usedAt: new Date() },
        });
      }

      return { id: user.id, name: user.name, email: user.email };
    }),

  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.user.id },
      });
      if (!user?.passwordHash) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Account uses OAuth or magic link — no password to change",
        });
      }

      const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Current password is incorrect",
        });
      }

      const passwordHash = await bcrypt.hash(input.newPassword, 12);
      await ctx.db.user.update({
        where: { id: ctx.user.id },
        data: { passwordHash },
      });

      return { success: true };
    }),

  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100).optional(),
        defaultCurrency: z.string().length(3).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.update({
        where: { id: ctx.user.id },
        data: input,
      });
      return { id: user.id, name: user.name, email: user.email };
    }),
});
