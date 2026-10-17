import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn() },
  group: { findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn() },
  settlement: { findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(),
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
