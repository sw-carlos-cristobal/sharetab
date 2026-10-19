import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn() },
  group: { findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn(), count: vi.fn() },
  settlement: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
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
  mockDb.settlement.deleteMany.mockResolvedValue({ count: 1 });
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
});

// #261: a mistaken payment could not be removed, so it skewed balances for good
describe('settlements.delete', () => {
  test('the payer can delete their payment, and the deletion is logged', async () => {
    asRole('MEMBER', 'bob');
    const api = await caller('bob');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).resolves.toEqual({ success: true });

    expect(mockDb.settlement.deleteMany).toHaveBeenCalledWith({ where: { id: 's1', groupId: 'g1' } });
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
    expect(mockDb.settlement.deleteMany).toHaveBeenCalled();
  });

  test('a member who did not pay cannot delete the payment, even as its recipient', async () => {
    asRole('MEMBER', 'alice');
    const api = await caller('alice');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.settlement.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.activityLog.create).not.toHaveBeenCalled();
  });

  test('an archived group refuses the deletion', async () => {
    asRole('OWNER', 'carol');
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: new Date() });
    const api = await caller('carol');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.settlement.deleteMany).not.toHaveBeenCalled();
  });

  test('a payment from another group is not found', async () => {
    asRole('OWNER', 'carol');
    mockDb.settlement.findUnique.mockResolvedValue({ ...payment, groupId: 'other' });
    const api = await caller('carol');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.settlement.deleteMany).not.toHaveBeenCalled();
  });

  test('a missing payment is not found', async () => {
    asRole('OWNER', 'carol');
    mockDb.settlement.findUnique.mockResolvedValue(null);
    const api = await caller('carol');

    await expect(api.delete({ groupId: 'g1', settlementId: 's1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('a payment deleted by someone else in the meantime is not found and logs nothing', async () => {
    asRole('MEMBER', 'bob');
    mockDb.settlement.deleteMany.mockResolvedValue({ count: 0 });
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
    expect(mockDb.settlement.deleteMany).not.toHaveBeenCalled();
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
