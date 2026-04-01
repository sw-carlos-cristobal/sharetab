/**
 * Pure functions for balance calculation and debt simplification.
 * Extracted from the balances tRPC router for testability.
 */

export type MemberBalance = {
  userId: string;
  paid: number;
  owes: number;
  net: number;
};

export type SimplifiedDebt = {
  from: string;
  to: string;
  amount: number;
};

export type Expense = {
  paidById: string;
  amount: number;
  shares: { userId: string; amount: number }[];
};

export type Settlement = {
  fromId: string;
  toId: string;
  amount: number;
};

/**
 * Simplify a set of member balances into the minimum number of debts.
 * Uses a greedy algorithm: match largest creditor with largest debtor.
 */
export function simplifyDebts(balances: MemberBalance[]): SimplifiedDebt[] {
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

/**
 * Compute member balances from a set of expenses and settlements.
 * Returns per-member paid, owes, and net amounts.
 */
export function computeBalances(
  expenses: Expense[],
  settlements: Settlement[]
): MemberBalance[] {
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

  return Array.from(balanceMap.values());
}
