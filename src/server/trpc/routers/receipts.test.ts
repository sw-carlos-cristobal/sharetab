import { describe, test, expect, vi, beforeEach } from 'vitest';
import { calculateReceiptSplitTotals } from '@/lib/split-calculator';
import { getExchangeRate } from '@/server/lib/exchange-rates';
import { Prisma } from '@/generated/prisma/client';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));
vi.mock('@/server/lib/receipt-processor', () => ({ processReceiptImage: vi.fn() }));
vi.mock('@/server/lib/exchange-rates', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getExchangeRate: vi.fn(),
}));
const unlink = vi.fn();
vi.mock('fs/promises', async (importOriginal) => ({ ...(await importOriginal<object>()), unlink }));

const mockDb = {
  user: { findUnique: vi.fn() },
  group: { findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn(), findMany: vi.fn() },
  receipt: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  receiptItem: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  receiptItemAssignment: { deleteMany: vi.fn(), createMany: vi.fn() },
  expense: { create: vi.fn(), findUnique: vi.fn() },
  guestSplit: { findMany: vi.fn() },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function caller() {
  const { receiptsRouter } = await import('./receipts');
  const ctx = { session: { user: { id: 'u1' } }, db: mockDb, headers: new Headers(), impersonating: null };
  return receiptsRouter.createCaller(ctx as unknown as Parameters<typeof receiptsRouter.createCaller>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
});

describe('AI provider setup (#280)', () => {
  test('no receipts procedure exposes the AI provider setup', async () => {
    const { receiptsRouter } = await import('./receipts');
    const names = Object.keys(receiptsRouter._def.procedures).filter((name) => /provider/i.test(name));
    expect(names, 'the AI provider setup is admin-only, in admin.getSystemHealth').toEqual([]);
  });
});

describe('receipt item names are trimmed', () => {
  test('addItem refuses a name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.addItem({ receiptId: 'r1', name: '   ', unitPrice: 100, totalPrice: 100 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.receiptItem.create).not.toHaveBeenCalled();
  });

  test('updateItem refuses a name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.updateItem({ itemId: 'i1', name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.receiptItem.findUnique).not.toHaveBeenCalled();
  });
});

// #289: the archived check ran in its own statement before the write, so an
// archive that landed in between let the expense through, and the group could
// end up archived with a balance nobody can settle.
describe('a group archived while a receipt was being finished (#289)', () => {
  const rawSql = () => mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));
  const finish = {
    groupId: 'g1',
    receiptId: 'r1',
    title: 'Lunch',
    paidById: 'u1',
    assignments: [{ receiptItemId: 'i1', userIds: ['u1'] }],
  };
  // What the transaction's row locks read: the group, and the receipt (still in the group, scanned)
  const locksRead = (group: object, receipt: object | null = { groupId: 'g1', status: 'COMPLETED' }) =>
    mockDb.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Receipt"') ? (receipt ? [receipt] : []) : [group],
    );

  beforeEach(() => {
    mockDb.groupMember.findUnique.mockResolvedValue({ role: 'MEMBER', userId: 'u1', groupId: 'g1' });
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'u1' }]);
    mockDb.receipt.findUnique.mockResolvedValue({
      id: 'r1',
      status: 'COMPLETED',
      groupId: 'g1',
      uploadedById: 'u1',
      extractedData: { subtotal: 1000, tax: 0, tip: 0, total: 1000, currency: 'USD' },
    });
    mockDb.receiptItem.findMany.mockResolvedValue([{ id: 'i1', totalPrice: 1000 }]);
    // The early check still sees the group active, but by the time the
    // transaction locks its row, it's archived
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'USD' });
    locksRead({ archivedAt: new Date() });
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  });

  test('assignItemsAndCreateExpense refuses, writing nothing', async () => {
    const api = await caller();
    await expect(api.assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot create expenses in archived groups',
    });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.deleteMany).not.toHaveBeenCalled();
  });

  test('an active group is locked FOR SHARE inside the transaction, before the write', async () => {
    locksRead({ archivedAt: null });
    mockDb.expense.create.mockResolvedValue({ id: 'e1' });
    const api = await caller();
    await api.assignItemsAndCreateExpense(finish);

    expect(rawSql()).toEqual([
      expect.stringMatching(/FROM "Group" WHERE "id" = \? FOR SHARE/),
      expect.stringMatching(/FROM "Receipt" WHERE "id" = \? FOR SHARE/),
    ]);
    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(locked).toBeGreaterThan(mockDb.$transaction.mock.invocationCallOrder[0]!);
    expect(locked).toBeLessThan(mockDb.expense.create.mock.invocationCallOrder[0]!);
  });

  // Codex on #308: see the expenses test of the same name
  test('assignItemsAndCreateExpense checks its people are members inside the transaction, after the lock', async () => {
    locksRead({ archivedAt: null });
    mockDb.expense.create.mockResolvedValue({ id: 'e1' });
    const api = await caller();
    await api.assignItemsAndCreateExpense(finish);

    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(mockDb.groupMember.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(locked!);
    expect(mockDb.groupMember.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.expense.create.mock.invocationCallOrder[0]!,
    );
    // Not a placeholder removed from the group (#284)
    expect(mockDb.groupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: 'g1', removedAt: null } }),
    );
  });

  // Codex on #319: deleting a receipt from the pending list keeps it off the group while a
  // claim session uses it (#318), so an expense that passed the checks above just before
  // must see that under the receipt's lock, not link a receipt the group can no longer open
  test('a receipt taken off the group meanwhile is refused, writing nothing', async () => {
    locksRead({ archivedAt: null }, { groupId: null });
    const api = await caller();
    await expect(api.assignItemsAndCreateExpense(finish)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Receipt was removed from this group',
    });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.deleteMany).not.toHaveBeenCalled();
  });

  test('a receipt deleted meanwhile is refused, writing nothing', async () => {
    locksRead({ archivedAt: null }, null);
    const api = await caller();
    await expect(api.assignItemsAndCreateExpense(finish)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
  });
});

// #318: the group scan page's Share Link makes a claim session from a group receipt, and
// deleting the receipt from the group's pending list deleted it under the claim page, which
// shows its photo. It now leaves the group, and goes only once no split uses it.
describe('deleting a pending receipt (#318)', () => {
  const rawSql = () => mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));

  beforeEach(() => {
    mockDb.$transaction.mockImplementation((fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
    mockDb.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockDb.receipt.findUnique.mockResolvedValue({
      id: 'r1',
      groupId: 'g1',
      uploadedById: 'u1',
      savedById: null,
      imagePath: 'receipts/r1.jpg',
    });
    mockDb.expense.findUnique.mockResolvedValue(null);
    // Off the group, with no expense: what the cleanup finds under the lock
    mockDb.receipt.findMany.mockResolvedValue([{ id: 'r1', imagePath: 'receipts/r1.jpg' }]);
    mockDb.guestSplit.findMany.mockResolvedValue([]);
  });

  test('one a claim session uses leaves the group, and stays for the claim page', async () => {
    mockDb.guestSplit.findMany.mockResolvedValue([{ receiptId: 'r1' }]);
    const api = await caller();
    await api.deletePending({ receiptId: 'r1' });

    expect(mockDb.receipt.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { groupId: null } });
    expect(mockDb.receipt.delete).not.toHaveBeenCalled();
    expect(mockDb.receipt.deleteMany).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  test('one nothing else uses is deleted, its file once the transaction has committed', async () => {
    let committed = false;
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => {
      const result = await fn(mockDb);
      committed = true;
      return result;
    });
    unlink.mockImplementation(async () => expect(committed).toBe(true));
    const api = await caller();
    await api.deletePending({ receiptId: 'r1' });

    expect(mockDb.receipt.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } } });
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink.mock.calls[0]![0]).toMatch(/receipts\/r1\.jpg$/);
  });

  test('locks the receipt before checking for an expense, so one made meanwhile is seen', async () => {
    const api = await caller();
    await api.deletePending({ receiptId: 'r1' });

    expect(rawSql()[0]).toMatch(/FROM "Receipt" WHERE "id" = \? FOR UPDATE/);
    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(locked).toBeGreaterThan(mockDb.$transaction.mock.invocationCallOrder[0]!);
    expect(mockDb.expense.findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(locked!);
    expect(mockDb.receipt.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockDb.expense.findUnique.mock.invocationCallOrder[0]!,
    );
  });

  test('one an expense was made from is refused and kept', async () => {
    mockDb.expense.findUnique.mockResolvedValue({ id: 'e1' });
    const api = await caller();
    await expect(api.deletePending({ receiptId: 'r1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockDb.receipt.update).not.toHaveBeenCalled();
    expect(mockDb.receipt.delete).not.toHaveBeenCalled();
    expect(mockDb.receipt.deleteMany).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  test('one deleted by someone else in the meantime is NOT_FOUND', async () => {
    mockDb.$queryRaw.mockResolvedValue([]);
    const api = await caller();
    await expect(api.deletePending({ receiptId: 'r1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test('someone who neither uploaded nor saved it is refused', async () => {
    mockDb.receipt.findUnique.mockResolvedValue({ id: 'r1', groupId: 'g1', uploadedById: 'u2', savedById: 'u3' });
    const api = await caller();
    await expect(api.deletePending({ receiptId: 'r1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

// Codex on #319: deleting a receipt from the pending list now keeps it (off the group) while a
// claim session uses it, so a save for later that read it just before must not put it back
describe('saving a receipt for later while it is deleted from the pending list (#318)', () => {
  const rawSql = () => mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));
  const inGroup = {
    id: 'r1',
    status: 'COMPLETED',
    groupId: 'g1',
    uploadedById: 'u2',
    group: { members: [{ userId: 'u1' }] },
  };
  const offGroup = { id: 'r1', status: 'COMPLETED', groupId: null, uploadedById: 'u2', group: null };

  beforeEach(() => {
    mockDb.groupMember.findUnique.mockResolvedValue({ role: 'MEMBER', userId: 'u1', groupId: 'g1' });
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
    mockDb.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockDb.expense.findUnique.mockResolvedValue(null);
  });

  test('a receipt taken off the group before the save got its lock is refused, and stays off it', async () => {
    // The check before the transaction saw it in the group; under the lock it's gone from it
    mockDb.receipt.findUnique.mockResolvedValueOnce(inGroup).mockResolvedValue(offGroup);
    const api = await caller();
    await expect(api.saveForLater({ groupId: 'g1', receiptId: 'r1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });

  test("the receipt is locked before it's read in the transaction", async () => {
    mockDb.receipt.findUnique.mockResolvedValue(inGroup);
    const api = await caller();
    await api.saveForLater({ groupId: 'g1', receiptId: 'r1' });

    expect(rawSql()[0]).toMatch(/FROM "Receipt" WHERE "id" = \? FOR NO KEY UPDATE/);
    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(locked).toBeGreaterThan(mockDb.$transaction.mock.invocationCallOrder[0]!);
    const lastRead = mockDb.receipt.findUnique.mock.invocationCallOrder.at(-1)!;
    expect(lastRead).toBeGreaterThan(locked!);
    expect(mockDb.receipt.update.mock.invocationCallOrder[0]).toBeGreaterThan(lastRead);
  });

  // #411: the message showed the item's raw id
  test('an item that is not on the receipt is refused without its id in the message', async () => {
    mockDb.receipt.findUnique.mockResolvedValue(inGroup);
    mockDb.receiptItem.findMany.mockResolvedValue([{ id: 'i1' }]);
    const api = await caller();
    await expect(
      api.saveForLater({
        groupId: 'g1',
        receiptId: 'r1',
        assignments: [
          { receiptItemId: 'i1', userIds: [] },
          { receiptItemId: 'deleted', userIds: [] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', messageKey: 'itemNotOnReceipt' });
    expect(mockDb.receiptItemAssignment.deleteMany).not.toHaveBeenCalled();
  });

  test('a placeholder removed from the group is not saved as the payer (#284)', async () => {
    mockDb.receipt.findUnique.mockResolvedValue(inGroup);
    mockDb.groupMember.findMany.mockResolvedValue([]);
    const api = await caller();
    await expect(api.saveForLater({ groupId: 'g1', receiptId: 'r1', paidById: 'hal' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.groupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: 'g1', userId: { in: ['hal'] }, removedAt: null } }),
    );
    expect(mockDb.receipt.update).not.toHaveBeenCalled();
  });
});

// Codex on #319: processing a receipt for a group also sets its group, so one queued behind a
// delete from the pending list must not put the receipt back in the group
// Codex on #322: a placeholder removed from a group keeps their row (#284), and an admin can
// impersonate a placeholder, so the receipt checks must not take that row as membership
describe('a caller whose membership was removed (#284)', () => {
  test("can open none of the group's receipts", async () => {
    mockDb.receipt.findUnique.mockResolvedValue({ id: 'r1', groupId: 'g1', group: { members: [] } });
    const api = await caller();
    await expect(api.processReceipt({ receiptId: 'r1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.receipt.findUnique.mock.calls[0]![0].include.group).toEqual({
      include: { members: { where: { removedAt: null } } },
    });
  });

  test("can't scan a receipt into the group", async () => {
    mockDb.receipt.findUnique.mockResolvedValue({ id: 'r1', groupId: null, uploadedById: 'u1', group: null });
    mockDb.groupMember.findUnique.mockResolvedValue({
      role: 'MEMBER',
      userId: 'u1',
      groupId: 'g1',
      removedAt: new Date(),
    });
    const api = await caller();
    await expect(api.processReceipt({ receiptId: 'r1', groupId: 'g1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.receipt.updateMany).not.toHaveBeenCalled();
  });
});

describe('processing a receipt while it is deleted from the pending list (#318)', () => {
  const inGroup = {
    id: 'r1',
    status: 'COMPLETED',
    groupId: 'g1',
    uploadedById: 'u2',
    group: { members: [{ userId: 'u1' }] },
  };

  beforeEach(() => {
    mockDb.groupMember.findUnique.mockResolvedValue({ role: 'MEMBER', userId: 'u1', groupId: 'g1' });
    mockDb.receipt.findUnique.mockResolvedValue(inGroup);
  });

  test('claims it only while it is still where the access check found it', async () => {
    mockDb.receipt.updateMany.mockResolvedValue({ count: 0 });
    const api = await caller();
    await expect(api.processReceipt({ receiptId: 'r1', groupId: 'g1' })).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(mockDb.receipt.updateMany.mock.calls[0]![0].where).toMatchObject({ id: 'r1', groupId: 'g1' });
  });

  test('says it was removed from the group when that is why the claim failed', async () => {
    mockDb.receipt.updateMany.mockResolvedValue({ count: 0 });
    mockDb.receipt.findUnique.mockResolvedValueOnce(inGroup).mockResolvedValue({ groupId: null });
    const api = await caller();
    await expect(api.processReceipt({ receiptId: 'r1', groupId: 'g1' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Receipt was removed from this group',
    });
  });

  test('a receipt still in its group but being processed is reported as that', async () => {
    mockDb.receipt.updateMany.mockResolvedValue({ count: 0 });
    const api = await caller();
    await expect(api.processReceipt({ receiptId: 'r1', groupId: 'g1' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Receipt is already being processed',
    });
  });
});

// #364: the receipt page previews each person's total sharing tax and tip over the sum of the
// items, but the save shared them over the subtotal the scan read, the last person taking what
// was left. Once the items stopped adding up to that subtotal (an item added, deleted or
// repriced), the saved split wasn't the one the user confirmed.
describe("a receipt's saved split matches the receipt page's preview (#364)", () => {
  type Item = { id: string; totalPrice: number };
  type Assignment = { receiptItemId: string; userIds: string[] };

  function scanned(
    items: Item[],
    extractedData: { subtotal: number; tax: number; tip: number; currency?: string; date?: string },
  ) {
    mockDb.receipt.findUnique.mockResolvedValue({
      id: 'r1',
      status: 'COMPLETED',
      groupId: 'g1',
      uploadedById: 'u1',
      extractedData: { currency: 'USD', ...extractedData, total: extractedData.subtotal + extractedData.tax },
      // Unused now: the mutation read the items here before #364, so a revert runs to its own numbers
      // (and fails the tests whose items don't add up to the scanned subtotal)
      items,
    });
    // The items as they are when the expense is made, read under the receipt's lock
    mockDb.receiptItem.findMany.mockResolvedValue(items);
  }

  type Options = { tipOverride?: number; expectedShares?: { userId: string; amount: number }[] };
  const finishWith = (assignments: Assignment[], options: Options = {}) => ({
    groupId: 'g1',
    receiptId: 'r1',
    title: 'Dinner',
    paidById: 'alice',
    assignments,
    ...options,
  });

  async function save(assignments: Assignment[], options?: Options) {
    const api = await caller();
    await api.assignItemsAndCreateExpense(finishWith(assignments, options));
    const { data } = mockDb.expense.create.mock.calls[0]![0] as {
      data: {
        amount: number;
        baseCurrencyAmount: number | null;
        shares: { create: { userId: string; amount: number }[] };
      };
    };
    const shares = Object.fromEntries(data.shares.create.map((s) => [s.userId, s.amount]));
    expect(
      Object.values(shares).reduce((a, b) => a + b, 0),
      'the shares add up to the amount',
    ).toBe(data.amount);
    return { amount: data.amount, shares };
  }

  // What the receipt page shows each person before they save
  function preview(items: Item[], assignments: Assignment[], tax: number, tip: number) {
    return Object.fromEntries(
      calculateReceiptSplitTotals({ items, assignments, tax, tip }).map((person) => [person.userId, person.total]),
    );
  }

  async function expectRefused(assignments: Assignment[], error: object, options?: Options) {
    const api = await caller();
    await expect(api.assignItemsAndCreateExpense(finishWith(assignments, options))).rejects.toMatchObject(error);
    expect(mockDb.expense.create).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.createMany).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    mockDb.groupMember.findUnique.mockResolvedValue({ role: 'MEMBER', userId: 'u1', groupId: 'g1' });
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }, { userId: 'carol' }]);
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'USD' });
    mockDb.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Receipt"') ? [{ groupId: 'g1', status: 'COMPLETED' }] : [{ archivedAt: null }],
    );
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
    mockDb.expense.create.mockResolvedValue({ id: 'e1' });
    vi.mocked(getExchangeRate).mockReset();
  });

  test('an item the scan missed, added by hand (the steps in the issue)', async () => {
    // Scanned: two $20.00 items, subtotal $40.00, tax $4.00. Then a $10.00 item is added.
    const items = [
      { id: 'i1', totalPrice: 2000 },
      { id: 'i2', totalPrice: 2000 },
      { id: 'i3', totalPrice: 1000 },
    ];
    scanned(items, { subtotal: 4000, tax: 400, tip: 0 });
    const assignments = [
      { receiptItemId: 'i1', userIds: ['alice'] },
      { receiptItemId: 'i2', userIds: ['bob'] },
      { receiptItemId: 'i3', userIds: ['carol'] },
    ];

    expect(preview(items, assignments, 400, 0)).toEqual({ alice: 2160, bob: 2160, carol: 1080 });
    expect(await save(assignments)).toEqual({ amount: 5400, shares: { alice: 2160, bob: 2160, carol: 1080 } });
    // The assignments saved are the ones the split was calculated from
    expect(mockDb.receiptItemAssignment.deleteMany).toHaveBeenCalledWith({
      where: { receiptItemId: { in: ['i1', 'i2', 'i3'] } },
    });
    expect(mockDb.receiptItemAssignment.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          { receiptItemId: 'i1', userId: 'alice' },
          { receiptItemId: 'i2', userId: 'bob' },
          { receiptItemId: 'i3', userId: 'carol' },
        ],
      }),
    );
    expect(mockDb.activityLog.create.mock.calls[0]![0].data.metadata).toMatchObject({ amount: 5400 });
  });

  test('a duplicate line deleted', async () => {
    // Scanned: three $20.00 items (one read twice), subtotal $60.00, tax $6.00
    const items = [
      { id: 'i1', totalPrice: 2000 },
      { id: 'i2', totalPrice: 2000 },
    ];
    scanned(items, { subtotal: 6000, tax: 600, tip: 0 });
    const assignments = [
      { receiptItemId: 'i1', userIds: ['alice'] },
      { receiptItemId: 'i2', userIds: ['bob'] },
    ];

    expect(preview(items, assignments, 600, 0)).toEqual({ alice: 2300, bob: 2300 });
    expect(await save(assignments)).toEqual({ amount: 4600, shares: { alice: 2300, bob: 2300 } });
  });

  test('a misread price corrected', async () => {
    // Scanned: two $20.00 items, subtotal $40.00, tax $4.00, tip $5.00; the second was $30.00
    const items = [
      { id: 'i1', totalPrice: 2000 },
      { id: 'i2', totalPrice: 3000 },
    ];
    scanned(items, { subtotal: 4000, tax: 400, tip: 500 });
    const assignments = [
      { receiptItemId: 'i1', userIds: ['alice'] },
      { receiptItemId: 'i2', userIds: ['bob'] },
    ];

    expect(preview(items, assignments, 400, 500)).toEqual({ alice: 2360, bob: 3540 });
    expect(await save(assignments)).toEqual({ amount: 5900, shares: { alice: 2360, bob: 3540 } });
  });

  test('items shared unevenly, with a tip override', async () => {
    const items = [
      { id: 'i1', totalPrice: 1001 },
      { id: 'i2', totalPrice: 333 },
      { id: 'i3', totalPrice: 2999 },
    ];
    scanned(items, { subtotal: 4000, tax: 347, tip: 0 });
    const assignments = [
      { receiptItemId: 'i1', userIds: ['carol', 'alice', 'bob'] },
      { receiptItemId: 'i2', userIds: ['bob', 'alice'] },
      { receiptItemId: 'i3', userIds: ['alice'] },
    ];

    // By hand: carol 334 + 27 tax + 47 tip; alice 3499 + 280 + 493; bob, last, the 611 left
    const expected = { carol: 408, alice: 4272, bob: 611 };
    expect(preview(items, assignments, 347, 611)).toEqual(expected);
    expect(await save(assignments, { tipOverride: 611 })).toEqual({
      amount: 1001 + 333 + 2999 + 347 + 611,
      shares: expected,
    });
  });

  test('a tip override of zero replaces the scanned tip', async () => {
    const items = [
      { id: 'i1', totalPrice: 1000 },
      { id: 'i2', totalPrice: 3000 },
    ];
    scanned(items, { subtotal: 4000, tax: 400, tip: 500 });
    const assignments = [
      { receiptItemId: 'i1', userIds: ['alice'] },
      { receiptItemId: 'i2', userIds: ['bob'] },
    ];

    expect(await save(assignments, { tipOverride: 0 })).toEqual({ amount: 4400, shares: { alice: 1100, bob: 3300 } });
  });

  // Three $10.00 items, tax $1.00: 33.33 cents each, rounded (to 33) for all but the last. The
  // server keeps the order it was sent, not the order it reads the items in
  test.each([
    [['i1', 'i2', 'i3'], { alice: 1033, bob: 1033, carol: 1034 }],
    [['i3', 'i1', 'i2'], { carol: 1033, alice: 1033, bob: 1034 }],
  ])("the last person in the page's order takes the leftover cent, as in the preview (%j)", async (order, expected) => {
    const items = [
      { id: 'i1', totalPrice: 1000 },
      { id: 'i2', totalPrice: 1000 },
      { id: 'i3', totalPrice: 1000 },
    ];
    scanned(items, { subtotal: 3000, tax: 100, tip: 0 });
    const people: Record<string, string> = { i1: 'alice', i2: 'bob', i3: 'carol' };
    const assignments = order.map((id) => ({ receiptItemId: id, userIds: [people[id]!] }));

    expect(preview(items, assignments, 100, 0)).toEqual(expected);
    expect((await save(assignments)).shares).toEqual(expected);
  });

  // #364: the page sends the totals it showed, so a receipt changed on another device after the
  // page loaded it (an item repriced, the tax edited) isn't saved as a split nobody saw
  test('the totals the page showed are saved when they are still the split', async () => {
    scanned(
      [
        { id: 'i1', totalPrice: 2000 },
        { id: 'i2', totalPrice: 3000 },
      ],
      { subtotal: 5000, tax: 500, tip: 0 },
    );
    const assignments = [
      { receiptItemId: 'i1', userIds: ['alice'] },
      { receiptItemId: 'i2', userIds: ['bob'] },
    ];
    const expectedShares = [
      { userId: 'bob', amount: 3300 },
      { userId: 'alice', amount: 2200 },
    ];

    expect((await save(assignments, { expectedShares })).shares).toEqual({ alice: 2200, bob: 3300 });
  });

  test.each([
    [
      'an item repriced',
      [
        { userId: 'alice', amount: 2200 },
        { userId: 'bob', amount: 2200 },
      ],
    ],
    ['someone missing', [{ userId: 'alice', amount: 2200 }]],
    [
      'someone extra',
      [
        { userId: 'alice', amount: 2200 },
        { userId: 'bob', amount: 3300 },
        { userId: 'carol', amount: 0 },
      ],
    ],
    [
      'the two people swapped',
      [
        { userId: 'alice', amount: 3300 },
        { userId: 'bob', amount: 2200 },
      ],
    ],
    [
      'a cent off',
      [
        { userId: 'alice', amount: 2201 },
        { userId: 'bob', amount: 3299 },
      ],
    ],
    [
      'one person twice',
      [
        { userId: 'alice', amount: 2200 },
        { userId: 'alice', amount: 2200 },
      ],
    ],
  ])('totals that differ from the split (%s) are refused, writing nothing', async (_, expectedShares) => {
    scanned(
      [
        { id: 'i1', totalPrice: 2000 },
        { id: 'i2', totalPrice: 3000 },
      ],
      { subtotal: 5000, tax: 500, tip: 0 },
    );
    await expectRefused(
      [
        { receiptItemId: 'i1', userIds: ['alice'] },
        { receiptItemId: 'i2', userIds: ['bob'] },
      ],
      { code: 'CONFLICT', messageKey: 'receiptChangedElsewhere' },
      { expectedShares },
    );
  });

  // The page only sends items it shows, and only once each has someone: an item it doesn't know,
  // or one it left out, was deleted or added on another device since it loaded the receipt
  test.each([
    [
      'an item deleted elsewhere',
      [{ id: 'i1', totalPrice: 2000 }],
      [
        { receiptItemId: 'i1', userIds: ['alice'] },
        { receiptItemId: 'i2', userIds: ['bob'] },
      ],
    ],
    [
      'an item added elsewhere',
      [
        { id: 'i1', totalPrice: 2000 },
        { id: 'i2', totalPrice: 3000 },
        { id: 'i3', totalPrice: 1000 },
      ],
      [
        { receiptItemId: 'i1', userIds: ['alice'] },
        { receiptItemId: 'i2', userIds: ['bob'] },
      ],
    ],
  ])('from the page, %s says the receipt changed, writing nothing', async (_, items, assignments) => {
    scanned(items, { subtotal: 5000, tax: 0, tip: 0 });
    await expectRefused(
      assignments,
      { code: 'CONFLICT', messageKey: 'receiptChangedElsewhere' },
      {
        expectedShares: [
          { userId: 'alice', amount: 2000 },
          { userId: 'bob', amount: 3000 },
        ],
      },
    );
  });

  test("a receipt in another currency converts the total of the shares at the receipt's date", async () => {
    vi.mocked(getExchangeRate).mockResolvedValue(1.1);
    const items = [
      { id: 'i1', totalPrice: 2000 },
      { id: 'i2', totalPrice: 2000 },
      { id: 'i3', totalPrice: 1000 },
    ];
    scanned(items, { subtotal: 4000, tax: 400, tip: 0, currency: 'EUR', date: '2026-10-01' });
    const assignments = [
      { receiptItemId: 'i1', userIds: ['alice'] },
      { receiptItemId: 'i2', userIds: ['bob'] },
      { receiptItemId: 'i3', userIds: ['carol'] },
    ];

    expect(await save(assignments)).toEqual({ amount: 5400, shares: { alice: 2160, bob: 2160, carol: 1080 } });
    expect(getExchangeRate).toHaveBeenCalledWith('EUR', 'USD', '2026-10-01');
    expect(mockDb.expense.create.mock.calls[0]![0].data).toMatchObject({
      currency: 'EUR',
      exchangeRate: 1.1,
      baseCurrencyAmount: 5940,
    });
  });

  test('a receipt in another currency with no rate available is refused, writing nothing', async () => {
    vi.mocked(getExchangeRate).mockResolvedValue(null);
    scanned([{ id: 'i1', totalPrice: 2000 }], { subtotal: 2000, tax: 0, tip: 0, currency: 'EUR' });
    await expectRefused([{ receiptItemId: 'i1', userIds: ['alice'] }], {
      code: 'BAD_REQUEST',
      messageKey: 'receiptExchangeRateUnavailable',
    });
  });

  // An item added, deleted or repriced on another device just before the expense is made: the
  // split is calculated from the items as the transaction reads them, after the receipt's lock
  test('the items are read inside the transaction, after the receipt is locked', async () => {
    const items = [{ id: 'i1', totalPrice: 2000 }];
    scanned(items, { subtotal: 2000, tax: 0, tip: 0 });
    // The transaction's own client, so a read or lock made outside it is seen
    const txQueryRaw = vi.fn(mockDb.$queryRaw.getMockImplementation());
    const txFindMany = vi.fn().mockResolvedValue(items);
    const tx = { ...mockDb, $queryRaw: txQueryRaw, receiptItem: { ...mockDb.receiptItem, findMany: txFindMany } };
    mockDb.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
    await save([{ receiptItemId: 'i1', userIds: ['alice'] }]);

    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
    expect(mockDb.receiptItem.findMany).not.toHaveBeenCalled();
    const receiptLock = txQueryRaw.mock.calls.findIndex(([strings]) =>
      (strings as string[]).join('?').includes('FROM "Receipt" WHERE "id" = ? FOR SHARE'),
    );
    expect(txQueryRaw.mock.calls[receiptLock]!.slice(1)).toEqual(['r1']);
    // It reads the status it checks
    expect((txQueryRaw.mock.calls[receiptLock]![0] as string[]).join('?')).toMatch(/"groupId", "status" FROM/);
    const [itemsRead] = txFindMany.mock.invocationCallOrder;
    expect(itemsRead).toBeGreaterThan(txQueryRaw.mock.invocationCallOrder[receiptLock]!);
    expect(itemsRead).toBeLessThan(mockDb.expense.create.mock.invocationCallOrder[0]!);
    expect(txFindMany).toHaveBeenCalledWith({ where: { receiptId: 'r1' }, select: { id: true, totalPrice: true } });
  });

  test('an item added meanwhile that nobody has is refused, writing nothing', async () => {
    scanned(
      [
        { id: 'i1', totalPrice: 2000 },
        { id: 'i2', totalPrice: 2000 },
      ],
      { subtotal: 4000, tax: 400, tip: 0 },
    );
    await expectRefused([{ receiptItemId: 'i1', userIds: ['alice'] }], {
      code: 'PRECONDITION_FAILED',
      messageKey: 'receiptItemsUnassigned',
    });
  });

  test('an item that is not on the receipt (deleted meanwhile, or another receipt’s) is refused, writing nothing', async () => {
    scanned([{ id: 'i1', totalPrice: 2000 }], { subtotal: 2000, tax: 0, tip: 0 });
    await expectRefused(
      [
        { receiptItemId: 'i1', userIds: ['alice'] },
        { receiptItemId: 'foreign', userIds: ['bob'] },
      ],
      { code: 'BAD_REQUEST', messageKey: 'itemNotOnReceipt' },
    );
  });

  test('a receipt being scanned again meanwhile is refused, writing nothing', async () => {
    scanned([{ id: 'i1', totalPrice: 2000 }], { subtotal: 2000, tax: 0, tip: 0 });
    mockDb.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FROM "Receipt"') ? [{ groupId: 'g1', status: 'PROCESSING' }] : [{ archivedAt: null }],
    );
    await expectRefused([{ receiptItemId: 'i1', userIds: ['alice'] }], {
      code: 'BAD_REQUEST',
      messageKey: 'receiptNotReady',
    });
  });

  test('a receipt with no items is refused, writing nothing', async () => {
    scanned([], { subtotal: 4000, tax: 400, tip: 0 });
    await expectRefused([], { code: 'PRECONDITION_FAILED', messageKey: 'receiptItemsUnassigned' });
  });

  // The items were read, then one was deleted on another device before its assignments were
  // written: the insert fails on its foreign key, and in Postgres the whole expense rolls back
  // (this mock transaction can't show that)
  test('an item deleted before its assignments are written says the receipt changed', async () => {
    scanned([{ id: 'i1', totalPrice: 2000 }], { subtotal: 2000, tax: 0, tip: 0 });
    mockDb.receiptItemAssignment.createMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );
    const api = await caller();
    await expect(
      api.assignItemsAndCreateExpense(finishWith([{ receiptItemId: 'i1', userIds: ['alice'] }])),
    ).rejects.toMatchObject({ code: 'CONFLICT', messageKey: 'receiptChangedElsewhere' });
    expect(mockDb.activityLog.create).not.toHaveBeenCalled();
  });

  test('with expectedShares, a receipt with no items says the receipt changed', async () => {
    scanned([], { subtotal: 2000, tax: 0, tip: 0 });
    await expectRefused([], { code: 'CONFLICT', messageKey: 'receiptChangedElsewhere' }, { expectedShares: [] });
  });

  test('an item listed with nobody on it is refused, writing nothing', async () => {
    scanned(
      [
        { id: 'i1', totalPrice: 2000 },
        { id: 'i2', totalPrice: 2000 },
      ],
      { subtotal: 4000, tax: 400, tip: 0 },
    );
    await expectRefused(
      [
        { receiptItemId: 'i1', userIds: ['alice'] },
        { receiptItemId: 'i2', userIds: [] },
      ],
      { code: 'BAD_REQUEST' },
    );
  });

  test.each([
    [
      'an item listed twice',
      [
        { receiptItemId: 'i1', userIds: ['alice'] },
        { receiptItemId: 'i1', userIds: ['bob'] },
      ],
    ],
    ['someone listed twice on an item', [{ receiptItemId: 'i1', userIds: ['alice', 'alice'] }]],
  ])('%s is refused, writing nothing', async (_, assignments) => {
    scanned([{ id: 'i1', totalPrice: 2000 }], { subtotal: 2000, tax: 200, tip: 0 });
    await expectRefused(assignments, { code: 'BAD_REQUEST' });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});
