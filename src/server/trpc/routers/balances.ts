import { createTRPCRouter, groupMemberProcedure, protectedProcedure } from '../init';
import { z } from 'zod';
import { simplifyDebts, computeBalances } from '../../lib/balance-calculator';
import { loadGroupBalances } from '../../lib/group-balances';

export const balancesRouter = createTRPCRouter({
  getGroupBalances: groupMemberProcedure.input(z.object({ groupId: z.string() })).query(async ({ ctx, input }) => {
    const balances = await loadGroupBalances(ctx.db, input.groupId);
    return { balances };
  }),

  getSimplifiedDebts: groupMemberProcedure.input(z.object({ groupId: z.string() })).query(async ({ ctx, input }) => {
    const debts = simplifyDebts(await loadGroupBalances(ctx.db, input.groupId));
    return { debts };
  }),

  getOverallDebts: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.group.findMany({
      // Archived groups count too: an open balance stays visible until it's settled
      where: { members: { some: { userId: ctx.user.id, removedAt: null } } },
      select: {
        expenses: {
          select: {
            paidById: true,
            amount: true,
            baseCurrencyAmount: true,
            shares: { select: { userId: true, amount: true } },
          },
        },
        settlements: {
          select: { fromId: true, toId: true, amount: true, baseCurrencyAmount: true },
        },
        members: {
          select: { user: { select: { id: true, name: true, venmoUsername: true } } },
        },
      },
    });

    // Aggregate net amounts across all groups per person pair
    // Positive = they owe you, Negative = you owe them
    const aggregated = new Map<string, { userName: string; venmoUsername: string | null; amount: number }>();

    for (const group of groups) {
      const balances = computeBalances(group.expenses, group.settlements);
      const debts = simplifyDebts(balances);

      // Build a userId -> user info lookup for this group
      const userMap = new Map<string, { name: string; venmoUsername: string | null }>();
      for (const member of group.members) {
        userMap.set(member.user.id, {
          name: member.user.name ?? 'Unknown',
          venmoUsername: member.user.venmoUsername,
        });
      }

      // Aggregate debts relative to the current user
      for (const debt of debts) {
        if (debt.to === ctx.user.id) {
          // Someone owes the current user
          const existing = aggregated.get(debt.from);
          const userInfo = userMap.get(debt.from);
          if (existing) {
            existing.amount += debt.amount;
            // Update venmoUsername if we find one (may differ across groups)
            if (userInfo?.venmoUsername) existing.venmoUsername = userInfo.venmoUsername;
          } else {
            aggregated.set(debt.from, {
              userName: userInfo?.name ?? 'Unknown',
              venmoUsername: userInfo?.venmoUsername ?? null,
              amount: debt.amount,
            });
          }
        } else if (debt.from === ctx.user.id) {
          // Current user owes someone
          const existing = aggregated.get(debt.to);
          const userInfo = userMap.get(debt.to);
          if (existing) {
            existing.amount -= debt.amount;
            if (userInfo?.venmoUsername) existing.venmoUsername = userInfo.venmoUsername;
          } else {
            aggregated.set(debt.to, {
              userName: userInfo?.name ?? 'Unknown',
              venmoUsername: userInfo?.venmoUsername ?? null,
              amount: -debt.amount,
            });
          }
        }
      }
    }

    const owedToYou: { userId: string; userName: string; venmoUsername: string | null; amount: number }[] = [];
    const youOwe: { userId: string; userName: string; venmoUsername: string | null; amount: number }[] = [];

    for (const [userId, { userName, venmoUsername, amount }] of aggregated) {
      if (amount > 0) {
        owedToYou.push({ userId, userName, venmoUsername, amount });
      } else if (amount < 0) {
        youOwe.push({ userId, userName, venmoUsername, amount: -amount });
      }
    }

    owedToYou.sort((a, b) => b.amount - a.amount);
    youOwe.sort((a, b) => b.amount - a.amount);

    return { owedToYou, youOwe };
  }),

  getDashboard: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.group.findMany({
      // Archived groups count too: an open balance stays visible until it's settled
      where: { members: { some: { userId: ctx.user.id, removedAt: null } } },
      select: {
        id: true,
        name: true,
        emoji: true,
        currency: true,
        archivedAt: true,
        expenses: {
          select: {
            paidById: true,
            amount: true,
            baseCurrencyAmount: true,
            shares: { select: { userId: true, amount: true } },
          },
        },
        settlements: {
          select: { fromId: true, toId: true, amount: true, baseCurrencyAmount: true },
        },
      },
    });

    let totalOwed = 0; // others owe you
    let totalOwing = 0; // you owe others

    const perGroup: {
      groupId: string;
      groupName: string;
      emoji: string | null;
      currency: string;
      balance: number;
      archived: boolean;
    }[] = [];

    for (const group of groups) {
      const balances = computeBalances(group.expenses, group.settlements);
      const userBalance = balances.find((b) => b.userId === ctx.user.id);
      const net = userBalance?.net ?? 0;
      if (net > 0) totalOwed += net;
      if (net < 0) totalOwing += -net;

      perGroup.push({
        groupId: group.id,
        groupName: group.name,
        emoji: group.emoji,
        currency: group.currency,
        balance: net,
        archived: group.archivedAt !== null,
      });
    }

    return { totalOwed, totalOwing, perGroup };
  }),
});
