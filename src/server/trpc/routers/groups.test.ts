import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  group: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
  groupInvite: { findUnique: vi.fn(), create: vi.fn() },
  activityLog: { create: vi.fn(), deleteMany: vi.fn() },
  expense: { count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  expenseShare: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  settlement: { count: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  receiptItemAssignment: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function caller(userId = 'owner') {
  const { groupsRouter } = await import('./groups');
  const ctx = { session: { user: { id: userId } }, db: mockDb, headers: new Headers(), impersonating: null };
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

describe('invites', () => {
  const inAWeek = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const validInvite = () => ({
    usedAt: null,
    expiresAt: inAWeek(),
    group: { name: 'Ski Trip', _count: { members: 4 } },
    createdBy: { name: 'Alice', isPlaceholder: false, suspendedAt: null },
  });

  test('createInvite records who made the invite', async () => {
    mockDb.groupInvite.create.mockResolvedValue({ token: 't1' });
    const api = await caller();
    await api.createInvite({ groupId: 'g1' });
    expect(mockDb.groupInvite.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdById: 'owner' }) }),
    );
  });

  test('getInvite returns the group name, inviter and member count', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue(validInvite());
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toEqual({
      groupName: 'Ski Trip',
      inviterName: 'Alice',
      memberCount: 4,
    });
    expect(mockDb.groupInvite.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { token: 't1' } }));
  });

  test('getInvite returns null for a token that matches no invite', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue(null);
    const api = await caller();
    await expect(api.getInvite({ token: 'nope' })).resolves.toBeNull();
  });

  test('getInvite returns null for an invite that was already used', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({ ...validInvite(), usedAt: new Date() });
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toBeNull();
  });

  test('getInvite returns null for an expired invite', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({ ...validInvite(), expiresAt: new Date(Date.now() - 1000) });
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toBeNull();
  });

  test('getInvite has no inviter for an invite made before inviters were recorded', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({ ...validInvite(), createdBy: null });
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toMatchObject({ groupName: 'Ski Trip', inviterName: null });
  });

  test('getInvite has no inviter once the inviter is a placeholder (a deleted account)', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({
      ...validInvite(),
      // admin.deleteUser also suspends the account; leave that out to pin the placeholder check on its own
      createdBy: { name: 'Deleted user', isPlaceholder: true, suspendedAt: null },
    });
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toMatchObject({ inviterName: null });
  });

  test('getInvite has no inviter while the inviter is suspended', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({
      ...validInvite(),
      createdBy: { name: 'Mallory', isPlaceholder: false, suspendedAt: new Date() },
    });
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toMatchObject({ inviterName: null });
  });

  test('getInvite and joinByInvite refuse a token longer than 64 characters without a lookup', async () => {
    const api = await caller();
    const token = 'x'.repeat(65);
    await expect(api.getInvite({ token })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.joinByInvite({ token })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.groupInvite.findUnique).not.toHaveBeenCalled();
  });

  test('getInvite allows 30 lookups a minute per user, then refuses without a lookup', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue(null);
    const api = await caller('prober');
    for (let i = 0; i < 30; i++) await api.getInvite({ token: `guess-${i}` });
    await expect(api.getInvite({ token: 'guess-30' })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mockDb.groupInvite.findUnique).toHaveBeenCalledTimes(30);
    // Another user's budget is separate
    await expect((await caller('someone-else')).getInvite({ token: 'guess-0' })).resolves.toBeNull();
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

// #275: archiving hid a group's open balances from the dashboard, and an
// archived group refuses settlements, so the debt was frozen out of sight.
describe('archiving a group', () => {
  const expense = (paidById: string, shares: { userId: string; amount: number }[]) => ({
    paidById,
    amount: shares.reduce((sum, s) => sum + s.amount, 0),
    baseCurrencyAmount: null,
    shares,
  });
  // The owner paid $10.00 split with Bob, so Bob owes the owner $5.00.
  const bobOwesHalf = [
    expense('owner', [
      { userId: 'owner', amount: 500 },
      { userId: 'bob', amount: 500 },
    ]),
  ];

  beforeEach(() => {
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'owner' }, { userId: 'bob' }]);
    mockDb.group.update.mockResolvedValue({ id: 'g1', name: 'Trip', archivedAt: new Date() });
  });

  test('is refused while anyone in the group owes money', async () => {
    mockDb.expense.findMany.mockResolvedValue(bobOwesHalf);
    mockDb.settlement.findMany.mockResolvedValue([]);
    const api = await caller();
    await expect(api.archive({ groupId: 'g1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'This group still has unsettled balances. Settle up before archiving it.',
    });
    expect(mockDb.expense.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { groupId: 'g1' } }));
    expect(mockDb.settlement.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { groupId: 'g1' } }));
    expect(mockDb.group.update).not.toHaveBeenCalled();
  });

  // Settlements need both people to be members, so "settle up" alone can't
  // clear a balance with someone who has left.
  test('says so when the open balance belongs to someone no longer in the group', async () => {
    mockDb.expense.findMany.mockResolvedValue(bobOwesHalf);
    mockDb.settlement.findMany.mockResolvedValue([]);
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'owner' }]);
    const api = await caller();
    await expect(api.archive({ groupId: 'g1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message:
        "Someone who is no longer in this group still owes or is owed money, so it can't be archived. Invite them back to settle up, or edit the expenses they're in.",
    });
    expect(mockDb.group.update).not.toHaveBeenCalled();
  });

  test('goes ahead once everyone is settled up', async () => {
    mockDb.expense.findMany.mockResolvedValue(bobOwesHalf);
    // Bob paid the owner back.
    mockDb.settlement.findMany.mockResolvedValue([
      { fromId: 'bob', toId: 'owner', amount: 500, baseCurrencyAmount: null },
    ]);
    const api = await caller();
    await api.archive({ groupId: 'g1' });
    expect(mockDb.group.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'g1' }, data: { archivedAt: expect.any(Date) } }),
    );
  });
});
