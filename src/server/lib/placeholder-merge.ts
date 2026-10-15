import { TRPCError } from '@trpc/server';
import type { Prisma, SplitMode } from '@/generated/prisma/client';

type ShareFields = { amount: number; shares: number; percentage: number | null };

/**
 * One person's share of an expense that the placeholder merged into them was
 * also in: the two amounts added up. Share units or percentages recomputed for
 * the merged person can land a cent away from what's stored (the edit form's
 * rounding depends on member order), so the expense becomes an exact split of
 * its stored amounts, and saving it unchanged moves nothing. A receipt split
 * keeps its mode; the edit form already opens it as exact amounts.
 */
export function combineShares(
  mode: SplitMode,
  target: ShareFields,
  placeholder: ShareFields,
): { mode: SplitMode; share: ShareFields } {
  return {
    mode: mode === 'ITEM' ? 'ITEM' : 'EXACT',
    share: { amount: target.amount + placeholder.amount, shares: 1, percentage: null },
  };
}

/**
 * Hand a placeholder's expenses, shares, payments and receipts in one group to
 * the member with an account they stand for, then delete the placeholder once
 * no group has them. Run inside the caller's transaction. Returns false, moving
 * nothing, when the placeholder is no longer in the group (merged or removed
 * by a transaction that got there first).
 */
export async function mergePlaceholderIntoUser(
  tx: Prisma.TransactionClient,
  placeholderUserId: string,
  realUserId: string,
  groupId: string,
): Promise<boolean> {
  if (placeholderUserId === realUserId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: "A placeholder can't be merged into itself" });
  }
  // Hard guard: this reassigns financial history and may delete the user row,
  // so it must never run against a real (non-placeholder) account.
  const [placeholder, target, group] = await Promise.all([
    tx.user.findUnique({ where: { id: placeholderUserId }, select: { isPlaceholder: true, suspendedAt: true } }),
    tx.user.findUnique({ where: { id: realUserId }, select: { isPlaceholder: true } }),
    tx.group.findUnique({ where: { id: groupId }, select: { archivedAt: true } }),
  ]);
  if (!placeholder?.isPlaceholder) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a placeholder user' });
  }
  // A deleted account is kept as a placeholder for its history, which can
  // span groups it left, so it stays as it is.
  if (placeholder.suspendedAt) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: "A deleted account can't be merged" });
  }
  if (!target || target.isPlaceholder) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A placeholder can only be merged into a member with an account',
    });
  }
  // History handed to someone outside the group couldn't be settled. Lock their
  // membership row (Prisma has no row-lock API): a removal waits for this
  // transaction, and one that got in first leaves no row to lock.
  const targetMembership = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "GroupMember" WHERE "userId" = ${realUserId} AND "groupId" = ${groupId} FOR SHARE`;
  if (targetMembership.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Target user is not a member of this group' });
  }
  // An archived group refuses changes to its expenses and payments, and a
  // merge rewrites both.
  if (group?.archivedAt) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This group is archived. Unarchive it to merge a placeholder.',
    });
  }

  // Removing the membership first locks it: a second merge of the same
  // placeholder waits here, then finds nothing to remove and stops.
  const removed = await tx.groupMember.deleteMany({ where: { userId: placeholderUserId, groupId } });
  if (removed.count === 0) {
    return false;
  }

  // A payment between the two would become a payment to themselves, which
  // changes no balance.
  await tx.settlement.deleteMany({
    where: {
      groupId,
      OR: [
        { fromId: placeholderUserId, toId: realUserId },
        { fromId: realUserId, toId: placeholderUserId },
      ],
    },
  });

  const shares = await tx.expenseShare.findMany({
    where: { userId: placeholderUserId, expense: { groupId } },
    include: { expense: { select: { splitMode: true } } },
  });
  for (const share of shares) {
    const existing = await tx.expenseShare.findUnique({
      where: { expenseId_userId: { expenseId: share.expenseId, userId: realUserId } },
    });
    if (!existing) {
      await tx.expenseShare.update({ where: { id: share.id }, data: { userId: realUserId } });
      continue;
    }
    const combined = combineShares(share.expense.splitMode, existing, share);
    await tx.expenseShare.delete({ where: { id: share.id } });
    await tx.expenseShare.update({ where: { id: existing.id }, data: combined.share });
    if (combined.mode !== share.expense.splitMode) {
      await tx.expense.update({ where: { id: share.expenseId }, data: { splitMode: combined.mode } });
    }
  }

  const groupReceiptItemIds = (
    await tx.receiptItem.findMany({
      where: {
        receipt: {
          OR: [{ expense: { groupId } }, { groupId }],
        },
      },
      select: { id: true },
    })
  ).map((ri) => ri.id);
  if (groupReceiptItemIds.length > 0) {
    const placeholderAssignments = await tx.receiptItemAssignment.findMany({
      where: { userId: placeholderUserId, receiptItemId: { in: groupReceiptItemIds } },
    });
    for (const assignment of placeholderAssignments) {
      const existing = await tx.receiptItemAssignment.findFirst({
        where: { receiptItemId: assignment.receiptItemId, userId: realUserId },
      });
      if (existing) {
        await tx.receiptItemAssignment.delete({ where: { id: assignment.id } });
      } else {
        await tx.receiptItemAssignment.update({
          where: { id: assignment.id },
          data: { userId: realUserId },
        });
      }
    }
  }

  // A receipt saved for later keeps its payer until it becomes an expense
  await tx.receipt.updateMany({
    where: { paidById: placeholderUserId, OR: [{ groupId }, { expense: { groupId } }] },
    data: { paidById: realUserId },
  });

  await tx.expense.updateMany({
    where: { paidById: placeholderUserId, groupId },
    data: { paidById: realUserId },
  });
  await tx.expense.updateMany({
    where: { addedById: placeholderUserId, groupId },
    data: { addedById: realUserId },
  });

  await tx.settlement.updateMany({
    where: { fromId: placeholderUserId, groupId },
    data: { fromId: realUserId },
  });
  await tx.settlement.updateMany({
    where: { toId: placeholderUserId, groupId },
    data: { toId: realUserId },
  });

  await tx.activityLog.updateMany({
    where: { userId: placeholderUserId, groupId },
    data: { userId: realUserId },
  });

  await tx.activityLog.create({
    data: {
      groupId,
      userId: realUserId,
      type: 'PLACEHOLDER_MERGED',
      metadata: { mergedPlaceholderId: placeholderUserId },
    },
  });

  const remainingMemberships = await tx.groupMember.count({
    where: { userId: placeholderUserId },
  });
  if (remainingMemberships === 0) {
    await tx.user.delete({ where: { id: placeholderUserId } });
  }
  return true;
}
