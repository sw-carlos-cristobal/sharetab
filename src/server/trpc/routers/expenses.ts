import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, groupMemberProcedure } from "../init";
import { SplitMode } from "@/generated/prisma/client";
import { getExchangeRate, convertCents } from "../../lib/exchange-rates";

const expenseShareSchema = z.object({
  userId: z.string(),
  amount: z.number().int(),
  shares: z.number().int().optional(),
  percentage: z.number().int().optional(),
});

export const expensesRouter = createTRPCRouter({
  list: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const expenses = await ctx.db.expense.findMany({
        where: { groupId: input.groupId },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { expenseDate: "desc" },
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
          receipt: true,
        },
      });
      if (!expense || expense.groupId !== input.groupId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return expense;
    }),

  create: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        title: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
        amount: z.number().int().positive(),
        currency: z.string().length(3).transform((c) => c.toUpperCase()).default("USD"),
        exchangeRate: z.number().positive().optional(), // manual override
        category: z.string().max(50).optional(),
        expenseDate: z.string().datetime().optional(),
        paidById: z.string(),
        splitMode: z.nativeEnum(SplitMode),
        shares: z.array(expenseShareSchema).min(1),
        receiptId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Block expenses on archived groups
      const group = await ctx.db.group.findUnique({
        where: { id: input.groupId },
        select: { archivedAt: true, currency: true },
      });
      if (group?.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot add expenses to an archived group",
        });
      }

      // Validate paidById is a member of the group
      const paidByMember = await ctx.db.groupMember.findFirst({
        where: { groupId: input.groupId, userId: input.paidById },
      });
      if (!paidByMember) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Paid-by user is not a member of this group" });
      }

      // Validate all share userIds are group members
      const shareUserIds = input.shares.map((s) => s.userId);
      const memberCount = await ctx.db.groupMember.count({
        where: { groupId: input.groupId, userId: { in: shareUserIds } },
      });
      if (memberCount !== new Set(shareUserIds).size) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "One or more share users are not members of this group",
        });
      }

      // Validate shares sum equals total (in expense's original currency)
      const sharesSum = input.shares.reduce((sum, s) => sum + s.amount, 0);
      if (sharesSum !== input.amount) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Shares sum (${sharesSum}) does not equal expense amount (${input.amount})`,
        });
      }

      // Currency conversion: compute base currency amount if currencies differ
      let exchangeRate: number | null = null;
      let baseCurrencyAmount: number | null = null;

      const groupCurrency = group?.currency ?? "USD";
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
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Could not fetch exchange rate. Please provide a manual rate or try again.",
          });
        }

        baseCurrencyAmount = convertCents(input.amount, exchangeRate);
      }

      const expense = await ctx.db.expense.create({
        data: {
          groupId: input.groupId,
          title: input.title,
          description: input.description,
          amount: input.amount,
          currency: input.currency,
          exchangeRate: exchangeRate ?? 1.0,
          baseCurrencyAmount,
          category: input.category,
          expenseDate: input.expenseDate ? new Date(input.expenseDate) : new Date(),
          paidById: input.paidById,
          addedById: ctx.user.id,
          splitMode: input.splitMode,
          receiptId: input.receiptId,
          shares: {
            create: input.shares.map((s) => ({
              userId: s.userId,
              amount: s.amount,
              shares: s.shares ?? 1,
              percentage: s.percentage,
            })),
          },
        },
        include: {
          shares: true,
        },
      });

      await ctx.db.activityLog.create({
        data: {
          groupId: input.groupId,
          userId: ctx.user.id,
          type: "EXPENSE_CREATED",
          entityId: expense.id,
          metadata: { title: input.title, amount: input.amount },
        },
      });

      return expense;
    }),

  update: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        expenseId: z.string(),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(1000).optional(),
        amount: z.number().int().positive().optional(),
        currency: z.string().length(3).transform((c) => c.toUpperCase()).optional(),
        exchangeRate: z.number().positive().optional(), // manual override
        category: z.string().max(50).optional(),
        expenseDate: z.string().datetime().optional(),
        paidById: z.string().optional(),
        splitMode: z.nativeEnum(SplitMode).optional(),
        shares: z.array(expenseShareSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Block updates on archived groups
      const groupCheck = await ctx.db.group.findUnique({
        where: { id: input.groupId },
        select: { archivedAt: true, currency: true },
      });
      if (groupCheck?.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot modify expenses in an archived group",
        });
      }

      const existing = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
      });
      if (!existing || existing.groupId !== input.groupId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const isOwnerOrAdmin =
        ctx.membership.role === "OWNER" || ctx.membership.role === "ADMIN";
      const isCreatorOrPayer =
        existing.paidById === ctx.user.id || existing.addedById === ctx.user.id;
      if (!isOwnerOrAdmin && !isCreatorOrPayer) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the expense creator, payer, or group owner/admin can modify this expense",
        });
      }

      // Validate paidById is a member of the group (if provided)
      if (input.paidById) {
        const paidByMember = await ctx.db.groupMember.findFirst({
          where: { groupId: input.groupId, userId: input.paidById },
        });
        if (!paidByMember) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Paid-by user is not a member of this group" });
        }
      }

      const { groupId, expenseId, shares, currency: inputCurrency, exchangeRate: inputExchangeRate, ...data } = input;

      if (shares) {
        // Validate all share userIds are group members
        const shareUserIds = shares.map((s) => s.userId);
        const memberCount = await ctx.db.groupMember.count({
          where: { groupId, userId: { in: shareUserIds } },
        });
        if (memberCount !== new Set(shareUserIds).size) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "One or more share users are not members of this group",
          });
        }

        const expectedAmount = data.amount ?? existing.amount;
        const sharesSum = shares.reduce((sum, s) => sum + s.amount, 0);
        if (sharesSum !== expectedAmount) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Shares sum (${sharesSum}) does not equal expense amount (${expectedAmount})`,
          });
        }
      }

      // Recompute currency conversion if currency or amount changed
      const effectiveCurrency = inputCurrency ?? existing.currency;
      const effectiveAmount = data.amount ?? existing.amount;
      const groupCurrency = groupCheck?.currency ?? "USD";
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
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Could not fetch exchange rate. Please provide a manual rate or try again.",
            });
          }
          newExchangeRate = fetched;
        }
        newBaseCurrencyAmount = newExchangeRate
          ? convertCents(effectiveAmount, newExchangeRate)
          : null;
      } else {
        // Same currency as group -- clear conversion fields
        newExchangeRate = 1.0;
        newBaseCurrencyAmount = null;
      }

      const expense = await ctx.db.$transaction(async (tx) => {
        if (shares) {
          await tx.expenseShare.deleteMany({ where: { expenseId } });
          await tx.expenseShare.createMany({
            data: shares.map((s) => ({
              expenseId,
              userId: s.userId,
              amount: s.amount,
              shares: s.shares ?? 1,
              percentage: s.percentage,
            })),
          });
        }

        return tx.expense.update({
          where: { id: expenseId },
          data: {
            ...data,
            ...(inputCurrency ? { currency: inputCurrency } : {}),
            exchangeRate: newExchangeRate ?? 1.0,
            baseCurrencyAmount: newBaseCurrencyAmount,
            ...(data.expenseDate ? { expenseDate: new Date(data.expenseDate) } : {}),
          },
          include: { shares: true },
        });
      });

      await ctx.db.activityLog.create({
        data: {
          groupId,
          userId: ctx.user.id,
          type: "EXPENSE_UPDATED",
          entityId: expenseId,
        },
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
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot delete expenses from an archived group",
        });
      }

      const expense = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
      });
      if (!expense || expense.groupId !== input.groupId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const isOwnerOrAdmin =
        ctx.membership.role === "OWNER" || ctx.membership.role === "ADMIN";
      const isCreatorOrPayer =
        expense.paidById === ctx.user.id || expense.addedById === ctx.user.id;
      if (!isOwnerOrAdmin && !isCreatorOrPayer) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the expense creator, payer, or group owner/admin can delete this expense",
        });
      }

      await ctx.db.expense.delete({ where: { id: input.expenseId } });

      await ctx.db.activityLog.create({
        data: {
          groupId: input.groupId,
          userId: ctx.user.id,
          type: "EXPENSE_DELETED",
          metadata: { title: expense.title, amount: expense.amount },
        },
      });

      return { success: true };
    }),
});
