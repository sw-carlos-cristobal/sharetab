import { z } from 'zod';
import { AppError } from '@/server/lib/app-error';
import { createTRPCRouter, groupMemberProcedure } from '../init';
import { getExchangeRate, convertCents } from '../../lib/exchange-rates';
import { MAX_MONEY_CENTS } from '@/lib/money';
import { lockActiveGroup } from '../../lib/group-balances';

export const settlementsRouter = createTRPCRouter({
  list: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.settlement.findMany({
        where: { groupId: input.groupId },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        include: {
          from: { select: { id: true, name: true, email: true, image: true } },
          to: { select: { id: true, name: true, email: true, image: true } },
        },
        orderBy: [{ settledAt: 'desc' }, { id: 'desc' }],
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
        amount: z.number().int().positive().max(MAX_MONEY_CENTS),
        currency: z
          .string()
          .length(3)
          .regex(/^[a-zA-Z]{3}$/)
          .transform((c) => c.toUpperCase())
          .default('USD'),
        exchangeRate: z.number().positive().finite().max(1_000_000).optional(), // manual override
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const effectiveFromId = input.fromId ?? ctx.user.id;

      // Refuse an archived group before the checks and rate lookup below;
      // lockActiveGroup in the transaction is the check that holds (#289)
      const group = await ctx.db.group.findUnique({
        where: { id: input.groupId },
        select: { archivedAt: true, currency: true },
      });
      if (group?.archivedAt) {
        throw new AppError('BAD_REQUEST', 'archivedCreateSettlement');
      }

      // Cannot settle with yourself
      if (effectiveFromId === input.toId) {
        throw new AppError('BAD_REQUEST', 'settleWithYourself');
      }

      // Security: non-admin members can only create settlements from themselves
      if (ctx.membership.role === 'MEMBER' && input.fromId && input.fromId !== ctx.user.id) {
        throw new AppError('FORBIDDEN', 'paymentsFromYourselfOnly');
      }

      // Currency conversion: compute base currency amount if currencies differ
      const groupCurrency = group?.currency ?? 'USD';
      let exchangeRate: number | null = null;
      let baseCurrencyAmount: number | null = null;

      if (input.currency.toUpperCase() !== groupCurrency.toUpperCase()) {
        if (input.exchangeRate) {
          exchangeRate = input.exchangeRate;
        } else {
          exchangeRate = await getExchangeRate(input.currency, groupCurrency);
        }

        if (exchangeRate === null) {
          throw new AppError('BAD_REQUEST', 'exchangeRateUnavailable');
        }

        baseCurrencyAmount = convertCents(input.amount, exchangeRate);
      }

      const settlement = await ctx.db.$transaction(async (tx) => {
        await lockActiveGroup(tx, input.groupId, 'archivedCreateSettlement');

        // Validate both fromId and toId are members of the group (after the lock,
        // so someone leaving meanwhile is either gone or waits for this, #279)
        const memberCount = await tx.groupMember.count({
          where: {
            groupId: input.groupId,
            userId: { in: [effectiveFromId, input.toId] },
          },
        });
        if (memberCount < 2) {
          throw new AppError('BAD_REQUEST', 'settlementPartiesNotMembers');
        }

        const created = await tx.settlement.create({
          data: {
            groupId: input.groupId,
            fromId: effectiveFromId,
            toId: input.toId,
            amount: input.amount,
            currency: input.currency,
            exchangeRate: exchangeRate ?? 1.0,
            baseCurrencyAmount,
            ...(input.note !== undefined ? { note: input.note } : {}),
          },
        });

        await tx.activityLog.create({
          data: {
            groupId: input.groupId,
            userId: ctx.user.id,
            type: 'SETTLEMENT_CREATED',
            entityId: created.id,
            metadata: { toId: input.toId, amount: input.amount },
          },
        });

        return created;
      });

      return settlement;
    }),

  delete: groupMemberProcedure
    .input(z.object({ groupId: z.string(), settlementId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.db.group.findUnique({
        where: { id: input.groupId },
        select: { archivedAt: true },
      });
      if (group?.archivedAt) {
        throw new AppError('BAD_REQUEST', 'archivedDeletePayment');
      }

      const settlement = await ctx.db.settlement.findUnique({
        where: { id: input.settlementId },
      });
      if (!settlement || settlement.groupId !== input.groupId) {
        throw new AppError('NOT_FOUND');
      }

      // A member can only record a payment from themselves, so the payer is
      // whoever recorded it unless an owner/admin recorded it for them. The
      // recipient can't delete it: that would let them deny being paid.
      const isOwnerOrAdmin = ctx.membership.role === 'OWNER' || ctx.membership.role === 'ADMIN';
      if (!isOwnerOrAdmin && settlement.fromId !== ctx.user.id) {
        throw new AppError('FORBIDDEN', 'onlyPayerDeletesPayment');
      }

      await ctx.db.$transaction(async (tx) => {
        await lockActiveGroup(tx, input.groupId, 'archivedDeletePayment');
        // deleteMany so a payment someone else deleted in the meantime is NOT_FOUND, not a Prisma error
        const { count } = await tx.settlement.deleteMany({
          where: { id: input.settlementId, groupId: input.groupId },
        });
        if (count === 0) {
          throw new AppError('NOT_FOUND');
        }

        await tx.activityLog.create({
          data: {
            groupId: input.groupId,
            userId: ctx.user.id,
            type: 'SETTLEMENT_DELETED',
            entityId: input.settlementId,
            metadata: {
              fromId: settlement.fromId,
              toId: settlement.toId,
              amount: settlement.amount,
              currency: settlement.currency,
            },
          },
        });
      });

      return { success: true };
    }),
});
