import { createTRPCRouter, groupMemberProcedure, protectedProcedure } from "../init";
import { z } from "zod";
import { simplifyDebts, computeBalances } from "../../lib/balance-calculator";

export const balancesRouter = createTRPCRouter({
  getGroupBalances: groupMemberProcedure
    .input(z.object({ groupId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [expenses, settlements] = await Promise.all([
        ctx.db.expense.findMany({
          where: { groupId: input.groupId },
          include: { shares: true },
        }),
        ctx.db.settlement.findMany({
          where: { groupId: input.groupId },
        }),
      ]);

      const balances = computeBalances(expenses, settlements);
      return { balances };
    }),

  getSimplifiedDebts: groupMemberProcedure
    .input(z.object({ groupId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [expenses, settlements] = await Promise.all([
        ctx.db.expense.findMany({
          where: { groupId: input.groupId },
          include: { shares: true },
        }),
        ctx.db.settlement.findMany({
          where: { groupId: input.groupId },
        }),
      ]);

      const balances = computeBalances(expenses, settlements);
      const debts = simplifyDebts(balances);
      return { debts };
    }),

  getOverallDebts: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.group.findMany({
      where: { members: { some: { userId: ctx.user.id } }, archivedAt: null },
      include: {
        expenses: { include: { shares: true } },
        settlements: true,
        members: {
          include: { user: { select: { id: true, name: true } } },
        },
      },
    });

    // Aggregate net amounts across all groups per person pair
    // Positive = they owe you, Negative = you owe them
    const aggregated = new Map<string, { userName: string; amount: number }>();

    for (const group of groups) {
      const balances = computeBalances(group.expenses, group.settlements);
      const debts = simplifyDebts(balances);

      // Build a userId -> userName lookup for this group
      const nameMap = new Map<string, string>();
      for (const member of group.members) {
        nameMap.set(member.user.id, member.user.name ?? "Unknown");
      }

      // Aggregate debts relative to the current user
      for (const debt of debts) {
        if (debt.to === ctx.user.id) {
          // Someone owes the current user
          const existing = aggregated.get(debt.from);
          if (existing) {
            existing.amount += debt.amount;
          } else {
            aggregated.set(debt.from, {
              userName: nameMap.get(debt.from) ?? "Unknown",
              amount: debt.amount,
            });
          }
        } else if (debt.from === ctx.user.id) {
          // Current user owes someone
          const existing = aggregated.get(debt.to);
          if (existing) {
            existing.amount -= debt.amount;
          } else {
            aggregated.set(debt.to, {
              userName: nameMap.get(debt.to) ?? "Unknown",
              amount: -debt.amount,
            });
          }
        }
      }
    }

    const owedToYou: { userId: string; userName: string; amount: number }[] = [];
    const youOwe: { userId: string; userName: string; amount: number }[] = [];

    for (const [userId, { userName, amount }] of aggregated) {
      if (amount > 0) {
        owedToYou.push({ userId, userName, amount });
      } else if (amount < 0) {
        youOwe.push({ userId, userName, amount: -amount });
      }
    }

    owedToYou.sort((a, b) => b.amount - a.amount);
    youOwe.sort((a, b) => b.amount - a.amount);

    return { owedToYou, youOwe };
  }),

  getDashboard: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.group.findMany({
      where: { members: { some: { userId: ctx.user.id } }, archivedAt: null },
      include: {
        expenses: { include: { shares: true } },
        settlements: true,
        members: {
          include: { user: { select: { id: true, name: true, image: true } } },
        },
      },
    });

    let totalOwed = 0; // others owe you
    let totalOwing = 0; // you owe others

    const perGroup: {
      groupId: string;
      groupName: string;
      balance: number;
    }[] = [];

    for (const group of groups) {
      let paid = 0;
      let owes = 0;

      for (const expense of group.expenses) {
        if (expense.paidById === ctx.user.id) {
          paid += expense.amount;
        }
        for (const share of expense.shares) {
          if (share.userId === ctx.user.id) {
            owes += share.amount;
          }
        }
      }

      for (const settlement of group.settlements) {
        if (settlement.fromId === ctx.user.id) paid += settlement.amount;
        if (settlement.toId === ctx.user.id) owes += settlement.amount;
      }

      const net = paid - owes;
      if (net > 0) totalOwed += net;
      if (net < 0) totalOwing += -net;

      perGroup.push({
        groupId: group.id,
        groupName: group.name,
        balance: net,
      });
    }

    return { totalOwed, totalOwing, perGroup };
  }),
});
