import { z } from "zod";
import { createTRPCRouter, groupMemberProcedure } from "../init";

export const settlementsRouter = createTRPCRouter({
  list: groupMemberProcedure
    .input(z.object({ groupId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.settlement.findMany({
        where: { groupId: input.groupId },
        include: {
          from: { select: { id: true, name: true, image: true } },
          to: { select: { id: true, name: true, image: true } },
        },
        orderBy: { settledAt: "desc" },
      });
    }),

  create: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        fromId: z.string().optional(),
        toId: z.string(),
        amount: z.number().int().positive(),
        currency: z.string().length(3).default("USD"),
        note: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const settlement = await ctx.db.settlement.create({
        data: {
          groupId: input.groupId,
          fromId: input.fromId ?? ctx.user.id,
          toId: input.toId,
          amount: input.amount,
          currency: input.currency,
          note: input.note,
        },
      });

      await ctx.db.activityLog.create({
        data: {
          groupId: input.groupId,
          userId: ctx.user.id,
          type: "SETTLEMENT_CREATED",
          metadata: { toId: input.toId, amount: input.amount },
        },
      });

      return settlement;
    }),
});
