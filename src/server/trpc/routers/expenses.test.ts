import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn() },
  group: { findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  expense: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  expenseShare: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  settlement: { findMany: vi.fn() },
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

describe('expenses.list (#326)', () => {
  beforeEach(() => {
    mockDb.expense.findMany.mockReset().mockResolvedValue([]);
  });

  test('orders by date and then id, including when dates are equal', async () => {
    const api = await caller();
    await api.list({ groupId: 'g1' });
    expect(mockDb.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { groupId: 'g1', deletedAt: null },
        take: 21,
        orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  test('searches titles and notes case-insensitively in this group only, trimming spaces', async () => {
    const api = await caller();
    await api.list({ groupId: 'g1', search: '  PiZzA  ' });
    expect(mockDb.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          groupId: 'g1',
          deletedAt: null,
          AND: [
            {
              OR: [
                { title: { contains: 'PiZzA', mode: 'insensitive' } },
                { description: { contains: 'PiZzA', mode: 'insensitive' } },
              ],
            },
          ],
        },
      }),
    );
  });

  test('escapes %, _ and \\ so a search matches them literally (#479)', async () => {
    const api = await caller();
    await api.list({ groupId: 'g1', search: '50%_\\' });
    expect(mockDb.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          groupId: 'g1',
          deletedAt: null,
          AND: [
            {
              OR: [
                { title: { contains: '50\\%\\_\\\\', mode: 'insensitive' } },
                { description: { contains: '50\\%\\_\\\\', mode: 'insensitive' } },
              ],
            },
          ],
        },
      }),
    );
  });

  test('rejects a NUL byte in the search before querying expenses (#479)', async () => {
    const api = await caller();
    await expect(api.list({ groupId: 'g1', search: 'a\u0000b' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.expense.findMany).not.toHaveBeenCalled();
  });

  test.each(['', '   '])('treats a blank search (%j) as no filter', async (search) => {
    const api = await caller();
    await api.list({ groupId: 'g1', search });
    expect(mockDb.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: 'g1', deletedAt: null } }),
    );
  });

  test("pages from the first unseen expense's date and id, without looking that expense up (#478)", async () => {
    const day = new Date('2025-06-15T12:00:00.000Z');
    const earlier = new Date('2025-06-01T12:00:00.000Z');
    mockDb.expense.findMany
      .mockResolvedValueOnce([
        { id: 'e5', expenseDate: day },
        { id: 'e4', expenseDate: day },
        { id: 'e3', expenseDate: day },
      ])
      .mockResolvedValueOnce([
        { id: 'e3', expenseDate: day },
        { id: 'e2', expenseDate: earlier },
      ]);
    const api = await caller();
    const first = await api.list({ groupId: 'g1', search: 'pizza', limit: 2 });
    expect(first.expenses).toEqual([
      { id: 'e5', expenseDate: day },
      { id: 'e4', expenseDate: day },
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(mockDb.expense.findMany.mock.calls[0]![0].where.AND).toHaveLength(1);

    const second = await api.list({ groupId: 'g1', search: 'pizza', limit: 2, cursor: first.nextCursor! });
    expect(second).toEqual({
      expenses: [
        { id: 'e3', expenseDate: day },
        { id: 'e2', expenseDate: earlier },
      ],
      nextCursor: undefined,
    });
    const query = mockDb.expense.findMany.mock.calls[1]![0];
    expect(query).toMatchObject({
      take: 3,
      orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }],
      where: {
        groupId: 'g1',
        AND: [
          { OR: expect.any(Array) },
          { OR: [{ expenseDate: { lt: day } }, { expenseDate: day, id: { lte: 'e3' } }] },
        ],
      },
    });
    expect(query).not.toHaveProperty('cursor');
    expect(query).not.toHaveProperty('skip');
  });

  test.each(['e3', 'not base64 at all', Buffer.from('["not a date","e3"]').toString('base64url')])(
    "refuses a cursor it didn't issue (%j) before querying expenses (#478)",
    async (cursor) => {
      const api = await caller();
      await expect(api.list({ groupId: 'g1', cursor })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockDb.expense.findMany).not.toHaveBeenCalled();
    },
  );

  test('an exact full page and no matches both end pagination', async () => {
    mockDb.expense.findMany.mockResolvedValueOnce([{ id: 'e2' }, { id: 'e1' }]);
    const api = await caller();
    expect(await api.list({ groupId: 'g1', limit: 2 })).toEqual({
      expenses: [{ id: 'e2' }, { id: 'e1' }],
      nextCursor: undefined,
    });
    expect(await api.list({ groupId: 'g1', search: 'missing' })).toEqual({
      expenses: [],
      nextCursor: undefined,
    });
  });

  test('rejects an oversized search before querying expenses', async () => {
    const api = await caller();
    await expect(api.list({ groupId: 'g1', search: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.expense.findMany).not.toHaveBeenCalled();
  });

  test('a search does not bypass group membership', async () => {
    mockDb.groupMember.findUnique.mockResolvedValueOnce(null);
    const api = await caller();
    await expect(api.list({ groupId: 'g2', search: 'pizza' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.expense.findMany).not.toHaveBeenCalled();
  });
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
    mockDb.expenseShare.findMany.mockResolvedValue([]);
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
    expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
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

// #284: a placeholder removed from the group stays in the expenses they were in, so
// editing one keeps their part theirs. But only in the part they had: making them the
// payer of an expense they had a share in would put them in something new.
describe('editing an expense a removed placeholder is in', () => {
  const rawSql = () => mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));
  const halPaid = {
    id: 'e1',
    groupId: 'g1',
    paidById: 'hal',
    addedById: 'u1',
    amount: 1000,
    currency: 'USD',
    exchangeRate: 1,
    baseCurrencyAmount: null,
    expenseDate: new Date('2026-10-01T00:00:00Z'),
  };
  const update = { groupId: 'g1', expenseId: 'e1', amount: 1000 };

  beforeEach(() => {
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'USD' });
    mockDb.$queryRaw.mockImplementation(async (strings: string[]) =>
      strings.join('?').includes('FROM "Expense"') ? [{ paidById: 'hal' }] : [{ archivedAt: null }],
    );
    // As the edit started; the row read under the lock says who's in it now
    mockDb.expense.findUnique.mockResolvedValue({ ...halPaid, paidById: 'u1' });
    mockDb.expenseShare.findMany.mockResolvedValue([{ userId: 'hal' }, { userId: 'u1' }]);
    mockDb.groupMember.findFirst.mockResolvedValue({ userId: 'hal' });
    // Everyone the check names is found
    mockDb.groupMember.count.mockImplementation(
      async ({ where }: { where: { userId: { in: string[] } } }) => where.userId.in.length,
    );
    mockDb.expense.update.mockResolvedValue({ id: 'e1' });
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  });

  // Two edits at once would each check against what the other is replacing
  test('locks the expense row after the group, then reads who is in it', async () => {
    const api = await caller();
    await api.update({ ...update, paidById: 'hal', shares: [{ userId: 'u1', amount: 1000 }] });

    expect(rawSql()).toEqual([
      expect.stringMatching(/FROM "Group" WHERE "id" = \? FOR SHARE/),
      expect.stringMatching(/FROM "Expense" WHERE "id" = \? FOR NO KEY UPDATE/),
    ]);
    const lockedExpense = mockDb.$queryRaw.mock.invocationCallOrder[1]!;
    expect(mockDb.expenseShare.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(lockedExpense);
    expect(mockDb.groupMember.findFirst.mock.invocationCallOrder[0]).toBeGreaterThan(lockedExpense);
  });

  test('keeps a removed payer as the payer', async () => {
    const api = await caller();
    await api.update({ ...update, paidById: 'hal', shares: [{ userId: 'u1', amount: 1000 }] });
    expect(mockDb.groupMember.findFirst).toHaveBeenCalledWith({ where: { groupId: 'g1', userId: 'hal' } });
  });

  test('a new payer must be a current member', async () => {
    const api = await caller();
    await api.update({ ...update, paidById: 'u2', shares: [{ userId: 'u1', amount: 1000 }] });
    expect(mockDb.groupMember.findFirst).toHaveBeenCalledWith({
      where: { groupId: 'g1', userId: 'u2', removedAt: null },
    });
  });

  test('a share may be a current member, or someone removed who had one', async () => {
    const api = await caller();
    await api.update({ ...update, shares: [{ userId: 'hal', amount: 1000 }] });
    expect(mockDb.groupMember.count).toHaveBeenCalledWith({
      where: { groupId: 'g1', userId: { in: ['hal'] }, OR: [{ removedAt: null }, { userId: { in: ['hal', 'u1'] } }] },
    });
  });
});

// #327: deleting an expense removed its row, so one mis-tap lost it for the whole group.
// It's marked deleted now, and whoever could delete it can restore it.
describe('deleting and restoring an expense (#327)', () => {
  const rawSql = () => mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));
  const deletedAt = new Date('2026-11-01T12:00:00Z');
  const dinner = {
    id: 'e1',
    groupId: 'g1',
    title: 'Dinner',
    paidById: 'u1',
    addedById: 'u1',
    amount: 1000,
    currency: 'USD',
    exchangeRate: 1,
    baseCurrencyAmount: null,
    expenseDate: new Date('2026-10-01T00:00:00Z'),
    deletedAt: null as Date | null,
  };
  // What the row read under its lock says
  let lockedRow: {
    paidById: string;
    addedById: string;
    amount: number;
    baseCurrencyAmount: number | null;
    deletedAt: Date | null;
  };

  beforeEach(() => {
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'USD' });
    lockedRow = { paidById: 'u1', addedById: 'u1', amount: 1000, baseCurrencyAmount: null, deletedAt: null };
    mockDb.$queryRaw.mockImplementation(async (strings: string[]) =>
      strings.join('?').includes('FROM "Expense"') ? [lockedRow] : [{ archivedAt: null }],
    );
    mockDb.expense.findUnique.mockResolvedValue(dinner);
    mockDb.expense.updateMany.mockResolvedValue({ count: 1 });
    mockDb.expense.update.mockResolvedValue({ id: 'e1' });
    // u1 paid $10.00 split with u2
    mockDb.expenseShare.findMany.mockResolvedValue([
      { userId: 'u1', amount: 500 },
      { userId: 'u2', amount: 500 },
    ]);
    mockDb.groupMember.findFirst.mockResolvedValue({ userId: 'u1' });
    mockDb.groupMember.count.mockImplementation(
      async ({ where }: { where: { userId: { in: string[] } } }) => where.userId.in.length,
    );
    // Everyone the restore asks about is a current member unless a test says otherwise
    mockDb.groupMember.findMany.mockImplementation(async ({ where }: { where: { userId: { in: string[] } } }) =>
      where.userId.in.map((userId) => ({ userId })),
    );
    mockDb.expense.findMany.mockResolvedValue([]);
    mockDb.settlement.findMany.mockResolvedValue([]);
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  });

  describe('delete', () => {
    test('marks the expense deleted, and by whom, instead of removing it, and logs it', async () => {
      const api = await caller();
      await expect(api.delete({ groupId: 'g1', expenseId: 'e1' })).resolves.toEqual({ success: true });

      expect(mockDb.expense.delete).not.toHaveBeenCalled();
      expect(mockDb.expense.updateMany).toHaveBeenCalledWith({
        where: { id: 'e1', groupId: 'g1', deletedAt: null },
        data: { deletedAt: expect.any(Date), deletedById: 'u1' },
      });
      expect(mockDb.activityLog.create).toHaveBeenCalledWith({
        data: {
          groupId: 'g1',
          userId: 'u1',
          type: 'EXPENSE_DELETED',
          entityId: 'e1',
          metadata: { title: 'Dinner', amount: 1000 },
        },
      });
    });

    test('one deleted meanwhile (a second tap, another member) is NOT_FOUND and logged once', async () => {
      mockDb.expense.updateMany.mockResolvedValue({ count: 0 });
      const api = await caller();
      await expect(api.delete({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mockDb.activityLog.create).not.toHaveBeenCalled();
    });

    test('one already deleted is NOT_FOUND', async () => {
      mockDb.expense.findUnique.mockResolvedValue({ ...dinner, deletedAt });
      const api = await caller();
      await expect(api.delete({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const edit = { groupId: 'g1', expenseId: 'e1', title: 'Lunch' };

    test('refuses a deleted expense', async () => {
      mockDb.expense.findUnique.mockResolvedValue({ ...dinner, deletedAt });
      const api = await caller();
      await expect(api.update(edit)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'This expense was deleted. Restore it before editing it.',
      });
      expect(mockDb.expense.update).not.toHaveBeenCalled();
    });

    test('refuses one deleted while the edit was on its way, writing nothing', async () => {
      lockedRow = { ...lockedRow, deletedAt };
      const api = await caller();
      await expect(
        api.update({ ...edit, amount: 2000, shares: [{ userId: 'u1', amount: 2000 }] }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'This expense was deleted. Restore it before editing it.',
      });
      expect(mockDb.expenseShare.deleteMany).not.toHaveBeenCalled();
      expect(mockDb.expense.update).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    beforeEach(() => {
      mockDb.expense.findUnique.mockResolvedValue({ ...dinner, deletedAt });
      lockedRow = { ...lockedRow, deletedAt };
    });

    test('clears the deletion and logs the restore', async () => {
      const api = await caller();
      await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).resolves.toEqual({ success: true });

      expect(mockDb.expense.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { deletedAt: null, deletedById: null },
      });
      expect(mockDb.activityLog.create).toHaveBeenCalledWith({
        data: {
          groupId: 'g1',
          userId: 'u1',
          type: 'EXPENSE_RESTORED',
          entityId: 'e1',
          metadata: { title: 'Dinner', amount: 1000 },
        },
      });
    });

    test('locks the group, then the expense row, then checks who is in it', async () => {
      const api = await caller();
      await api.restore({ groupId: 'g1', expenseId: 'e1' });

      expect(rawSql()).toEqual([
        expect.stringMatching(/FROM "Group" WHERE "id" = \? FOR SHARE/),
        expect.stringMatching(/FROM "Expense"\s+WHERE "id" = \? FOR NO KEY UPDATE/),
      ]);
      const lockedExpense = mockDb.$queryRaw.mock.invocationCallOrder[1]!;
      expect(mockDb.expenseShare.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(lockedExpense);
      expect(mockDb.groupMember.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(lockedExpense);
      expect(mockDb.expense.update.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockDb.groupMember.findMany.mock.invocationCallOrder[0]!,
      );
    });

    // Restoring puts its balances back, as creating it would, so it may not give someone no
    // longer in the group a balance. It may settle one: say u2 was removed at zero, and then
    // an expense was deleted that left them owed money.
    describe('with someone no longer in the group', () => {
      beforeEach(() => {
        mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'u1' }]);
        mockDb.user.findUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) =>
          args.select?.placeholderName ? { name: 'Hal', placeholderName: null } : { suspendedAt: null },
        );
      });
      // An expense still in the group: u2 paid $5.00 for u1, so u1 owes u2 $5.00
      const u2Paid = (amount: number) => ({
        paidById: 'u2',
        amount,
        baseCurrencyAmount: null,
        shares: [{ userId: 'u1', amount }],
      });

      test('asks who in it is a current member', async () => {
        mockDb.expense.findMany.mockResolvedValue([u2Paid(500)]);
        const api = await caller();
        await api.restore({ groupId: 'g1', expenseId: 'e1' });
        expect(mockDb.groupMember.findMany).toHaveBeenCalledWith({
          where: { groupId: 'g1', userId: { in: ['u1', 'u2'] }, removedAt: null },
          select: { userId: true },
        });
      });

      test('restores one that settles their balance', async () => {
        mockDb.expense.findMany.mockResolvedValue([u2Paid(500)]);
        const api = await caller();
        await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).resolves.toEqual({ success: true });
        expect(mockDb.expense.update).toHaveBeenCalled();
      });

      test('restores one that settles part of it', async () => {
        mockDb.expense.findMany.mockResolvedValue([u2Paid(800)]);
        const api = await caller();
        await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).resolves.toEqual({ success: true });
      });

      test.each([
        ['would give them a balance', 0],
        ['would take them past zero', 300],
        ['would take them a cent past zero', 499],
      ])('refuses one that %s, naming them', async (_, owed) => {
        mockDb.expense.findMany.mockResolvedValue(owed > 0 ? [u2Paid(owed)] : []);
        const api = await caller();
        await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message:
            'Hal is no longer in the group, so this expense can be restored only if it settles what they still owe or are owed.',
        });
        expect(mockDb.expense.update).not.toHaveBeenCalled();
        expect(mockDb.activityLog.create).not.toHaveBeenCalled();
      });

      // The balances it reads have to leave this expense out, so they're read before it's restored
      test('reads the balances after the locks and before the restore', async () => {
        mockDb.expense.findMany.mockResolvedValue([u2Paid(500)]);
        const api = await caller();
        await api.restore({ groupId: 'g1', expenseId: 'e1' });
        expect(mockDb.expense.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(
          mockDb.$queryRaw.mock.invocationCallOrder[1]!,
        );
        expect(mockDb.expense.update.mock.invocationCallOrder[0]).toBeGreaterThan(
          mockDb.expense.findMany.mock.invocationCallOrder[0]!,
        );
      });

      // The deleted expense: u2 paid $10.00, and u1 has all of it, so restoring it adds $10.00
      // to what u2 is owed
      describe('who paid it', () => {
        beforeEach(() => {
          lockedRow = { paidById: 'u2', addedById: 'u1', amount: 1000, baseCurrencyAmount: null, deletedAt };
          mockDb.expenseShare.findMany.mockResolvedValue([{ userId: 'u1', amount: 1000 }]);
        });
        // An expense still in the group: u1 paid for u2
        const u1Paid = (amount: number) => ({
          paidById: 'u1',
          amount,
          baseCurrencyAmount: null,
          shares: [{ userId: 'u2', amount }],
        });

        test('restores one that settles what they owe', async () => {
          mockDb.expense.findMany.mockResolvedValue([u1Paid(1000)]);
          const api = await caller();
          await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).resolves.toEqual({ success: true });
        });

        test('refuses one that adds to what they are owed', async () => {
          mockDb.expense.findMany.mockResolvedValue([u2Paid(500)]);
          const api = await caller();
          await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
            message: expect.stringContaining('Hal is no longer in the group'),
          });
        });
      });

      // u2 paid $10.00 split with u1: what they paid and what they owe make one change, +$5.00
      test('takes what someone both paid and owes as one change', async () => {
        lockedRow = { paidById: 'u2', addedById: 'u1', amount: 1000, baseCurrencyAmount: null, deletedAt };
        const u1Paid500ForU2 = {
          paidById: 'u1',
          amount: 500,
          baseCurrencyAmount: null,
          shares: [{ userId: 'u2', amount: 500 }],
        };
        mockDb.expense.findMany.mockResolvedValue([u1Paid500ForU2]);
        const api = await caller();
        await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).resolves.toEqual({ success: true });

        mockDb.expense.findMany.mockResolvedValue([]);
        await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
          message: expect.stringContaining('Hal is no longer in the group'),
        });
      });

      // In another currency the change is the converted share: 1,100 group-currency cents over
      // two equal shares is 550 each
      test.each([
        ['restores one that settles', 550, true],
        ['refuses one that takes them a cent past zero', 549, false],
      ])('works out a converted expense in the group currency: %s', async (_, owed, ok) => {
        lockedRow = { paidById: 'u1', addedById: 'u1', amount: 1000, baseCurrencyAmount: 1100, deletedAt };
        mockDb.expense.findMany.mockResolvedValue([
          { paidById: 'u2', amount: 500, baseCurrencyAmount: owed, shares: [{ userId: 'u1', amount: 500 }] },
        ]);
        const api = await caller();
        const restored = api.restore({ groupId: 'g1', expenseId: 'e1' });
        await (ok
          ? expect(restored).resolves.toEqual({ success: true })
          : expect(restored).rejects.toMatchObject({
              message: expect.stringContaining('Hal is no longer in the group'),
            }));
      });

      test('names the one it would give a balance when two are no longer in the group', async () => {
        mockDb.expenseShare.findMany.mockResolvedValue([
          { userId: 'u2', amount: 500 },
          { userId: 'u3', amount: 500 },
        ]);
        // u2 is owed $5.00, which restoring settles; u3 is at zero
        mockDb.expense.findMany.mockResolvedValue([u2Paid(500)]);
        mockDb.user.findUnique.mockImplementation(
          async (args: { where: { id: string }; select?: Record<string, unknown> }) =>
            args.select?.placeholderName
              ? { name: args.where.id === 'u3' ? 'Ivy' : 'Hal', placeholderName: null }
              : { suspendedAt: null },
        );
        const api = await caller();
        await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
          message: expect.stringContaining('Ivy is no longer in the group'),
        });
      });

      test('says someone without naming them when they have no name', async () => {
        mockDb.user.findUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) =>
          args.select?.placeholderName ? { name: null, placeholderName: null } : { suspendedAt: null },
        );
        const api = await caller();
        await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
          message:
            'Someone in this expense is no longer in the group, so it can be restored only if it settles what they still owe or are owed.',
        });
      });
    });

    test("doesn't read balances when everyone in it is a current member", async () => {
      const api = await caller();
      await api.restore({ groupId: 'g1', expenseId: 'e1' });
      expect(mockDb.expense.findMany).not.toHaveBeenCalled();
    });

    test('refuses one restored meanwhile', async () => {
      lockedRow = { ...lockedRow, deletedAt: null };
      const api = await caller();
      await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: "This expense isn't deleted.",
      });
      expect(mockDb.expense.update).not.toHaveBeenCalled();
    });

    test('refuses one that was never deleted, before the transaction', async () => {
      mockDb.expense.findUnique.mockResolvedValue(dinner);
      const api = await caller();
      await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
        message: "This expense isn't deleted.",
      });
      expect(mockDb.$transaction).not.toHaveBeenCalled();
    });

    test('takes the same permission as deleting it', async () => {
      mockDb.expense.findUnique.mockResolvedValue({ ...dinner, deletedAt, paidById: 'u2', addedById: 'u2' });
      const api = await caller();
      await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only the expense creator, payer, or group owner/admin can restore this expense',
      });
      expect(mockDb.$transaction).not.toHaveBeenCalled();
    });

    // A placeholder merge moves who paid and who added it, deleted or not, so the
    // permission is checked again on the row read under its lock
    test('checks the permission again on who paid and added it under the row lock', async () => {
      lockedRow = { ...lockedRow, paidById: 'u3', addedById: 'u3' };
      const api = await caller();
      await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only the expense creator, payer, or group owner/admin can restore this expense',
      });
      expect(rawSql().at(-1)).toMatch(/SELECT "paidById", "addedById",/);
      expect(mockDb.expense.update).not.toHaveBeenCalled();
      expect(mockDb.activityLog.create).not.toHaveBeenCalled();
    });

    test("an owner may restore anyone's", async () => {
      mockDb.groupMember.findUnique.mockResolvedValue({ role: 'OWNER', userId: 'u1', groupId: 'g1' });
      mockDb.expense.findUnique.mockResolvedValue({ ...dinner, deletedAt, paidById: 'u2', addedById: 'u2' });
      const api = await caller();
      await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).resolves.toEqual({ success: true });
    });

    test.each([
      ['its payer', 'MEMBER', { paidById: 'u1', addedById: 'u2' }],
      ['who added it', 'MEMBER', { paidById: 'u2', addedById: 'u1' }],
      ['a group admin', 'ADMIN', { paidById: 'u2', addedById: 'u2' }],
    ] as const)('%s may restore it, as they may delete it', async (_, role, people) => {
      mockDb.groupMember.findUnique.mockResolvedValue({ role, userId: 'u1', groupId: 'g1' });
      mockDb.expense.findUnique.mockResolvedValue({ ...dinner, ...people, deletedAt });
      const api = await caller();
      await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).resolves.toEqual({ success: true });
    });

    test('a member who neither paid nor added it may not delete it either', async () => {
      mockDb.expense.findUnique.mockResolvedValue({ ...dinner, paidById: 'u2', addedById: 'u2' });
      const api = await caller();
      await expect(api.delete({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only the expense creator, payer, or group owner/admin can delete this expense',
      });
      expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
    });

    test('an expense in another group is NOT_FOUND', async () => {
      mockDb.expense.findUnique.mockResolvedValue({ ...dinner, deletedAt, groupId: 'g2' });
      const api = await caller();
      await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('a missing expense is NOT_FOUND', async () => {
      mockDb.expense.findUnique.mockResolvedValue(null);
      const api = await caller();
      await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mockDb.$transaction).not.toHaveBeenCalled();
    });

    test('one gone by the time its row is locked is NOT_FOUND, restoring and logging nothing', async () => {
      mockDb.$queryRaw.mockImplementation(async (strings: string[]) =>
        strings.join('?').includes('FROM "Expense"') ? [] : [{ archivedAt: null }],
      );
      const api = await caller();
      await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mockDb.expense.update).not.toHaveBeenCalled();
      expect(mockDb.activityLog.create).not.toHaveBeenCalled();
    });

    test('refuses in an archived group, checked again under the lock', async () => {
      mockDb.$queryRaw.mockResolvedValue([{ archivedAt: new Date() }]);
      const api = await caller();
      await expect(api.restore({ groupId: 'g1', expenseId: 'e1' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Cannot restore expenses in an archived group',
      });
      expect(mockDb.expense.update).not.toHaveBeenCalled();
    });
  });

  test('get returns a deleted expense and says who deleted it, for the detail page', async () => {
    mockDb.expense.findUnique.mockResolvedValue({ ...dinner, deletedAt, deletedBy: { id: 'u2', name: 'Bob' } });
    const api = await caller();
    await expect(api.get({ groupId: 'g1', expenseId: 'e1' })).resolves.toMatchObject({
      deletedAt,
      deletedBy: { name: 'Bob' },
    });
    expect(mockDb.expense.findUnique.mock.calls[0]![0].include.deletedBy).toEqual({ select: { id: true, name: true } });
  });
});

test('expenses.list with deleted lists only the deleted expenses, for the Deleted section (#327)', async () => {
  mockDb.expense.findMany.mockReset().mockResolvedValue([]);
  const api = await caller();
  await api.list({ groupId: 'g1', deleted: true });
  const query = mockDb.expense.findMany.mock.calls[0]![0];
  expect(query.where).toEqual({ groupId: 'g1', deletedAt: { not: null } });
  expect(query.include.deletedBy).toEqual({ select: { id: true, name: true } });
});
