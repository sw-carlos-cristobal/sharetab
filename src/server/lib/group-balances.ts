import { AppError, type ErrorKey } from './app-error';
import type { Prisma } from '@/generated/prisma/client';
import { computeBalances, type MemberBalance } from './balance-calculator';

/**
 * The net balance of everyone in a group's expenses and settlements,
 * including people who have since left. The group page's balances and the
 * archive and delete checks (requireSettledUp) all read this, so they can't
 * disagree.
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
 * Refuse a group where anyone still owes or is owed money, with
 * PRECONDITION_FAILED and the error key that fits: archiving (#275) and
 * deleting (#390) both need everyone settled up first. An archived group
 * refuses the payments that would settle a balance, and a deleted one takes
 * the record of it away for good.
 *
 * Call it once the transaction holds a lock that waits for the writes taking
 * lockActiveGroup (expenses created, edited or deleted, payments recorded or
 * deleted, receipts.assignItemsAndCreateExpense) and holds off new ones
 * (groups.archive's update, lockGroupMembers), so what they change is final.
 * A placeholder merge (mergePlaceholderIntoUser) takes no group lock. It
 * moves a balance from one person to another and re-rounds the shares of
 * converted-currency expenses (a tied cent can land on someone else, since
 * computeBalances orders shares by user id), so one landing mid-read can make
 * this refuse a settled group or pass one that is a few cents out.
 * Throwing rolls back whatever the transaction did before.
 */
export async function requireSettledUp(
  tx: Prisma.TransactionClient,
  groupId: string,
  keys: { unsettled: ErrorKey; formerMember: ErrorKey },
): Promise<void> {
  const unsettled = (await loadGroupBalances(tx, groupId)).filter((b) => b.net !== 0);
  if (unsettled.length === 0) {
    return;
  }
  // Settlements need both people to have a membership row. Someone removed from
  // the group keeps theirs, marked removed, and can still be settled with
  // (#284, #323), so they count here. Only people who left, or whose account an admin
  // deleted, before #323 have no row: a balance with one waits until they rejoin, and
  // a deleted account can't, so the expenses and payments it's in have to change instead.
  const members = await tx.groupMember.findMany({ where: { groupId }, select: { userId: true } });
  const memberIds = new Set(members.map((m) => m.userId));
  throw new AppError(
    'PRECONDITION_FAILED',
    unsettled.some((b) => !memberIds.has(b.userId)) ? keys.formerMember : keys.unsettled,
  );
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
