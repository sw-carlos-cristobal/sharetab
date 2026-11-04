import type { Prisma } from '@/generated/prisma/client';
import { deleteReceiptsNoSplitUses } from './receipt-cleanup';

/**
 * Deletes a group in the caller's transaction, with what only it used (#265): its
 * placeholder members, who can't sign in or be in another group, and its scanned
 * receipts that no Quick Split or claim session still shows (the last split to go
 * deletes those, see `deleteUnusedSplitReceipts`). Expenses, settlements, memberships,
 * invites and activity go with the group row by cascade.
 *
 * Returns the deleted receipts' image paths, for `removeReceiptFiles` once the
 * transaction commits.
 */
export async function deleteGroupWithData(tx: Prisma.TransactionClient, groupId: string): Promise<string[]> {
  // A new member or receipt row refers to the group, and the key-share lock its insert
  // takes on the group's row waits for this one: nothing joins the group or is scanned
  // into it once the placeholders and receipts below are read, and once this commits
  // that insert fails.
  await tx.$queryRaw`SELECT 1 FROM "Group" WHERE "id" = ${groupId} FOR UPDATE`;
  // A split deleted at the same moment waits for the receipt it shares (and the
  // other way round), so one of the two sees the other gone and deletes the receipt
  await tx.$queryRaw`SELECT 1 FROM "Receipt" WHERE "groupId" = ${groupId} ORDER BY "id" FOR UPDATE`;
  const [receipts, placeholders] = await Promise.all([
    tx.receipt.findMany({ where: { groupId }, select: { id: true, imagePath: true } }),
    tx.groupMember.findMany({ where: { groupId, user: { isPlaceholder: true } }, select: { userId: true } }),
  ]);

  const imagePaths = await deleteReceiptsNoSplitUses(tx, receipts);
  await tx.group.delete({ where: { id: groupId } });

  if (placeholders.length > 0) {
    // Only ones nothing else refers to, so one that somehow is can't make the delete fail
    await tx.user.deleteMany({
      where: {
        id: { in: placeholders.map((p) => p.userId) },
        isPlaceholder: true,
        groupMembers: { none: {} },
        expensesPaid: { none: {} },
        expensesAdded: { none: {} },
        expenseShares: { none: {} },
        settlementsPaid: { none: {} },
        settlementsFor: { none: {} },
      },
    });
  }
  return imagePaths;
}
