import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z } from "zod";
import { auth } from "../auth";
import { db } from "../db";

export const createTRPCContext = async () => {
  const session = await auth();
  return { session, db };
};

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
});

export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
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
