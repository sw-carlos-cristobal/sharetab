import { z } from 'zod';
import { AppError } from '@/server/lib/app-error';
import { createTRPCRouter, groupMemberProcedure } from '../init';
import { SplitMode } from '@/generated/prisma/client';
import { getExchangeRate, convertCents } from '../../lib/exchange-rates';
import { MAX_MONEY_CENTS } from '@/lib/money';
import { stripUndefined } from '../../lib/strip-undefined';
import { lockActiveGroup } from '../../lib/group-balances';

const expenseShareSchema = z.object({
  userId: z.string(),
  amount: z.number().int().nonnegative().max(MAX_MONEY_CENTS),
  shares: z.number().int().optional(),
  percentage: z.number().int().optional(),
});

const expenseSharesArraySchema = z
  .array(expenseShareSchema)
  .min(1)
  .refine((shares) => new Set(shares.map((s) => s.userId)).size === shares.length, {
    message: 'Duplicate user in shares',
  });

const exchangeRateSchema = z.number().positive().finite().max(1_000_000);

export const expensesRouter = createTRPCRouter({
  list: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const expenses = await ctx.db.expense.findMany({
        where: { groupId: input.groupId },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        orderBy: { expenseDate: 'desc' },
        include: {
          paidBy: { select: { id: true, name: true, email: true, image: true } },
          shares: {
            include: { user: { select: { id: true, name: true, email: true, image: true } } },
          },
        },
      });

      let nextCursor: string | undefined;
      if (expenses.length > input.limit) {
        const next = expenses.pop();
        nextCursor = next?.id;
      }

      return { expenses, nextCursor };
    }),

  get: groupMemberProcedure
    .input(z.object({ groupId: z.string(), expenseId: z.string() }))
    .query(async ({ ctx, input }) => {
      const expense = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
        include: {
          paidBy: { select: { id: true, name: true, email: true, image: true } },
          addedBy: { select: { id: true, name: true, email: true, image: true } },
          shares: {
            include: { user: { select: { id: true, name: true, email: true, image: true } } },
          },
        },
      });
      if (!expense || expense.groupId !== input.groupId) {
        throw new AppError('NOT_FOUND');
      }
      return expense;
    }),

  create: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        title: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
        amount: z.number().int().positive().max(MAX_MONEY_CENTS),
        currency: z
          .string()
          .length(3)
          .regex(/^[a-zA-Z]{3}$/)
          .transform((c) => c.toUpperCase())
          .default('USD'),
        exchangeRate: exchangeRateSchema.optional(), // manual override
        category: z.string().max(50).optional(),
        expenseDate: z.string().datetime().optional(),
        paidById: z.string(),
        splitMode: z.nativeEnum(SplitMode),
        shares: expenseSharesArraySchema,
        receiptId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Refuse an archived group before the checks and rate lookup below;
      // lockActiveGroup in the transaction is the check that holds (#289)
      const group = await ctx.db.group.findUnique({
        where: { id: input.groupId },
        select: { archivedAt: true, currency: true },
      });
      if (group?.archivedAt) {
        throw new AppError('BAD_REQUEST', 'archivedAddExpense');
      }

      // Validate shares sum equals total (in expense's original currency)
      const sharesSum = input.shares.reduce((sum, s) => sum + s.amount, 0);
      if (sharesSum !== input.amount) {
        throw new AppError('BAD_REQUEST', 'sharesSumMismatch', { sum: sharesSum, amount: input.amount });
      }

      // Currency conversion: compute base currency amount if currencies differ
      let exchangeRate: number | null = null;
      let baseCurrencyAmount: number | null = null;

      const groupCurrency = group?.currency ?? 'USD';
      if (input.currency.toUpperCase() !== groupCurrency.toUpperCase()) {
        if (input.exchangeRate) {
          // Manual override
          exchangeRate = input.exchangeRate;
        } else {
          // Auto-fetch from frankfurter.app
          const dateStr = input.expenseDate
            ? input.expenseDate.slice(0, 10) // YYYY-MM-DD from ISO string
            : undefined;
          exchangeRate = await getExchangeRate(input.currency, groupCurrency, dateStr);
        }

        if (exchangeRate === null) {
          throw new AppError('BAD_REQUEST', 'exchangeRateUnavailable');
        }

        baseCurrencyAmount = convertCents(input.amount, exchangeRate);
      }

      const expense = await ctx.db.$transaction(async (tx) => {
        await lockActiveGroup(tx, input.groupId, 'archivedAddExpense');

        // Validate paidById is a member of the group (after the lock, so someone
        // leaving meanwhile is either gone or waits for this, #279)
        const paidByMember = await tx.groupMember.findFirst({
          where: { groupId: input.groupId, userId: input.paidById },
        });
        if (!paidByMember) {
          throw new AppError('BAD_REQUEST', 'paidByNotMember');
        }

        // Validate all share userIds are group members
        const shareUserIds = input.shares.map((s) => s.userId);
        const memberCount = await tx.groupMember.count({
          where: { groupId: input.groupId, userId: { in: shareUserIds } },
        });
        if (memberCount !== new Set(shareUserIds).size) {
          throw new AppError('BAD_REQUEST', 'shareUsersNotMembers');
        }

        const created = await tx.expense.create({
          data: {
            groupId: input.groupId,
            title: input.title,
            ...(input.description !== undefined ? { description: input.description } : {}),
            amount: input.amount,
            currency: input.currency,
            exchangeRate: exchangeRate ?? 1.0,
            baseCurrencyAmount,
            ...(input.category !== undefined ? { category: input.category } : {}),
            expenseDate: input.expenseDate ? new Date(input.expenseDate) : new Date(),
            paidById: input.paidById,
            addedById: ctx.user.id,
            splitMode: input.splitMode,
            ...(input.receiptId !== undefined ? { receiptId: input.receiptId } : {}),
            shares: {
              create: input.shares.map((s) => ({
                userId: s.userId,
                amount: s.amount,
                shares: s.shares ?? 1,
                ...(s.percentage !== undefined ? { percentage: s.percentage } : {}),
              })),
            },
          },
          include: {
            shares: true,
          },
        });

        await tx.activityLog.create({
          data: {
            groupId: input.groupId,
            userId: ctx.user.id,
            type: 'EXPENSE_CREATED',
            entityId: created.id,
            metadata: { title: input.title, amount: input.amount },
          },
        });

        return created;
      });

      return expense;
    }),

  update: groupMemberProcedure
    .input(
      z
        .object({
          groupId: z.string(),
          expenseId: z.string(),
          title: z.string().min(1).max(200).optional(),
          description: z.string().max(1000).optional(),
          amount: z.number().int().positive().max(MAX_MONEY_CENTS).optional(),
          currency: z
            .string()
            .length(3)
            .regex(/^[a-zA-Z]{3}$/)
            .transform((c) => c.toUpperCase())
            .optional(),
          exchangeRate: exchangeRateSchema.optional(), // manual override
          category: z.string().max(50).optional(),
          expenseDate: z.string().datetime().optional(),
          paidById: z.string().optional(),
          splitMode: z.nativeEnum(SplitMode).optional(),
          shares: expenseSharesArraySchema.optional(),
        })
        .refine((data) => !data.amount || data.shares, {
          message: 'Shares are required when updating the amount',
          path: ['shares'],
        }),
    )
    .mutation(async ({ ctx, input }) => {
      // Refuse an archived group before the checks and rate lookup below;
      // lockActiveGroup in the transaction is the check that holds (#289)
      const groupCheck = await ctx.db.group.findUnique({
        where: { id: input.groupId },
        select: { archivedAt: true, currency: true },
      });
      if (groupCheck?.archivedAt) {
        throw new AppError('BAD_REQUEST', 'archivedEditExpense');
      }

      const existing = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
      });
      if (!existing || existing.groupId !== input.groupId) {
        throw new AppError('NOT_FOUND');
      }

      const isOwnerOrAdmin = ctx.membership.role === 'OWNER' || ctx.membership.role === 'ADMIN';
      const isCreatorOrPayer = existing.paidById === ctx.user.id || existing.addedById === ctx.user.id;
      if (!isOwnerOrAdmin && !isCreatorOrPayer) {
        throw new AppError('FORBIDDEN', 'onlyCreatorEditsExpense');
      }

      const { groupId, expenseId, shares, currency: inputCurrency, exchangeRate: inputExchangeRate, ...data } = input;

      if (shares) {
        const expectedAmount = data.amount ?? existing.amount;
        const sharesSum = shares.reduce((sum, s) => sum + s.amount, 0);
        if (sharesSum !== expectedAmount) {
          throw new AppError('BAD_REQUEST', 'sharesSumMismatch', { sum: sharesSum, amount: expectedAmount });
        }
      }

      // Recompute currency conversion if currency or amount changed
      const effectiveCurrency = inputCurrency ?? existing.currency;
      const effectiveAmount = data.amount ?? existing.amount;
      const groupCurrency = groupCheck?.currency ?? 'USD';
      let newExchangeRate: number | null = existing.exchangeRate;
      let newBaseCurrencyAmount: number | null = existing.baseCurrencyAmount;

      if (effectiveCurrency.toUpperCase() !== groupCurrency.toUpperCase()) {
        if (inputExchangeRate) {
          newExchangeRate = inputExchangeRate;
        } else if (inputCurrency || data.amount || data.expenseDate) {
          // Currency, amount, or date changed -- re-fetch rate
          const dateStr = (data.expenseDate ?? existing.expenseDate.toISOString()).slice(0, 10);
          const fetched = await getExchangeRate(effectiveCurrency, groupCurrency, dateStr);
          if (fetched === null) {
            throw new AppError('BAD_REQUEST', 'exchangeRateUnavailable');
          }
          newExchangeRate = fetched;
        }
        newBaseCurrencyAmount = newExchangeRate ? convertCents(effectiveAmount, newExchangeRate) : null;
      } else {
        // Same currency as group -- clear conversion fields
        newExchangeRate = 1.0;
        newBaseCurrencyAmount = null;
      }

      const expense = await ctx.db.$transaction(async (tx) => {
        await lockActiveGroup(tx, groupId, 'archivedEditExpense');

        // Validate a new payer and the shares' people are members (after the lock,
        // so someone leaving meanwhile is either gone or waits for this, #279)
        if (input.paidById) {
          const paidByMember = await tx.groupMember.findFirst({
            where: { groupId, userId: input.paidById },
          });
          if (!paidByMember) {
            throw new AppError('BAD_REQUEST', 'paidByNotMember');
          }
        }
        if (shares) {
          const shareUserIds = shares.map((s) => s.userId);
          const memberCount = await tx.groupMember.count({
            where: { groupId, userId: { in: shareUserIds } },
          });
          if (memberCount !== new Set(shareUserIds).size) {
            throw new AppError('BAD_REQUEST', 'shareUsersNotMembers');
          }
        }

        if (shares) {
          await tx.expenseShare.deleteMany({ where: { expenseId } });
          await tx.expenseShare.createMany({
            data: shares.map((s) => ({
              expenseId,
              userId: s.userId,
              amount: s.amount,
              shares: s.shares ?? 1,
              ...(s.percentage !== undefined ? { percentage: s.percentage } : {}),
            })),
          });
        }

        const updated = await tx.expense.update({
          where: { id: expenseId },
          data: {
            ...stripUndefined(data),
            ...(inputCurrency ? { currency: inputCurrency } : {}),
            exchangeRate: newExchangeRate ?? 1.0,
            baseCurrencyAmount: newBaseCurrencyAmount,
            ...(data.expenseDate ? { expenseDate: new Date(data.expenseDate) } : {}),
          },
          include: { shares: true },
        });

        await tx.activityLog.create({
          data: {
            groupId,
            userId: ctx.user.id,
            type: 'EXPENSE_UPDATED',
            entityId: expenseId,
          },
        });

        return updated;
      });

      return expense;
    }),

  delete: groupMemberProcedure
    .input(z.object({ groupId: z.string(), expenseId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const groupCheck = await ctx.db.group.findUnique({
        where: { id: input.groupId },
        select: { archivedAt: true },
      });
      if (groupCheck?.archivedAt) {
        throw new AppError('BAD_REQUEST', 'archivedDeleteExpense');
      }

      const expense = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
      });
      if (!expense || expense.groupId !== input.groupId) {
        throw new AppError('NOT_FOUND');
      }

      const isOwnerOrAdmin = ctx.membership.role === 'OWNER' || ctx.membership.role === 'ADMIN';
      const isCreatorOrPayer = expense.paidById === ctx.user.id || expense.addedById === ctx.user.id;
      if (!isOwnerOrAdmin && !isCreatorOrPayer) {
        throw new AppError('FORBIDDEN', 'onlyCreatorDeletesExpense');
      }

      await ctx.db.$transaction(async (tx) => {
        await lockActiveGroup(tx, input.groupId, 'archivedDeleteExpense');
        await tx.expense.delete({ where: { id: input.expenseId } });

        await tx.activityLog.create({
          data: {
            groupId: input.groupId,
            userId: ctx.user.id,
            type: 'EXPENSE_DELETED',
            entityId: input.expenseId,
            metadata: { title: expense.title, amount: expense.amount },
          },
        });
      });

      return { success: true };
    }),
});
