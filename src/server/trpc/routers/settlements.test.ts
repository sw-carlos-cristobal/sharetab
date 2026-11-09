import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn() },
  group: { findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  expense: { findMany: vi.fn() },
  settlement: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function caller(userId: string) {
  const { settlementsRouter } = await import('./settlements');
  const ctx = { session: { user: { id: userId } }, db: mockDb, headers: new Headers(), impersonating: null };
  return settlementsRouter.createCaller(ctx as unknown as Parameters<typeof settlementsRouter.createCaller>[0]);
}

function asRole(role: 'OWNER' | 'ADMIN' | 'MEMBER', userId: string) {
  mockDb.groupMember.findUnique.mockResolvedValue({ role, userId, groupId: 'g1' });
}

const payment = { id: 's1', groupId: 'g1', fromId: 'bob', toId: 'alice', amount: 50000, currency: 'USD' };

beforeEach(() => {
  vi.resetAllMocks();
  // protectedProcedure looks the caller up; groupMemberProcedure checks membership.
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  mockDb.group.findUnique.mockResolvedValue({ archivedAt: null });
  // The transaction's lock on the group row (#289) finds it active unless a test says otherwise
  mockDb.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
  mockDb.settlement.findUnique.mockResolvedValue(payment);
  mockDb.settlement.updateMany.mockResolvedValue({ count: 1 });
  // Nobody in a payment was removed from the group unless a test says so (#284)
  mockDb.groupMember.findMany.mockResolvedValue([]);
  mockDb.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? arg(mockDb) : Promise.all(arg as Promise<unknown>[]),
  );
});

describe('settlements.list', () => {
  test("includes each person's email, so a member who never set a name isn't shown as Unknown", async () => {
    asRole('MEMBER', 'bob');
    mockDb.settlement.findMany.mockResolvedValue([]);
    const api = await caller('bob');

    await api.list({ groupId: 'g1' });

    const { include } = mockDb.settlement.findMany.mock.calls[0]![0];
    expect(include.from.select).toMatchObject({ name: true, email: true });
    expect(include.to.select).toMatchObject({ name: true, email: true });
  });

  // #327: a deleted payment keeps its row so it can be restored
  test('leaves out deleted payments', async () => {
    asRole('MEMBER', 'bob');
    mockDb.settlement.findMany.mockResolvedValue([]);
    const api = await caller('bob');

    await api.list({ groupId: 'g1' });

    expect(mockDb.settlement.findMany.mock.calls[0]![0].where).toEqual({ groupId: 'g1', deletedAt: null });
  });
});

// #261: a mistaken payment could not be removed, so it skewed balances for good
describe('settlements.delete', () => {
  test('the payer can delete their payment, and the deletion is logged', async () => {
    asRole('MEMBER', 'bob');
    const api = await caller('bob');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).resolves.toEqual({ success: true });

    // Marked deleted rather than removed, so it can be restored (#327)
    expect(mockDb.settlement.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', groupId: 'g1', deletedAt: null },
      data: { deletedAt: expect.any(Date), deletedById: 'bob' },
    });
    expect(mockDb.activityLog.create).toHaveBeenCalledWith({
      data: {
        groupId: 'g1',
        userId: 'bob',
        type: 'SETTLEMENT_DELETED',
        entityId: 's1',
        metadata: { fromId: 'bob', toId: 'alice', amount: 50000, currency: 'USD' },
      },
    });
  });

  test.each(['OWNER', 'ADMIN'] as const)('a group %s can delete someone else’s payment', async (role) => {
    asRole(role, 'carol');
    const api = await caller('carol');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).resolves.toEqual({ success: true });
    expect(mockDb.settlement.updateMany).toHaveBeenCalled();
  });

  test('a member who did not pay cannot delete the payment, even as its recipient', async () => {
    asRole('MEMBER', 'alice');
    const api = await caller('alice');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.settlement.updateMany).not.toHaveBeenCalled();
    expect(mockDb.activityLog.create).not.toHaveBeenCalled();
  });

  test('an archived group refuses the deletion', async () => {
    asRole('OWNER', 'carol');
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: new Date() });
    const api = await caller('carol');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.settlement.updateMany).not.toHaveBeenCalled();
  });

  test('a payment from another group is not found', async () => {
    asRole('OWNER', 'carol');
    mockDb.settlement.findUnique.mockResolvedValue({ ...payment, groupId: 'other' });
    const api = await caller('carol');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.settlement.updateMany).not.toHaveBeenCalled();
  });

  test('a missing payment is not found', async () => {
    asRole('OWNER', 'carol');
    mockDb.settlement.findUnique.mockResolvedValue(null);
    const api = await caller('carol');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('a payment deleted by someone else in the meantime is not found and logs nothing', async () => {
    asRole('MEMBER', 'bob');
    mockDb.settlement.updateMany.mockResolvedValue({ count: 0 });
    const api = await caller('bob');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.activityLog.create).not.toHaveBeenCalled();
  });
});

// #289: the archived check ran in its own statement before the write, so an
// archive that landed in between let the payment through, and the group could
// end up archived with a balance nobody can settle.
describe('a group archived while a payment was on its way (#289)', () => {
  const rawSql = () => mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));

  beforeEach(() => {
    // The early check still sees the group active, but by the time the
    // transaction locks its row, it's archived
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'USD' });
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: new Date() }]);
    mockDb.groupMember.count.mockResolvedValue(2);
  });

  test('create refuses, recording nothing', async () => {
    asRole('MEMBER', 'bob');
    const api = await caller('bob');
    await expect(api.create({ groupId: 'g1', toId: 'alice', amount: 500 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot create settlements in an archived group',
    });
    expect(mockDb.settlement.create).not.toHaveBeenCalled();
    expect(mockDb.activityLog.create).not.toHaveBeenCalled();
  });

  test('delete refuses, deleting nothing', async () => {
    asRole('MEMBER', 'bob');
    const api = await caller('bob');
    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot delete payments from an archived group',
    });
    expect(mockDb.settlement.updateMany).not.toHaveBeenCalled();
  });

  test('an active group is locked FOR SHARE inside the transaction, before the write', async () => {
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
    mockDb.settlement.create.mockResolvedValue({ id: 's2' });
    asRole('MEMBER', 'bob');
    const api = await caller('bob');
    await api.create({ groupId: 'g1', toId: 'alice', amount: 500 });

    expect(rawSql()).toEqual([expect.stringMatching(/FROM "Group" WHERE "id" = \? FOR SHARE/)]);
    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(locked).toBeGreaterThan(mockDb.$transaction.mock.invocationCallOrder[0]!);
    expect(locked).toBeLessThan(mockDb.settlement.create.mock.invocationCallOrder[0]!);
  });

  // Codex on #308: see the expenses test of the same name
  test('create checks the payer and recipient are members inside the transaction, after the lock', async () => {
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
    mockDb.settlement.create.mockResolvedValue({ id: 's2' });
    asRole('MEMBER', 'bob');
    const api = await caller('bob');
    await api.create({ groupId: 'g1', toId: 'alice', amount: 500 });

    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(mockDb.groupMember.count.mock.invocationCallOrder[0]).toBeGreaterThan(locked!);
    expect(mockDb.groupMember.count.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.settlement.create.mock.invocationCallOrder[0]!,
    );
  });
});

// #284: a placeholder removed from the group at a zero balance can still be settled
// with when an old expense changes their balance, but a payment can't make them a
// new debt: they're no longer in the group to take part in anything else.
describe('a payment with someone removed from the group', () => {
  // Hal (removed) paid $10.00 split with Alice, so Alice owes Hal $5.00
  const aliceOwesHal = [
    {
      paidById: 'hal',
      amount: 1000,
      baseCurrencyAmount: null,
      shares: [
        { userId: 'alice', amount: 500 },
        { userId: 'hal', amount: 500 },
      ],
    },
  ];

  beforeEach(() => {
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'USD' });
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: null }]);
    mockDb.groupMember.count.mockResolvedValue(2);
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'hal' }]);
    mockDb.expense.findMany.mockResolvedValue(aliceOwesHal);
    mockDb.settlement.findMany.mockResolvedValue([]);
    mockDb.settlement.create.mockResolvedValue({ id: 's2' });
  });

  test('can settle what they are owed', async () => {
    asRole('MEMBER', 'alice');
    const api = await caller('alice');
    await api.create({ groupId: 'g1', toId: 'hal', amount: 500 });
    expect(mockDb.settlement.create).toHaveBeenCalled();
  });

  test('can settle what they owe', async () => {
    mockDb.expense.findMany.mockResolvedValue([
      { ...aliceOwesHal[0], paidById: 'alice' }, // Alice paid, so Hal owes Alice $5.00
    ]);
    asRole('OWNER', 'alice');
    const api = await caller('alice');
    await api.create({ groupId: 'g1', fromId: 'hal', toId: 'alice', amount: 500 });
    expect(mockDb.settlement.create).toHaveBeenCalled();
  });

  test.each([
    ['paying them more than they are owed', { toId: 'hal', amount: 501 }],
    ['a payment from them while they are owed money', { fromId: 'hal', toId: 'alice', amount: 100 }],
  ])('refuses %s', async (_, payment) => {
    asRole('OWNER', 'alice');
    const api = await caller('alice');
    await expect(api.create({ groupId: 'g1', ...payment })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'A payment with someone removed from this group can only settle what they still owe or are owed.',
    });
    expect(mockDb.settlement.create).not.toHaveBeenCalled();
  });

  test('reads their balance inside the transaction, after the lock', async () => {
    asRole('MEMBER', 'alice');
    const api = await caller('alice');
    await api.create({ groupId: 'g1', toId: 'hal', amount: 500 });
    const [locked] = mockDb.$queryRaw.mock.invocationCallOrder;
    expect(mockDb.expense.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(locked!);
  });

  test("doesn't read balances when nobody in the payment was removed", async () => {
    mockDb.groupMember.findMany.mockResolvedValue([]);
    asRole('MEMBER', 'alice');
    const api = await caller('alice');
    await api.create({ groupId: 'g1', toId: 'bob', amount: 99999 });
    expect(mockDb.expense.findMany).not.toHaveBeenCalled();
    expect(mockDb.settlement.create).toHaveBeenCalled();
  });
});

// #327: a deleted payment keeps its row, so whoever could delete it can restore it
describe('restoring a payment', () => {
  const rawSql = () => mockDb.$queryRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));
  const deletedAt = new Date('2026-11-01T12:00:00Z');
  const deleted = { ...payment, deletedAt, baseCurrencyAmount: null };
  let lockedRow: { fromId: string; toId: string; deletedAt: Date | null };

  beforeEach(() => {
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: null, currency: 'USD' });
    mockDb.settlement.findUnique.mockResolvedValue(deleted);
    lockedRow = { fromId: 'bob', toId: 'alice', deletedAt };
    mockDb.$queryRaw.mockImplementation(async (strings: string[]) =>
      strings.join('?').includes('FROM "Settlement"') ? [lockedRow] : [{ archivedAt: null }],
    );
    mockDb.groupMember.count.mockResolvedValue(2);
    mockDb.settlement.update.mockResolvedValue({ id: 's1' });
  });

  test('the payer restores it, and the restore is logged', async () => {
    asRole('MEMBER', 'bob');
    const api = await caller('bob');

    await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).resolves.toEqual({ success: true });

    expect(mockDb.settlement.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { deletedAt: null, deletedById: null },
    });
    expect(mockDb.activityLog.create).toHaveBeenCalledWith({
      data: {
        groupId: 'g1',
        userId: 'bob',
        type: 'SETTLEMENT_RESTORED',
        entityId: 's1',
        metadata: { fromId: 'bob', toId: 'alice', amount: 50000, currency: 'USD' },
      },
    });
  });

  test('locks the group, then the payment, then checks who is in it', async () => {
    asRole('MEMBER', 'bob');
    const api = await caller('bob');
    await api.restore({ groupId: 'g1', settlementId: 's1' });

    expect(rawSql()).toEqual([
      expect.stringMatching(/FROM "Group" WHERE "id" = \? FOR SHARE/),
      expect.stringMatching(/FROM "Settlement" WHERE "id" = \? FOR NO KEY UPDATE/),
    ]);
    expect(mockDb.groupMember.count.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockDb.$queryRaw.mock.invocationCallOrder[1]!,
    );
  });

  test.each(['OWNER', 'ADMIN'] as const)('a group %s can restore someone else’s payment', async (role) => {
    asRole(role, 'carol');
    const api = await caller('carol');
    await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).resolves.toEqual({ success: true });
  });

  test('a member who did not pay cannot restore it, even as its recipient', async () => {
    asRole('MEMBER', 'alice');
    const api = await caller('alice');
    await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only the payer or a group owner/admin can restore this payment',
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test('refuses a payment that is not deleted', async () => {
    asRole('MEMBER', 'bob');
    mockDb.settlement.findUnique.mockResolvedValue(payment);
    const api = await caller('bob');
    await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: "This payment isn't deleted.",
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test('refuses one restored meanwhile', async () => {
    asRole('MEMBER', 'bob');
    lockedRow = { fromId: 'bob', toId: 'alice', deletedAt: null };
    const api = await caller('bob');
    await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({
      message: "This payment isn't deleted.",
    });
    expect(mockDb.settlement.update).not.toHaveBeenCalled();
  });

  test('refuses in an archived group, checked again under the lock', async () => {
    asRole('MEMBER', 'bob');
    mockDb.$queryRaw.mockResolvedValue([{ archivedAt: new Date() }]);
    const api = await caller('bob');
    await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot restore payments in an archived group',
    });
    expect(mockDb.settlement.update).not.toHaveBeenCalled();
  });

  test('a payment from another group is not found', async () => {
    asRole('OWNER', 'carol');
    mockDb.settlement.findUnique.mockResolvedValue({ ...deleted, groupId: 'other' });
    const api = await caller('carol');
    await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('a missing payment is not found', async () => {
    asRole('OWNER', 'carol');
    mockDb.settlement.findUnique.mockResolvedValue(null);
    const api = await caller('carol');
    await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  // A merge deletes a payment between the placeholder and the member it's merged into
  test('one gone by the time its row is locked is not found, restoring and logging nothing', async () => {
    asRole('MEMBER', 'bob');
    mockDb.$queryRaw.mockImplementation(async (strings: string[]) =>
      strings.join('?').includes('FROM "Settlement"') ? [] : [{ archivedAt: null }],
    );
    const api = await caller('bob');
    await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.settlement.update).not.toHaveBeenCalled();
    expect(mockDb.activityLog.create).not.toHaveBeenCalled();
  });

  test("doesn't read balances when nobody in the payment was removed", async () => {
    asRole('MEMBER', 'bob');
    const api = await caller('bob');
    await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).resolves.toEqual({ success: true });
    expect(mockDb.expense.findMany).not.toHaveBeenCalled();
  });

  test('both people must still have a place in the group', async () => {
    asRole('MEMBER', 'bob');
    mockDb.groupMember.count.mockResolvedValue(1);
    const api = await caller('bob');
    await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({
      message: 'Both the payer and recipient must be members of this group',
    });
    expect(mockDb.settlement.update).not.toHaveBeenCalled();
  });

  // The rule a new payment follows: with someone removed it may only settle their balance,
  // which leaves this payment out while it's deleted
  describe('with someone removed from the group', () => {
    // Bob (removed) paid $1,000.00 split with Alice, so Alice owes Bob $500.00. A $500.00
    // payment from Alice to Bob settles it; one from Bob to Alice would grow what Alice owes him.
    beforeEach(() => {
      mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'bob' }]);
      mockDb.expense.findMany.mockResolvedValue([
        {
          paidById: 'bob',
          amount: 100000,
          baseCurrencyAmount: null,
          shares: [
            { userId: 'alice', amount: 50000 },
            { userId: 'bob', amount: 50000 },
          ],
        },
      ]);
      mockDb.settlement.findMany.mockResolvedValue([]);
      asRole('OWNER', 'carol');
    });

    test('restores one that settles their balance', async () => {
      mockDb.settlement.findUnique.mockResolvedValue({ ...deleted, fromId: 'alice', toId: 'bob' });
      lockedRow = { fromId: 'alice', toId: 'bob', deletedAt };
      const api = await caller('carol');
      await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).resolves.toEqual({ success: true });
    });

    test('refuses one that would grow their balance', async () => {
      const api = await caller('carol');
      await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({
        message: 'A payment with someone removed from this group can only settle what they still owe or are owed.',
      });
      expect(mockDb.settlement.update).not.toHaveBeenCalled();
    });

    // Balances are in the group's currency: €400.00 that came to $600.00 is more than the
    // $500.00 Alice owes Bob, though 40000 is less than 50000
    test("checks a payment in another currency by what it came to in the group's", async () => {
      mockDb.settlement.findUnique.mockResolvedValue({
        ...deleted,
        fromId: 'alice',
        toId: 'bob',
        amount: 40000,
        currency: 'EUR',
        baseCurrencyAmount: 60000,
      });
      lockedRow = { fromId: 'alice', toId: 'bob', deletedAt };
      const api = await caller('carol');
      await expect(api.restore({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({
        message: 'A payment with someone removed from this group can only settle what they still owe or are owed.',
      });
    });
  });

  // A merge can move a deleted payment from a placeholder to the member it's merged into,
  // so its people are the ones read under the lock
  test('checks and logs the people the payment has now', async () => {
    asRole('OWNER', 'carol');
    lockedRow = { fromId: 'dave', toId: 'alice', deletedAt };
    const api = await caller('carol');
    await api.restore({ groupId: 'g1', settlementId: 's1' });
    expect(mockDb.groupMember.count).toHaveBeenCalledWith({
      where: { groupId: 'g1', userId: { in: ['dave', 'alice'] } },
    });
    expect(mockDb.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'SETTLEMENT_RESTORED',
        metadata: { fromId: 'dave', toId: 'alice', amount: 50000, currency: 'USD' },
      }),
    });
  });
});

describe('deleting a payment already deleted', () => {
  test('is not found', async () => {
    asRole('MEMBER', 'bob');
    mockDb.settlement.findUnique.mockResolvedValue({ ...payment, deletedAt: new Date() });
    const api = await caller('bob');
    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.settlement.updateMany).not.toHaveBeenCalled();
  });
});

test('settlements.list with deleted lists only the deleted payments, for the Deleted section', async () => {
  asRole('MEMBER', 'bob');
  mockDb.settlement.findMany.mockResolvedValue([]);
  const api = await caller('bob');
  await api.list({ groupId: 'g1', deleted: true });
  expect(mockDb.settlement.findMany.mock.calls[0]![0].where).toEqual({ groupId: 'g1', deletedAt: { not: null } });
});
