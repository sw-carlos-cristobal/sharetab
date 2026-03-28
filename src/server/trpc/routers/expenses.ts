import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, groupMemberProcedure } from "../init";
import { SplitMode } from "@/generated/prisma/client";

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
          paidBy: { select: { id: true, name: true, image: true } },
          shares: {
            include: { user: { select: { id: true, name: true, image: true } } },
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
          paidBy: { select: { id: true, name: true, image: true } },
          addedBy: { select: { id: true, name: true, image: true } },
          shares: {
            include: { user: { select: { id: true, name: true, image: true } } },
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
        currency: z.string().length(3).default("USD"),
        category: z.string().max(50).optional(),
        expenseDate: z.string().datetime().optional(),
        paidById: z.string(),
        splitMode: z.nativeEnum(SplitMode),
        shares: z.array(expenseShareSchema).min(1),
        receiptId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Validate shares sum equals total
      const sharesSum = input.shares.reduce((sum, s) => sum + s.amount, 0);
      if (sharesSum !== input.amount) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Shares sum (${sharesSum}) does not equal expense amount (${input.amount})`,
        });
      }

      const expense = await ctx.db.expense.create({
        data: {
          groupId: input.groupId,
          title: input.title,
          description: input.description,
          amount: input.amount,
          currency: input.currency,
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
        category: z.string().max(50).optional(),
        expenseDate: z.string().datetime().optional(),
        paidById: z.string().optional(),
        splitMode: z.nativeEnum(SplitMode).optional(),
        shares: z.array(expenseShareSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
      });
      if (!existing || existing.groupId !== input.groupId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const { groupId, expenseId, shares, ...data } = input;

      if (shares && data.amount) {
        const sharesSum = shares.reduce((sum, s) => sum + s.amount, 0);
        if (sharesSum !== data.amount) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Shares sum (${sharesSum}) does not equal expense amount (${data.amount})`,
          });
        }
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
      const expense = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
      });
      if (!expense || expense.groupId !== input.groupId) {
        throw new TRPCError({ code: "NOT_FOUND" });
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
