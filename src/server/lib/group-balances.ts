import type { PrismaClient } from '@/generated/prisma/client';
import { computeBalances, type MemberBalance } from './balance-calculator';

/**
 * The net balance of everyone in a group's expenses and settlements,
 * including people who have since left. The group page's balances and the
 * archive check both read this, so they can't disagree.
 */
export async function loadGroupBalances(db: PrismaClient, groupId: string): Promise<MemberBalance[]> {
  const [expenses, settlements] = await Promise.all([
    db.expense.findMany({
      where: { groupId },
      select: {
        paidById: true,
        amount: true,
        baseCurrencyAmount: true,
        shares: { select: { userId: true, amount: true } },
      },
    }),
    db.settlement.findMany({
      where: { groupId },
      select: { fromId: true, toId: true, amount: true, baseCurrencyAmount: true },
    }),
  ]);
  return computeBalances(expenses, settlements);
}
