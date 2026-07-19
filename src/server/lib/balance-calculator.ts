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
  /** Amount in group currency (cents). When set, used instead of amount for balance math. */
  baseCurrencyAmount?: number | null;
  shares: { userId: string; amount: number }[];
};

export type Settlement = {
  fromId: string;
  toId: string;
  amount: number;
  /** Amount in group currency (cents). When set, used instead of amount for balance math. */
  baseCurrencyAmount?: number | null;
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
    const creditor = creditors[ci];
    const debtor = debtors[di];
    // Unreachable given the loop condition above (ci/di are always in
    // bounds); guards the indexed access for noUncheckedIndexedAccess.
    if (!creditor || !debtor) break;

    const amount = Math.min(creditor.amount, debtor.amount);
    if (amount > 0) {
      result.push({
        from: debtor.userId,
        to: creditor.userId,
        amount,
      });
    }
    creditor.amount -= amount;
    debtor.amount -= amount;
    if (creditor.amount === 0) ci++;
    if (debtor.amount === 0) di++;
  }

  return result;
}

/**
 * Compute member balances from a set of expenses and settlements.
 * Returns per-member paid, owes, and net amounts.
 */
export function computeBalances(expenses: Expense[], settlements: Settlement[]): MemberBalance[] {
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
    const effectiveAmount = expense.baseCurrencyAmount ?? expense.amount;
    payer.paid += effectiveAmount;

    // If currency was converted, scale each share proportionally
    if (expense.baseCurrencyAmount != null && expense.baseCurrencyAmount !== expense.amount) {
      const ratio = expense.baseCurrencyAmount / expense.amount;
      let distributed = 0;
      const sortedShares = [...expense.shares].sort((a, b) => a.userId.localeCompare(b.userId));
      const scaledShares = sortedShares.map((share, i) => {
        if (i === sortedShares.length - 1) {
          // Last share gets the remainder to avoid rounding drift
          return { userId: share.userId, amount: effectiveAmount - distributed };
        }
        const scaled = Math.round(share.amount * ratio);
        distributed += scaled;
        return { userId: share.userId, amount: scaled };
      });
      for (const share of scaledShares) {
        const member = getOrCreate(share.userId);
        member.owes += share.amount;
      }
    } else {
      for (const share of expense.shares) {
        const member = getOrCreate(share.userId);
        member.owes += share.amount;
      }
    }
  }

  for (const settlement of settlements) {
    const from = getOrCreate(settlement.fromId);
    const to = getOrCreate(settlement.toId);
    const effectiveAmount = settlement.baseCurrencyAmount ?? settlement.amount;
    from.paid += effectiveAmount;
    to.owes += effectiveAmount;
  }

  for (const b of balanceMap.values()) {
    b.net = b.paid - b.owes;
  }

  return Array.from(balanceMap.values());
}
