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

// #312: receipts nothing uses (no group, no expense, no split made from them) stayed for good:
// ones left behind before #265, and Quick Split scans never made into a split
describe('unused receipts', () => {
  let dir: string;
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'receipt-cleanup-'));
    await mkdir(path.join(dir, 'receipts'));
    vi.stubEnv('UPLOAD_DIR', dir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  type Query = { text: string; values: unknown[] };
  const isQuery = (arg: unknown): arg is Query => typeof (arg as Query)?.text === 'string';

  // A scan in progress has no split yet, so only receipts nothing changed for a day count
  function expectUnusedReceiptQuery(query: Query) {
    expect(query.text).toMatch(/"groupId" IS NULL/);
    expect(query.text).toMatch(/NOT EXISTS \(SELECT 1 FROM "Expense" e WHERE e\."receiptId" = r\."id"\)/);
    expect(query.text).toMatch(/NOT EXISTS \(SELECT 1 FROM "GuestSplit" s WHERE s\."receiptId" = r\."id"\)/);
    expect(query.text).toMatch(/r\."updatedAt" < \$1/);
    const cutoff = query.values[0] as Date;
    expect(Math.abs(cutoff.getTime() - (Date.now() - DAY))).toBeLessThan(5000);
  }

  test('counts the ones more than a day old, with their size', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ count: 3, bytes: 4096 }]) };
    const { countUnusedReceipts } = await import('./receipt-cleanup');

    expect(await countUnusedReceipts(db as never)).toEqual({ count: 3, bytes: 4096 });
    expectUnusedReceiptQuery(db.$queryRaw.mock.calls[0]![0]);
  });

  function fakeDb(batches: { id: string }[][]) {
    const tx = {
      // The batch's candidates, then the row lock deleteUnusedSplitReceipts takes
      $queryRaw: vi.fn(async (arg: unknown) => (isQuery(arg) ? (batches.shift() ?? []) : [])),
      guestSplit: { findMany: vi.fn().mockResolvedValue([]) },
      receipt: { findMany: vi.fn(), deleteMany: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    return { tx, db };
  }

  test('deletes them batch by batch, checking each again under its row lock, then the files', async () => {
    await writeFile(path.join(dir, 'receipts', 'r1.jpg'), 'r1');
    await writeFile(path.join(dir, 'receipts', 'r2.jpg'), 'r2');
    const { tx, db } = fakeDb([[{ id: 'r1' }, { id: 'r2' }]]);
    // r2 was saved to a group after it was picked
    tx.receipt.findMany.mockResolvedValue([{ id: 'r1', imagePath: 'receipts/r1.jpg' }]);
    const { deleteUnusedReceipts } = await import('./receipt-cleanup');

    expect(await deleteUnusedReceipts(db as never, 500)).toBe(1);

    const pick = tx.$queryRaw.mock.calls[0]![0] as Query;
    expectUnusedReceiptQuery(pick);
    expect(pick.text).toMatch(/LIMIT \$2/);
    expect(pick.values[1]).toBe(500);
    // One scanned again since it was picked has changed, so it stays too
    expect(tx.receipt.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2'] }, groupId: null, expense: { is: null }, updatedAt: { lt: pick.values[0] } },
      select: { id: true, imagePath: true },
    });
    expect(tx.receipt.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } } });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(await readdir(path.join(dir, 'receipts'))).toEqual(['r2.jpg']);
  });

  // A picked receipt that's in use by the time it's locked isn't picked again
  test('goes on past a batch where every receipt turned out to be in use', async () => {
    const { tx, db } = fakeDb([[{ id: 'r1' }], [{ id: 'r3' }]]);
    tx.receipt.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'r3', imagePath: 'receipts/r3.jpg' }]);
    const { deleteUnusedReceipts } = await import('./receipt-cleanup');

    expect(await deleteUnusedReceipts(db as never, 500)).toBe(1);
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    expect(tx.receipt.deleteMany).toHaveBeenCalledTimes(1);
  });

  test('with none to delete, deletes nothing', async () => {
    const { tx, db } = fakeDb([]);
    const { deleteUnusedReceipts } = await import('./receipt-cleanup');

    expect(await deleteUnusedReceipts(db as never, 500)).toBe(0);
    expect(tx.receipt.findMany).not.toHaveBeenCalled();
    expect(tx.receipt.deleteMany).not.toHaveBeenCalled();
  });
});
