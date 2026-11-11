import { z } from 'zod';
import { AppError } from '@/server/lib/app-error';
import { createTRPCRouter, groupMemberProcedure } from '../init';
import type { Prisma } from '@/generated/prisma/client';
import { getExchangeRate, convertCents } from '../../lib/exchange-rates';
import { MAX_MONEY_CENTS, currencyStep } from '@/lib/money';
import { loadGroupBalances, lockActiveGroup } from '../../lib/group-balances';
import { simplifyDebts } from '../../lib/balance-calculator';
import { notDeleted, onlyDeleted } from '../../lib/soft-delete';

/**
 * Refuse a payment (a new one, or a deleted one being restored, #327) unless both people have a
 * membership row, and, when one of them was removed, unless it only settles their balance. Called after lockActiveGroup, so someone leaving meanwhile is
 * either gone or waits for this write (#279). `paid` is its amount in the group's currency.
 */
async function requireSettleableParties(
  tx: Prisma.TransactionClient,
  groupId: string,
  fromId: string,
  toId: string,
  paid: number,
) {
  const memberCount = await tx.groupMember.count({
    where: { groupId, userId: { in: [fromId, toId] } },
  });
  if (memberCount < 2) {
    throw new AppError('BAD_REQUEST', 'settlementPartiesNotMembers');
  }

  // Someone removed from the group (#284, #323) is still counted above, so a
  // balance with them (open when they left, or one that comes back) can be
  // settled. But the payment may only settle it, not make a new one: they're no
  // longer in the group. Two such checked writes at once (payments recorded or
  // restored, or an expense restore naming them) can each pass (the group lock the
  // caller holds is shared); what they overpay can still be settled the same way.
  const removed = await tx.groupMember.findMany({
    where: { groupId, userId: { in: [fromId, toId] }, removedAt: { not: null } },
    select: { userId: true },
  });
  if (removed.length > 0) {
    const balances = await loadGroupBalances(tx, groupId);
    const net = (userId: string) => balances.find((b) => b.userId === userId)?.net ?? 0;
    // A positive net is owed to them: paying them settles it, and they pay what they owe
    const settles = removed.every(({ userId }) => (userId === toId ? paid <= net(userId) : paid <= -net(userId)));
    if (!settles) {
      throw new AppError('BAD_REQUEST', 'settlementRemovedMemberOverpaid');
    }
  }
}

// Who may delete a payment, and so restore it (#327). A member can only record a payment
// from themselves, so the payer is whoever recorded it unless an owner/admin recorded it
// for them. The recipient can't: deleting it would let them deny being paid.
function mayRemovePayment(membership: { role: string }, userId: string, payment: { fromId: string }) {
  return membership.role === 'OWNER' || membership.role === 'ADMIN' || payment.fromId === userId;
}

export const settlementsRouter = createTRPCRouter({
  list: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(100),
        // The group page's Deleted section lists only deleted payments (#327)
        deleted: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.settlement.findMany({
        where: { groupId: input.groupId, ...(input.deleted ? onlyDeleted : notDeleted) },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        include: {
          from: { select: { id: true, name: true, email: true, image: true } },
          to: { select: { id: true, name: true, email: true, image: true } },
          deletedBy: { select: { id: true, name: true } },
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

      // Amounts in a currency with no decimals are whole units (#335), except a payment in the
      // group's currency that pays off exactly a debt with hundredths (left by amounts saved before
      // #335, or a receipt expense's shares): one the group page lists (`simplifyDebts`), all the
      // payer owes, or all the payee is owed, checked against the balances under the group lock below
      const groupCurrency = group?.currency ?? 'USD';
      const wholeUnits = input.amount % currencyStep(input.currency) === 0;
      if (!wholeUnits && input.currency !== groupCurrency.toUpperCase()) {
        throw new AppError('BAD_REQUEST', 'amountNotWholeUnits', { currency: input.currency });
      }

      // Currency conversion: compute base currency amount if currencies differ
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

        baseCurrencyAmount = convertCents(input.amount, exchangeRate, groupCurrency);
      }

      const settlement = await ctx.db.$transaction(async (tx) => {
        await lockActiveGroup(tx, input.groupId, 'archivedCreateSettlement');
        if (!wholeUnits) {
          const balances = await loadGroupBalances(tx, input.groupId);
          const net = (userId: string) => balances.find((b) => b.userId === userId)?.net ?? 0;
          const listedDebt = simplifyDebts(balances).some(
            (d) => d.from === effectiveFromId && d.to === input.toId && d.amount === input.amount,
          );
          if (!listedDebt && input.amount !== -net(effectiveFromId) && input.amount !== net(input.toId)) {
            throw new AppError('BAD_REQUEST', 'amountNotWholeUnits', { currency: input.currency });
          }
        }
        // Balances are in the group's currency
        await requireSettleableParties(
          tx,
          input.groupId,
          effectiveFromId,
          input.toId,
          baseCurrencyAmount ?? input.amount,
        );

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
      if (!settlement || settlement.groupId !== input.groupId || settlement.deletedAt) {
        throw new AppError('NOT_FOUND');
      }

      if (!mayRemovePayment(ctx.membership, ctx.user.id, settlement)) {
        throw new AppError('FORBIDDEN', 'onlyPayerDeletesPayment');
      }

      await ctx.db.$transaction(async (tx) => {
        await lockActiveGroup(tx, input.groupId, 'archivedDeletePayment');
        // Marked deleted, not removed, so it can be restored (#327). Only while it isn't
        // already, so one someone else deleted in the meantime is NOT_FOUND.
        const { count } = await tx.settlement.updateMany({
          where: { id: input.settlementId, groupId: input.groupId, ...notDeleted },
          data: { deletedAt: new Date(), deletedById: ctx.user.id },
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

  // Brings a deleted payment back as it was (#327)
  restore: groupMemberProcedure
    .input(z.object({ groupId: z.string(), settlementId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.db.group.findUnique({
        where: { id: input.groupId },
        select: { archivedAt: true },
      });
      if (group?.archivedAt) {
        throw new AppError('BAD_REQUEST', 'archivedRestorePayment');
      }

      const settlement = await ctx.db.settlement.findUnique({
        where: { id: input.settlementId },
      });
      if (!settlement || settlement.groupId !== input.groupId) {
        throw new AppError('NOT_FOUND');
      }
      if (!settlement.deletedAt) {
        throw new AppError('BAD_REQUEST', 'paymentNotDeleted');
      }
      if (!mayRemovePayment(ctx.membership, ctx.user.id, settlement)) {
        throw new AppError('FORBIDDEN', 'onlyPayerRestoresPayment');
      }

      await ctx.db.$transaction(async (tx) => {
        await lockActiveGroup(tx, input.groupId, 'archivedRestorePayment');

        // Under the payment's row lock, so a restore or delete racing this one is seen. Its
        // amount can't change while it's deleted (nothing edits a payment); a merge can move it
        // from a placeholder to a current member, or delete it when it's between the two, so its
        // people are read here, and who may restore it is checked again.
        const [stored] = await tx.$queryRaw<{ fromId: string; toId: string; deletedAt: Date | null }[]>`
          SELECT "fromId", "toId", "deletedAt" FROM "Settlement" WHERE "id" = ${input.settlementId} FOR NO KEY UPDATE`;
        if (!stored) {
          throw new AppError('NOT_FOUND');
        }
        if (!stored.deletedAt) {
          throw new AppError('BAD_REQUEST', 'paymentNotDeleted');
        }
        if (!mayRemovePayment(ctx.membership, ctx.user.id, stored)) {
          throw new AppError('FORBIDDEN', 'onlyPayerRestoresPayment');
        }
        // What recording it would check now; the balances leave it out while it's deleted
        await requireSettleableParties(
          tx,
          input.groupId,
          stored.fromId,
          stored.toId,
          settlement.baseCurrencyAmount ?? settlement.amount,
        );

        await tx.settlement.update({
          where: { id: input.settlementId },
          data: { deletedAt: null, deletedById: null },
        });

        await tx.activityLog.create({
          data: {
            groupId: input.groupId,
            userId: ctx.user.id,
            type: 'SETTLEMENT_RESTORED',
            entityId: input.settlementId,
            metadata: {
              fromId: stored.fromId,
              toId: stored.toId,
              amount: settlement.amount,
              currency: settlement.currency,
            },
          },
        });
      });

      return { success: true };
    }),
});
