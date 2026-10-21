import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));

// #265: a deleted group's or split's receipts take their image files with them
describe('removeReceiptFiles', () => {
  let dir: string;

  beforeEach(async () => {
    warn.mockClear();
    dir = await mkdtemp(path.join(tmpdir(), 'receipt-cleanup-'));
    await mkdir(path.join(dir, 'receipts'));
    vi.stubEnv('UPLOAD_DIR', dir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  test('removes each file', async () => {
    await writeFile(path.join(dir, 'receipts', 'a.jpg'), 'a');
    await writeFile(path.join(dir, 'receipts', 'b.jpg'), 'b');
    await writeFile(path.join(dir, 'receipts', 'keep.jpg'), 'k');
    const { removeReceiptFiles } = await import('./receipt-cleanup');

    await removeReceiptFiles(['receipts/a.jpg', 'receipts/b.jpg']);

    expect(await readdir(path.join(dir, 'receipts'))).toEqual(['keep.jpg']);
    expect(warn).not.toHaveBeenCalled();
  });

  // The rows are already gone by then, so a file that can't be removed is only logged
  test('logs a file it cannot remove and still removes the rest', async () => {
    await writeFile(path.join(dir, 'receipts', 'b.jpg'), 'b');
    const { removeReceiptFiles } = await import('./receipt-cleanup');

    await expect(removeReceiptFiles(['receipts/missing.jpg', '../outside.jpg', 'receipts/b.jpg'])).resolves.toBe(
      undefined,
    );

    expect(await readdir(path.join(dir, 'receipts'))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('receipt.fileCleanupFailed', { imagePath: 'receipts/missing.jpg' });
    expect(warn).toHaveBeenCalledWith('receipt.fileCleanupFailed', { imagePath: '../outside.jpg' });
  });
});

// #265: splits expire after a week and are deleted in batches; their receipts went nowhere
describe('deleteExpiredSplits', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'receipt-cleanup-'));
    await mkdir(path.join(dir, 'receipts'));
    vi.stubEnv('UPLOAD_DIR', dir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  function fakeDb() {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      guestSplit: { findMany: vi.fn(), deleteMany: vi.fn() },
      receipt: { findMany: vi.fn(), deleteMany: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    return { tx, db };
  }

  test('deletes a batch of expired splits with the receipts only they used, then the files', async () => {
    await writeFile(path.join(dir, 'receipts', 'r1.jpg'), 'r1');
    const { tx, db } = fakeDb();
    tx.guestSplit.findMany
      .mockResolvedValueOnce([
        { id: 's1', receiptId: 'r1' },
        { id: 's2', receiptId: null },
      ])
      .mockResolvedValueOnce([]);
    tx.guestSplit.deleteMany.mockResolvedValue({ count: 2 });
    tx.receipt.findMany.mockResolvedValue([{ id: 'r1', imagePath: 'receipts/r1.jpg' }]);
    const { deleteExpiredSplits } = await import('./receipt-cleanup');

    expect(await deleteExpiredSplits(db as never, 100)).toBe(2);

    expect(tx.guestSplit.findMany).toHaveBeenNthCalledWith(1, {
      where: { expiresAt: { lt: expect.any(Date) } },
      select: { id: true, receiptId: true },
      take: 100,
    });
    expect(tx.guestSplit.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s1', 's2'] } } });
    expect(tx.receipt.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1'] }, groupId: null, expense: { is: null } },
      select: { id: true, imagePath: true },
    });
    expect(tx.receipt.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } } });
    expect(await readdir(path.join(dir, 'receipts'))).toEqual([]);
  });

  test('with nothing expired, deletes nothing', async () => {
    const { tx, db } = fakeDb();
    tx.guestSplit.findMany.mockResolvedValue([]);
    const { deleteExpiredSplits } = await import('./receipt-cleanup');

    expect(await deleteExpiredSplits(db as never, 100)).toBe(0);
    expect(tx.guestSplit.deleteMany).not.toHaveBeenCalled();
    expect(tx.receipt.deleteMany).not.toHaveBeenCalled();
  });
});
