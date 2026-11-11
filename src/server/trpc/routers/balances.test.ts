import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn() },
  group: { findMany: vi.fn(), findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn() },
  expense: { findMany: vi.fn() },
  settlement: { findMany: vi.fn() },
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

// Bob owes me $5.00 in an archived group (an archived group can still hold a
// balance: archived earlier, or a write racing the archive), and Carol owes me
// $3.00 in an active one.
const group = (
  id: string,
  name: string,
  archivedAt: Date | null,
  debtor: { id: string; name: string },
  amount: number,
) => ({
  id,
  name,
  emoji: '💰',
  currency: 'USD',
  archivedAt,
  expenses: [
    {
      paidById: 'me',
      amount: amount * 2,
      baseCurrencyAmount: null,
      shares: [
        { userId: 'me', amount },
        { userId: debtor.id, amount },
      ],
    },
  ],
  settlements: [],
  members: [
    { user: { id: 'me', name: 'Me', venmoUsername: null } },
    { user: { id: debtor.id, name: debtor.name, venmoUsername: null } },
  ],
});
const archivedGroup = group('g1', 'Old trip', new Date('2026-10-01'), { id: 'bob', name: 'Bob' }, 500);
const activeGroup = group('g2', 'Flat', null, { id: 'carol', name: 'Carol' }, 300);

beforeEach(() => {
  vi.resetAllMocks();
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  // Stand-in for the database: return only the groups the query's archivedAt filter lets through.
  mockDb.group.findMany.mockImplementation(async (args: { where: { archivedAt?: unknown } }) => {
    const filter = args.where.archivedAt;
    return [activeGroup, archivedGroup].filter((g) =>
      filter === undefined ? true : filter === null ? g.archivedAt === null : g.archivedAt !== null,
    );
  });
});

// #275: the dashboard skipped archived groups, so it said "All settled up!"
// while a debt sat in an archived group.
describe('dashboard balances include archived groups', () => {
  test('getOverallDebts lists debts from active and archived groups', async () => {
    const api = await caller();
    const { owedToYou } = await api.getOverallDebts();
    expect(owedToYou).toEqual([
      { userId: 'bob', userName: 'Bob', venmoUsername: null, amount: 500 },
      { userId: 'carol', userName: 'Carol', venmoUsername: null, amount: 300 },
    ]);
  });

  test('getDashboard counts active and archived groups in the totals', async () => {
    const api = await caller();
    const { totalOwed, perGroup } = await api.getDashboard();
    expect(totalOwed).toBe(800);
    // Flagged so the dashboard can show the archived one, which its group list leaves out
    expect(perGroup).toEqual([
      { groupId: 'g2', groupName: 'Flat', emoji: '💰', currency: 'USD', balance: 300, archived: false },
      { groupId: 'g1', groupName: 'Old trip', emoji: '💰', currency: 'USD', balance: 500, archived: true },
    ]);
  });
});

// #327: the group page's balances read loadGroupBalances, which leaves deleted ones out
test.each(['getGroupBalances', 'getSimplifiedDebts'] as const)(
  '%s leaves out deleted expenses and payments',
  async (proc) => {
    mockDb.groupMember.findUnique.mockResolvedValue({ role: 'MEMBER', userId: 'me', groupId: 'g1' });
    mockDb.expense.findMany.mockResolvedValue([]);
    mockDb.settlement.findMany.mockResolvedValue([]);
    const api = await caller();
    await api[proc]({ groupId: 'g1' });
    expect(mockDb.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: 'g1', deletedAt: null } }),
    );
    expect(mockDb.settlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: 'g1', deletedAt: null } }),
    );
  },
);

// #327: a deleted expense or payment keeps its row, so the dashboard has to leave it out
test.each(['getOverallDebts', 'getDashboard'] as const)('%s leaves out deleted expenses and payments', async (proc) => {
  mockDb.group.findMany.mockResolvedValue([]);
  const api = await caller();
  await api[proc]();
  const { select } = mockDb.group.findMany.mock.calls.at(-1)![0];
  expect(select.expenses.where).toEqual({ deletedAt: null });
  expect(select.settlements.where).toEqual({ deletedAt: null });
});

// Codex on #322: a removed placeholder's membership row (#284) isn't membership
test.each(['getOverallDebts', 'getDashboard'] as const)(
  "%s leaves out a group the caller's membership was removed from",
  async (proc) => {
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
    mockDb.group.findMany.mockResolvedValue([]);
    const api = await caller();
    await api[proc]();
    expect(mockDb.group.findMany.mock.calls.at(-1)![0].where).toEqual({
      members: { some: { userId: 'me', removedAt: null } },
    });
  },
);
