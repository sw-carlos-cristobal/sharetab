import type { Prisma } from '@/generated/prisma/client';

/**
 * Takes someone off a group's receipts saved for later when they stop being in it (#414): their
 * item assignments there go, and they stop being the payer. The receipt page shows only current
 * members, so it would count their items as assigned to someone it can't show or unselect, and
 * finishing or saving the receipt would be refused for naming someone not in the group. A
 * receipt made into an expense, deleted or not, isn't saved for later: it keeps who had which
 * item. `groups.removeMember` runs it under the group's member lock (`lockGroupMembers`), which
 * Save for later waits for, so a save can't put them back. `admin.deleteUser` takes no group lock
 * (#506), so a save committing alongside it can; the receipt page leaves out anyone not in the group.
 */
export async function dropFromPendingReceipts(
  tx: Prisma.TransactionClient,
  userId: string,
  groupId: string,
): Promise<void> {
  const pending = { groupId, expense: { is: null } };
  await tx.receiptItemAssignment.deleteMany({ where: { userId, receiptItem: { receipt: pending } } });
  await tx.receipt.updateMany({ where: { paidById: userId, ...pending }, data: { paidById: null } });
}
