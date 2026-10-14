import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  group: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
  activityLog: { create: vi.fn(), deleteMany: vi.fn() },
  expense: { findMany: vi.fn(), updateMany: vi.fn() },
  expenseShare: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), delete: vi.fn() },
  settlement: { findMany: vi.fn(), deleteMany: vi.fn() },
  receiptItemAssignment: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function caller() {
  const { groupsRouter } = await import('./groups');
  const ctx = { session: { user: { id: 'owner' } }, db: mockDb, headers: new Headers(), impersonating: null };
  return groupsRouter.createCaller(ctx as unknown as Parameters<typeof groupsRouter.createCaller>[0]);
}

beforeEach(() => {
  vi.resetAllMocks();
  // protectedProcedure looks the caller up; groupMemberProcedure checks membership.
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  mockDb.groupMember.findUnique.mockResolvedValue({ role: 'OWNER', userId: 'owner', groupId: 'g1' });
  mockDb.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? arg(mockDb) : Promise.all(arg as Promise<unknown>[]),
  );
});

describe('group and placeholder names are trimmed', () => {
  test('create refuses a group name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.create({ name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.group.create).not.toHaveBeenCalled();
  });

  test('create stores the group name without surrounding whitespace', async () => {
    mockDb.group.create.mockResolvedValue({ id: 'g1', name: 'Trip' });
    const api = await caller();
    await api.create({ name: '  Trip  ' });
    expect(mockDb.group.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Trip' }) }),
    );
  });

  test('update refuses a group name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.update({ groupId: 'g1', name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.group.update).not.toHaveBeenCalled();
  });

  test('addPlaceholder refuses a name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.addPlaceholder({ groupId: 'g1', name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  test('addPlaceholder stores the name without surrounding whitespace', async () => {
    mockDb.user.create.mockResolvedValue({ id: 'p1', name: 'Dave' });
    const api = await caller();
    await api.addPlaceholder({ groupId: 'g1', name: '  Dave  ' });
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Dave', placeholderName: 'Dave' }) }),
    );
  });

  test('renamePlaceholder refuses a name that is only whitespace', async () => {
    // The caller lookup, then the placeholder lookup: without the trim the rename would go through.
    mockDb.user.findUnique
      .mockResolvedValueOnce({ suspendedAt: null })
      .mockResolvedValueOnce({ id: 'p1', isPlaceholder: true });
    const api = await caller();
    await expect(api.renamePlaceholder({ groupId: 'g1', placeholderUserId: 'p1', name: '   ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });
});

// #260: removing a placeholder moved their shares onto each expense's payer,
// their expenses onto the acting admin, and deleted their settlements, so
// whatever they owed or were owed vanished from everyone else's balance.
describe('removing a placeholder', () => {
  type Share = { userId: string; amount: number };
  const expense = (paidById: string, amount: number, shares: Share[]) => ({
    paidById,
    addedById: 'owner',
    amount,
    baseCurrencyAmount: null,
    shares,
  });

  function setUp(expenses: ReturnType<typeof expense>[], settlements: object[] = []) {
    // The caller lookup and membership check, then the target's membership and user rows.
    mockDb.groupMember.findUnique
      .mockResolvedValueOnce({ role: 'OWNER', userId: 'owner', groupId: 'g1' })
      .mockResolvedValueOnce({ id: 'gm-p1', role: 'MEMBER', userId: 'p1', groupId: 'g1' });
    mockDb.user.findUnique
      .mockResolvedValueOnce({ suspendedAt: null })
      .mockResolvedValueOnce({ isPlaceholder: true, name: 'Alice', placeholderName: 'Alice' });
    mockDb.group.findUnique.mockResolvedValue({ currency: 'USD' });
    mockDb.expense.findMany.mockResolvedValue(expenses);
    mockDb.settlement.findMany.mockResolvedValue(settlements);
    mockDb.expenseShare.findMany.mockResolvedValue([]);
  }

  function expectNoMoneyRewritten() {
    expect(mockDb.expenseShare.update).not.toHaveBeenCalled();
    expect(mockDb.expenseShare.create).not.toHaveBeenCalled();
    expect(mockDb.expenseShare.delete).not.toHaveBeenCalled();
    expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
    expect(mockDb.settlement.deleteMany).not.toHaveBeenCalled();
  }

  test('is refused while the placeholder is owed money, naming the amount', async () => {
    // Alice paid $60.00 split three ways, so she is owed $40.00.
    setUp([
      expense('p1', 6000, [
        { userId: 'owner', amount: 2000 },
        { userId: 'bob', amount: 2000 },
        { userId: 'p1', amount: 2000 },
      ]),
    ]);
    const api = await caller();
    await expect(api.removeMember({ groupId: 'g1', userId: 'p1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('Alice is owed $40.00'),
    });
    expectNoMoneyRewritten();
    expect(mockDb.groupMember.delete).not.toHaveBeenCalled();
    expect(mockDb.user.delete).not.toHaveBeenCalled();
  });

  test('is refused while the placeholder owes money', async () => {
    setUp([
      expense('owner', 1000, [
        { userId: 'owner', amount: 500 },
        { userId: 'p1', amount: 500 },
      ]),
    ]);
    const api = await caller();
    await expect(api.removeMember({ groupId: 'g1', userId: 'p1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('Alice owes $5.00'),
    });
    expect(mockDb.user.delete).not.toHaveBeenCalled();
  });

  test('once settled up, keeps their expenses and settlements as they are', async () => {
    // Alice owes the owner $5.00 and Bob owes Alice $5.00: her balance is zero,
    // but moving her shares onto payers would still shift Bob's debt elsewhere.
    setUp([
      expense('owner', 1000, [
        { userId: 'owner', amount: 500 },
        { userId: 'p1', amount: 500 },
      ]),
      expense('p1', 1000, [
        { userId: 'p1', amount: 500 },
        { userId: 'bob', amount: 500 },
      ]),
    ]);
    const api = await caller();
    await expect(api.removeMember({ groupId: 'g1', userId: 'p1' })).resolves.toEqual({ success: true });
    expectNoMoneyRewritten();
    expect(mockDb.activityLog.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.user.delete).not.toHaveBeenCalled();
    expect(mockDb.groupMember.delete).toHaveBeenCalledWith({ where: { id: 'gm-p1' } });
    // Item assignments on receipts not yet turned into an expense go with the membership.
    expect(mockDb.receiptItemAssignment.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'p1', receiptItem: { receipt: { groupId: 'g1', expense: { is: null } } } },
    });
    expect(mockDb.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'MEMBER_LEFT' }) }),
    );
  });

  test('deletes a placeholder who was never part of an expense or settlement', async () => {
    setUp([
      expense('owner', 1000, [
        { userId: 'owner', amount: 500 },
        { userId: 'bob', amount: 500 },
      ]),
    ]);
    const api = await caller();
    await expect(api.removeMember({ groupId: 'g1', userId: 'p1' })).resolves.toEqual({ success: true });
    expectNoMoneyRewritten();
    expect(mockDb.activityLog.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.deleteMany).toHaveBeenCalledWith({ where: { userId: 'p1' } });
    expect(mockDb.user.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });
});
