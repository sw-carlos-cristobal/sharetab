import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z } from "zod";
import { auth } from "../auth";
import { db } from "../db";
import { logger } from "../lib/logger";

export const createTRPCContext = async (opts?: { req?: Request }) => {
  const session = await auth();
  const headers = opts?.req?.headers ?? new Headers();
  return { session, db, headers };
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

export const protectedProcedure = t.procedure.use(loggingMiddleware).use(({ ctx, next }) => {
  if (!ctx.session?.user?.id) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
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
