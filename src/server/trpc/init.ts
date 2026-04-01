import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z } from "zod";
import { cookies } from "next/headers";
import { auth } from "../auth";
import { db } from "../db";
import { logger } from "../lib/logger";

const IMPERSONATE_COOKIE = "sharetab-impersonate";

export const createTRPCContext = async (opts?: { req?: Request }) => {
  const session = await auth();
  const headers = opts?.req?.headers ?? new Headers();

  // Check for impersonation cookie
  let impersonating: {
    adminId: string;
    adminEmail: string;
    targetId: string;
    targetName: string | null;
    targetEmail: string;
  } | null = null;

  try {
    const cookieStore = await cookies();
    const impCookie = cookieStore.get(IMPERSONATE_COOKIE);
    if (impCookie?.value && session?.user) {
      const data = JSON.parse(impCookie.value);
      // Only apply if the real session belongs to the admin who started it
      if (data.adminId === session.user.id) {
        impersonating = data;
        // Swap session user to the impersonated user
        if (session.user) {
          session.user.id = data.targetId;
          session.user.name = data.targetName;
          session.user.email = data.targetEmail;
        }
      }
    }
  } catch {
    // Ignore malformed cookie
  }

  return { session, db, headers, impersonating };
};

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
});

const loggingMiddleware = t.middleware(async ({ path, type, next, ctx }) => {
  const start = Date.now();
  const userId = ctx.session?.user?.id;

  const result = await next();

  const durationMs = Date.now() - start;
  const ok = result.ok;

  if (ok) {
    logger.info("trpc.ok", { path, type, userId, durationMs });
  } else {
    logger.warn("trpc.error", { path, type, userId, durationMs });
  }

  return result;
});

export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure.use(loggingMiddleware);

export const protectedProcedure = t.procedure
  .use(loggingMiddleware)
  .use(async ({ ctx, next }) => {
    if (!ctx.session?.user?.id) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }

    // Check if user is suspended
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { suspendedAt: true },
    });

    if (user?.suspendedAt) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Your account has been suspended. Please contact an administrator.",
      });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.session.user,
      },
    });
  });

export const groupMemberProcedure = protectedProcedure
  .input(z.object({ groupId: z.string() }))
  .use(async ({ ctx, input, next }) => {
    const membership = await ctx.db.groupMember.findUnique({
      where: {
        userId_groupId: {
          userId: ctx.user.id,
          groupId: input.groupId,
        },
      },
    });
    if (!membership) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Not a member of this group" });
    }
    return next({ ctx: { ...ctx, membership } });
  });
