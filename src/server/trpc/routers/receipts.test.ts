import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));
vi.mock('@/server/lib/receipt-processor', () => ({ processReceiptImage: vi.fn() }));
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
  receiptItem: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
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
  // What the transaction's row locks read: the group, and the receipt (still in the group)
  const locksRead = (group: object, receipt: object | null = { groupId: 'g1' }) =>
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
      items: [{ id: 'i1', totalPrice: 1000 }],
    });
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
