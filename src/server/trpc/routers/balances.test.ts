import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn() },
  group: { findMany: vi.fn() },
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function caller() {
  const { balancesRouter } = await import('./balances');
  const ctx = { session: { user: { id: 'me' } }, db: mockDb, headers: new Headers(), impersonating: null };
  return balancesRouter.createCaller(ctx as unknown as Parameters<typeof balancesRouter.createCaller>[0]);
}

// An archived group where Bob still owes me $5.00 (groups archived before
// archiving required a zero balance can still be in this state).
const archivedGroup = {
  id: 'g1',
  name: 'Old trip',
  currency: 'USD',
  archivedAt: new Date('2026-10-01'),
  expenses: [
    {
      paidById: 'me',
      amount: 1000,
      baseCurrencyAmount: null,
      shares: [
        { userId: 'me', amount: 500 },
        { userId: 'bob', amount: 500 },
      ],
    },
  ],
  settlements: [],
  members: [
    { user: { id: 'me', name: 'Me', venmoUsername: null } },
    { user: { id: 'bob', name: 'Bob', venmoUsername: null } },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  // Stand-in for the database: return only the groups the query's filter lets through.
  mockDb.group.findMany.mockImplementation(async (args: { where: { archivedAt?: unknown } }) =>
    args.where.archivedAt === null ? [] : [archivedGroup],
  );
});

// #275: the dashboard skipped archived groups, so it said "All settled up!"
// while a debt sat in an archived group.
describe('dashboard balances include archived groups', () => {
  test('getOverallDebts lists a debt from an archived group', async () => {
    const api = await caller();
    const { owedToYou } = await api.getOverallDebts();
    expect(owedToYou).toEqual([{ userId: 'bob', userName: 'Bob', venmoUsername: null, amount: 500 }]);
  });

  test('getDashboard counts an archived group in the totals', async () => {
    const api = await caller();
    const { totalOwed, perGroup } = await api.getDashboard();
    expect(totalOwed).toBe(500);
    expect(perGroup).toEqual([{ groupId: 'g1', groupName: 'Old trip', currency: 'USD', balance: 500 }]);
  });
});
