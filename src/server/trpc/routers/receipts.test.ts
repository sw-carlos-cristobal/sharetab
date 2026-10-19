import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));
vi.mock('@/server/lib/receipt-processor', () => ({ processReceiptImage: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn() },
  group: { findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn(), findMany: vi.fn() },
  receipt: { findUnique: vi.fn() },
  receiptItem: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  receiptItemAssignment: { deleteMany: vi.fn(), createMany: vi.fn() },
  expense: { create: vi.fn() },
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
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: new Date() }]);
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
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
    mockDb.expense.create.mockResolvedValue({ id: 'e1' });
    const api = await caller();
    await api.assignItemsAndCreateExpense(finish);

    expect(rawSql()).toEqual([expect.stringMatching(/FROM "Group" WHERE "id" = \? FOR SHARE/)]);
    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(locked).toBeGreaterThan(mockDb.$transaction.mock.invocationCallOrder[0]!);
    expect(locked).toBeLessThan(mockDb.expense.create.mock.invocationCallOrder[0]!);
  });
});
