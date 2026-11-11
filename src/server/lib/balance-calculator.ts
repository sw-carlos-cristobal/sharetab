/**
 * Pure functions for balance calculation and debt simplification.
 * Extracted from the balances tRPC router for testability.
 */

import { allocateProportionally } from '@/lib/money';

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
 * Uses a greedy algorithm: match largest creditor with largest debtor. Equal balances go in user
 * id order, so the list follows from the balances alone: `settlements.create` matches a payment
 * with hundredths against it (#335).
 */
export function simplifyDebts(balances: MemberBalance[]): SimplifiedDebt[] {
  const creditors: { userId: string; amount: number }[] = [];
  const debtors: { userId: string; amount: number }[] = [];

  for (const b of balances) {
    if (b.net > 0) creditors.push({ userId: b.userId, amount: b.net });
    if (b.net < 0) debtors.push({ userId: b.userId, amount: -b.net });
  }

  creditors.sort((a, b) => b.amount - a.amount || a.userId.localeCompare(b.userId));
  debtors.sort((a, b) => b.amount - a.amount || a.userId.localeCompare(b.userId));

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
 * Returns per-member paid, owes, and net amounts. `step` is the group currency's `currencyStep`:
 * a converted expense whose group-currency amount is whole is shared in whole units of a currency
 * with no decimals (#335).
 */
export function computeBalances(expenses: Expense[], settlements: Settlement[], step = 1): MemberBalance[] {
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

    // If currency was converted, scale each share proportionally: each within a cent (a whole
    // unit, at a step of 100) of its exact scaled value, a zero share staying zero (#331). Sorting
    // by user id keeps who gets a tied cent the same however the shares were loaded. Whole units
    // only for an amount that is whole: one converted before #335 whose amount has hundredths
    // keeps the shares it had; one whose amount is whole is shared again in whole units (#335). At a
    // step of 100 that includes a converted amount equal to the original (a rate of 1), whose shares
    // may not be whole units
    if (expense.baseCurrencyAmount != null && (step !== 1 || expense.baseCurrencyAmount !== expense.amount)) {
      const sortedShares = [...expense.shares].sort((a, b) => a.userId.localeCompare(b.userId));
      const scaled = allocateProportionally(
        effectiveAmount,
        sortedShares.map((share) => share.amount),
        effectiveAmount % step === 0 ? step : 1,
      );
      for (const [i, share] of sortedShares.entries()) {
        const member = getOrCreate(share.userId);
        member.owes += scaled[i]!;
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
