import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn() },
  group: { findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  expense: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  expenseShare: { deleteMany: vi.fn(), createMany: vi.fn() },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function caller() {
  const { expensesRouter } = await import('./expenses');
  const ctx = { session: { user: { id: 'u1' } }, db: mockDb, headers: new Headers(), impersonating: null };
  return expensesRouter.createCaller(ctx as unknown as Parameters<typeof expensesRouter.createCaller>[0]);
}

const scannedReceipt = {
  id: 'r1',
  imagePath: '/app/uploads/u1/receipt.jpg',
  aiProvider: 'openai-codex',
  rawResponse: { error: 'upstream provider error text' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  mockDb.groupMember.findUnique.mockResolvedValue({ role: 'MEMBER', userId: 'u1', groupId: 'g1' });
  // Answers like Prisma: the receipt comes back only when the query includes or selects it
  mockDb.expense.findUnique.mockImplementation(
    async (args: { include?: Record<string, unknown>; select?: Record<string, unknown> }) => ({
      id: 'e1',
      groupId: 'g1',
      receiptId: 'r1',
      ...(args.include?.receipt || args.select?.receipt ? { receipt: scannedReceipt } : {}),
    }),
  );
});

describe('expenses.get (#280)', () => {
  test("doesn't return the receipt row (its provider, raw response and image path)", async () => {
    const api = await caller();
    const expense = await api.get({ groupId: 'g1', expenseId: 'e1' });
    expect(expense).not.toHaveProperty('receipt');
  });
});

// #289: each write checked archivedAt in its own statement before writing, so
// an archive that landed in between let the write through, and the group could
// end up archived with a balance nobody can settle. The check that counts now
// locks the group's row as the write's transaction starts.
describe('a group archived while a change was on its way (#289)', () => {
  // The SQL of each $queryRaw call (a tagged template, strings first)
  const rawSql = () => mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));
  const ownExpense = {
    id: 'e1',
    groupId: 'g1',
    paidById: 'u1',
    addedById: 'u1',
    amount: 1000,
    currency: 'USD',
    exchangeRate: 1,
    baseCurrencyAmount: null,
    expenseDate: new Date('2026-10-01T00:00:00Z'),
  };
  const newExpense = {
    groupId: 'g1',
    title: 'Dinner',
    amount: 1000,
    paidById: 'u1',
    splitMode: 'EQUAL' as const,
    shares: [{ userId: 'u1', amount: 1000 }],
  };

  beforeEach(() => {
    // The early check still sees the group active...
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'USD' });
    // ...but by the time the transaction locks its row, it's archived
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: new Date() }]);
    mockDb.expense.findUnique.mockResolvedValue(ownExpense);
    mockDb.groupMember.findFirst.mockResolvedValue({ userId: 'u1' });
    mockDb.groupMember.count.mockResolvedValue(1);
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  });

  test('create refuses, writing nothing', async () => {
    const api = await caller();
    await expect(api.create(newExpense)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot add expenses to an archived group',
    });
    expect(mockDb.expense.create).not.toHaveBeenCalled();
    expect(mockDb.activityLog.create).not.toHaveBeenCalled();
  });

  test('update refuses, writing nothing', async () => {
    const api = await caller();
    await expect(
      api.update({ groupId: 'g1', expenseId: 'e1', amount: 2000, shares: [{ userId: 'u1', amount: 2000 }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Cannot modify expenses in an archived group' });
    expect(mockDb.expenseShare.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.expense.update).not.toHaveBeenCalled();
  });

  test('delete refuses, deleting nothing', async () => {
    const api = await caller();
    await expect(api.delete({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot delete expenses from an archived group',
    });
    expect(mockDb.expense.delete).not.toHaveBeenCalled();
  });

  test('an active group is locked FOR SHARE inside the transaction, before the write', async () => {
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
    mockDb.expense.create.mockResolvedValue({ id: 'e2', shares: [] });
    const api = await caller();
    await api.create(newExpense);

    expect(rawSql()).toEqual([expect.stringMatching(/FROM "Group" WHERE "id" = \? FOR SHARE/)]);
    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(locked).toBeGreaterThan(mockDb.$transaction.mock.invocationCallOrder[0]!);
    expect(locked).toBeLessThan(mockDb.expense.create.mock.invocationCallOrder[0]!);
  });

  // Codex on #308: a write that checked its people were members before a leave
  // committed could still write them in afterwards. Checked after the group
  // lock, a leave in progress has either finished (and they're gone) or waits.
  test('create checks its people are members inside the transaction, after the lock', async () => {
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
    mockDb.expense.create.mockResolvedValue({ id: 'e2', shares: [] });
    const api = await caller();
    await api.create(newExpense);

    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(mockDb.groupMember.findFirst.mock.invocationCallOrder[0]).toBeGreaterThan(locked!);
    expect(mockDb.groupMember.count.mock.invocationCallOrder[0]).toBeGreaterThan(locked!);
    expect(mockDb.groupMember.count.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.expense.create.mock.invocationCallOrder[0]!,
    );
  });

  test('update checks its people are members inside the transaction, after the lock', async () => {
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
    mockDb.expense.update.mockResolvedValue({ id: 'e1' });
    const api = await caller();
    await api.update({
      groupId: 'g1',
      expenseId: 'e1',
      paidById: 'u1',
      amount: 2000,
      shares: [{ userId: 'u1', amount: 2000 }],
    });

    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(mockDb.groupMember.findFirst.mock.invocationCallOrder[0]).toBeGreaterThan(locked!);
    expect(mockDb.groupMember.count.mock.invocationCallOrder[0]).toBeGreaterThan(locked!);
    expect(mockDb.groupMember.count.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.expenseShare.deleteMany.mock.invocationCallOrder[0]!,
    );
  });
});
