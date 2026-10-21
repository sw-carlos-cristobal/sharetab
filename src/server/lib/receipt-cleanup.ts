import { unlink } from 'fs/promises';
import { Prisma } from '@/generated/prisma/client';
import { logger } from './logger';
import { resolveUploadPath } from './upload-dir';

type ReceiptFile = { id: string; imagePath: string };

/**
 * A receipt is used by its group, by the expense made from it, and by every Quick
 * Split or claim session made from it (`GuestSplit.receiptId`, whose claim page shows
 * the image). When a group or a split is deleted, its receipts that nothing else uses
 * go with it, their items and assignments by cascade (#265).
 *
 * Deletes the given receipts that no split uses, in the caller's transaction, which
 * must already hold their rows `FOR UPDATE`. Returns their image paths, for
 * `removeReceiptFiles` once the transaction commits.
 */
export async function deleteReceiptsNoSplitUses(
  tx: Prisma.TransactionClient,
  receipts: ReceiptFile[],
): Promise<string[]> {
  if (receipts.length === 0) return [];
  const splits = await tx.guestSplit.findMany({
    where: { receiptId: { in: receipts.map((r) => r.id) } },
    select: { receiptId: true },
  });
  const used = new Set(splits.map((s) => s.receiptId));
  const unused = receipts.filter((r) => !used.has(r.id));
  if (unused.length > 0) {
    await tx.receipt.deleteMany({ where: { id: { in: unused.map((r) => r.id) } } });
  }
  return unused.map((r) => r.imagePath);
}

/**
 * After the caller deleted splits made from these receipts, in its transaction:
 * deletes the receipts nothing else uses (no group, no expense, no other split).
 * Returns their image paths, for `removeReceiptFiles` once the transaction commits.
 */
export async function deleteUnusedSplitReceipts(tx: Prisma.TransactionClient, receiptIds: string[]): Promise<string[]> {
  const ids = [...new Set(receiptIds)];
  if (ids.length === 0) return [];
  // Two splits made from one receipt, deleted at the same moment, would otherwise each
  // still see the other and both keep it; so would a split and the group the receipt
  // came from. The checks below run once the other deletion has committed.
  await tx.$queryRaw`SELECT 1 FROM "Receipt" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
  const receipts = await tx.receipt.findMany({
    where: { id: { in: ids }, groupId: null, expense: { is: null } },
    select: { id: true, imagePath: true },
  });
  return deleteReceiptsNoSplitUses(tx, receipts);
}

/**
 * For a split being made from a receipt, in the transaction that saves it: locks the
 * receipt's row the way a foreign key would (`GuestSplit.receiptId` has none) and returns
 * its id, or `undefined` when the receipt is gone. A deletion of the receipt's last split
 * or of its group then either waits for the new split and sees it, or finishes first and
 * the split is saved without the receipt, instead of pointing at one deleted a moment later.
 */
export async function lockReceiptForSplit(
  tx: Prisma.TransactionClient,
  receiptId: string | undefined,
): Promise<string | undefined> {
  if (receiptId === undefined) return undefined;
  const found = await tx.$queryRaw<unknown[]>`SELECT 1 FROM "Receipt" WHERE "id" = ${receiptId} FOR KEY SHARE`;
  return found.length > 0 ? receiptId : undefined;
}

type Db = { $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> };

/**
 * Deletes up to `batchSize` expired splits (they expire a week after they're made, or
 * when their creator ends them) with the receipts only they used. Returns how many
 * splits were deleted; a caller clearing a backlog goes again until that's none, since
 * a batch is short too when someone else deleted some of its splits first.
 */
export async function deleteExpiredSplits(db: Db, batchSize: number): Promise<number> {
  const { count, imagePaths } = await db.$transaction(async (tx) => {
    const expired = await tx.guestSplit.findMany({
      where: { expiresAt: { lt: new Date() } },
      select: { id: true, receiptId: true },
      take: batchSize,
    });
    if (expired.length === 0) return { count: 0, imagePaths: [] };
    const { count } = await tx.guestSplit.deleteMany({ where: { id: { in: expired.map((s) => s.id) } } });
    const receiptIds = expired.flatMap((s) => (s.receiptId ? [s.receiptId] : []));
    return { count, imagePaths: await deleteUnusedSplitReceipts(tx, receiptIds) };
  });
  await removeReceiptFiles(imagePaths);
  return count;
}

/**
 * Removes deleted receipts' image files. Their rows are gone by then, so a file that
 * can't be removed is only logged (the admin dashboard's orphan cleanup finds it).
 */
export async function removeReceiptFiles(imagePaths: string[]): Promise<void> {
  await Promise.all(
    imagePaths.map(async (imagePath) => {
      try {
        await unlink(resolveUploadPath(imagePath));
      } catch {
        logger.warn('receipt.fileCleanupFailed', { imagePath });
      }
    }),
  );
}
