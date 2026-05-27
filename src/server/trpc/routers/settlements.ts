import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, groupMemberProcedure } from "../init";
import { getExchangeRate, convertCents } from "../../lib/exchange-rates";

export const settlementsRouter = createTRPCRouter({
  list: groupMemberProcedure
    .input(z.object({
      groupId: z.string(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(100),
    }))
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.settlement.findMany({
        where: { groupId: input.groupId },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        include: {
          from: { select: { id: true, name: true, image: true } },
          to: { select: { id: true, name: true, image: true } },
        },
        orderBy: [{ settledAt: "desc" }, { id: "desc" }],
      });

      let nextCursor: string | undefined;
      if (items.length > input.limit) {
        const next = items.pop();
        nextCursor = next?.id;
      }

      return { items, nextCursor };
    }),

  create: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        fromId: z.string().optional(),
        toId: z.string(),
        amount: z.number().int().positive(),
        currency: z.string().length(3).default("USD"),
        exchangeRate: z.number().positive().optional(), // manual override
        note: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const effectiveFromId = input.fromId ?? ctx.user.id;

      // Block settlements on archived groups
      const group = await ctx.db.group.findUnique({
        where: { id: input.groupId },
        select: { archivedAt: true, currency: true },
      });
      if (group?.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot create settlements in an archived group",
        });
      }

      // Cannot settle with yourself
      if (effectiveFromId === input.toId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot settle a debt with yourself",
        });
      }

      // Security: non-admin members can only create settlements from themselves
      if (
        ctx.membership.role === "MEMBER" &&
        input.fromId &&
        input.fromId !== ctx.user.id
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only record payments from yourself",
        });
      }

      // Validate both fromId and toId are members of the group
      const memberCount = await ctx.db.groupMember.count({
        where: {
          groupId: input.groupId,
          userId: { in: [effectiveFromId, input.toId] },
        },
      });
      if (memberCount < (effectiveFromId === input.toId ? 1 : 2)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Both the payer and recipient must be members of this group",
        });
      }

      // Currency conversion: compute base currency amount if currencies differ
      const groupCurrency = group?.currency ?? "USD";
      let exchangeRate: number | null = null;
      let baseCurrencyAmount: number | null = null;

      if (input.currency.toUpperCase() !== groupCurrency.toUpperCase()) {
        if (input.exchangeRate) {
          exchangeRate = input.exchangeRate;
        } else {
          exchangeRate = await getExchangeRate(input.currency, groupCurrency);
        }

        if (exchangeRate === null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Could not fetch exchange rate. Please provide a manual rate or try again.",
          });
        }

        baseCurrencyAmount = convertCents(input.amount, exchangeRate);
      }

      const settlement = await ctx.db.settlement.create({
        data: {
          groupId: input.groupId,
          fromId: effectiveFromId,
          toId: input.toId,
          amount: input.amount,
          currency: input.currency,
          exchangeRate: exchangeRate ?? 1.0,
          baseCurrencyAmount,
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
