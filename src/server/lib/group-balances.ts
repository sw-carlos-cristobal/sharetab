import { AppError, type ErrorKey } from './app-error';
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
 * the error `message` names. Call it first in the transaction (#289).
 *
 * groups.archive sets archivedAt before it reads the balances, and that
 * update waits for every transaction holding this lock, so the balances it
 * reads include their changes. A transaction that asks for the lock while an
 * archive is in progress waits for it, then sees archivedAt and refuses. FOR
 * SHARE, not FOR UPDATE, so balance changes don't wait for each other.
 *
 * Check that the people the write involves are members after this, in the
 * same transaction: a member leaving takes lockGroupMembers, so a leave in
 * progress has either finished (and they're gone) or waits for this write.
 */
export async function lockActiveGroup(tx: Prisma.TransactionClient, groupId: string, message: ErrorKey): Promise<void> {
  // Prisma has no row-lock API
  const [group] = await tx.$queryRaw<{ archivedAt: Date | null }[]>`
    SELECT "archivedAt" FROM "Group" WHERE "id" = ${groupId} FOR SHARE`;
  if (!group) {
    throw new AppError('NOT_FOUND');
  }
  if (group.archivedAt) {
    throw new AppError('BAD_REQUEST', message);
  }
}

/**
 * Lock a group's row for a transaction that removes someone from it, so it
 * waits for every balance change in flight (each holds lockActiveGroup's FOR
 * SHARE) and holds off new ones until it ends. A balance read after this is
 * final until then, and a write that starts meanwhile finds the person gone
 * when it checks membership. Call it first in the transaction (#279).
 */
export async function lockGroupMembers(tx: Prisma.TransactionClient, groupId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Group" WHERE "id" = ${groupId} FOR NO KEY UPDATE`;
}
