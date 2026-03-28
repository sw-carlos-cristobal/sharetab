import { createTRPCRouter, groupMemberProcedure, protectedProcedure } from "../init";
import { z } from "zod";

type MemberBalance = {
  userId: string;
  paid: number;
  owes: number;
  net: number;
};

type SimplifiedDebt = {
  from: string;
  to: string;
  amount: number;
};

function simplifyDebts(balances: MemberBalance[]): SimplifiedDebt[] {
  const creditors: { userId: string; amount: number }[] = [];
  const debtors: { userId: string; amount: number }[] = [];

  for (const b of balances) {
    if (b.net > 0) creditors.push({ userId: b.userId, amount: b.net });
    if (b.net < 0) debtors.push({ userId: b.userId, amount: -b.net });
  }

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const result: SimplifiedDebt[] = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const amount = Math.min(creditors[ci].amount, debtors[di].amount);
    if (amount > 0) {
      result.push({
        from: debtors[di].userId,
        to: creditors[ci].userId,
        amount,
      });
    }
    creditors[ci].amount -= amount;
    debtors[di].amount -= amount;
    if (creditors[ci].amount === 0) ci++;
    if (debtors[di].amount === 0) di++;
  }

  return result;
}

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

      const balanceMap = new Map<string, MemberBalance>();

      const getOrCreate = (userId: string): MemberBalance => {
        let b = balanceMap.get(userId);
        if (!b) {
          b = { userId, paid: 0, owes: 0, net: 0 };
          balanceMap.set(userId, b);
        }
        return b;
      };

      for (const expense of expenses) {
        const payer = getOrCreate(expense.paidById);
        payer.paid += expense.amount;

        for (const share of expense.shares) {
          const member = getOrCreate(share.userId);
          member.owes += share.amount;
        }
      }

      for (const settlement of settlements) {
        const from = getOrCreate(settlement.fromId);
        const to = getOrCreate(settlement.toId);
        from.paid += settlement.amount;
        to.owes += settlement.amount;
      }

      for (const b of balanceMap.values()) {
        b.net = b.paid - b.owes;
      }

      const balances = Array.from(balanceMap.values());
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

      const balanceMap = new Map<string, MemberBalance>();

      const getOrCreate = (userId: string): MemberBalance => {
        let b = balanceMap.get(userId);
        if (!b) {
          b = { userId, paid: 0, owes: 0, net: 0 };
          balanceMap.set(userId, b);
        }
        return b;
      };

      for (const expense of expenses) {
        const payer = getOrCreate(expense.paidById);
        payer.paid += expense.amount;
        for (const share of expense.shares) {
          const member = getOrCreate(share.userId);
          member.owes += share.amount;
        }
      }

      for (const settlement of settlements) {
        const from = getOrCreate(settlement.fromId);
        const to = getOrCreate(settlement.toId);
        from.paid += settlement.amount;
        to.owes += settlement.amount;
      }

      for (const b of balanceMap.values()) {
        b.net = b.paid - b.owes;
      }

      const balances = Array.from(balanceMap.values());
      const debts = simplifyDebts(balances);
      return { debts };
    }),

  getDashboard: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.group.findMany({
      where: { members: { some: { userId: ctx.user.id } } },
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
