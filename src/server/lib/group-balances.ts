import { TRPCError } from '@trpc/server';
import type { Prisma } from '@/generated/prisma/client';
import { computeBalances, type MemberBalance } from './balance-calculator';

/**
 * The net balance of everyone in a group's expenses and settlements,
 * including people who have since left. The group page's balances and the
 * archive check both read this, so they can't disagree.
 */
export async function loadGroupBalances(db: Prisma.TransactionClient, groupId: string): Promise<MemberBalance[]> {
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

/**
 * Lock a group's row for a transaction that changes its balances (an expense
 * or a payment added, edited or deleted), refusing an archived group with
 * `message`. Call it first in the transaction (#289).
 *
 * groups.archive sets archivedAt before it reads the balances, and that
 * update waits for every transaction holding this lock, so the balances it
 * reads include their changes. A transaction that asks for the lock while an
 * archive is in progress waits for it, then sees archivedAt and refuses. FOR
 * SHARE, not FOR UPDATE, so balance changes don't wait for each other.
 */
export async function lockActiveGroup(tx: Prisma.TransactionClient, groupId: string, message: string): Promise<void> {
  // Prisma has no row-lock API
  const [group] = await tx.$queryRaw<{ archivedAt: Date | null }[]>`
    SELECT "archivedAt" FROM "Group" WHERE "id" = ${groupId} FOR SHARE`;
  if (!group) {
    throw new TRPCError({ code: 'NOT_FOUND' });
  }
  if (group.archivedAt) {
    throw new TRPCError({ code: 'BAD_REQUEST', message });
  }
}
