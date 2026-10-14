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
  expense: { count: vi.fn(), updateMany: vi.fn() },
  expenseShare: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  settlement: { count: vi.fn(), deleteMany: vi.fn() },
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
  function setUp({ shares = 0, expenses = 0, settlements = 0 } = {}) {
    // The caller lookup and membership check, then the target's membership and user rows.
    mockDb.groupMember.findUnique
      .mockResolvedValueOnce({ role: 'OWNER', userId: 'owner', groupId: 'g1' })
      .mockResolvedValueOnce({ id: 'gm-p1', role: 'MEMBER', userId: 'p1', groupId: 'g1' });
    mockDb.user.findUnique
      .mockResolvedValueOnce({ suspendedAt: null })
      .mockResolvedValueOnce({ isPlaceholder: true, name: 'Alice', placeholderName: 'Alice' });
    mockDb.expenseShare.count.mockResolvedValue(shares);
    mockDb.expense.count.mockResolvedValue(expenses);
    mockDb.settlement.count.mockResolvedValue(settlements);
    // Read by the old cleanup, which looked up the shares to move
    mockDb.expenseShare.findMany.mockResolvedValue([]);
  }

  function expectNothingChanged() {
    expect(mockDb.expenseShare.update).not.toHaveBeenCalled();
    expect(mockDb.expenseShare.create).not.toHaveBeenCalled();
    expect(mockDb.expenseShare.delete).not.toHaveBeenCalled();
    expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
    expect(mockDb.settlement.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.groupMember.delete).not.toHaveBeenCalled();
    expect(mockDb.user.delete).not.toHaveBeenCalled();
  }

  // Even at a zero balance: moving their part onto others shifts who owes
  // whom, and a removed member's balance can come back with nobody able to
  // settle it.
  test.each([
    ['has a share in an expense', { shares: 1 }],
    ['paid an expense', { expenses: 1 }],
    ['is in a settlement', { settlements: 1 }],
  ])('is refused when the placeholder %s', async (_, history) => {
    setUp(history);
    const api = await caller();
    await expect(api.removeMember({ groupId: 'g1', userId: 'p1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message:
        "Alice is in expenses or payments in this group, so they can't be removed. Take them out of those first.",
    });
    expectNothingChanged();
  });

  test('deletes a placeholder who was never in an expense or payment', async () => {
    setUp();
    const api = await caller();
    await expect(api.removeMember({ groupId: 'g1', userId: 'p1' })).resolves.toEqual({ success: true });
    expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
    expect(mockDb.settlement.deleteMany).not.toHaveBeenCalled();
    // Their activity-log entries stay (the user link is cleared by the database)
    expect(mockDb.activityLog.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.deleteMany).toHaveBeenCalledWith({ where: { userId: 'p1' } });
    expect(mockDb.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'MEMBER_LEFT' }) }),
    );
    expect(mockDb.user.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });
});
