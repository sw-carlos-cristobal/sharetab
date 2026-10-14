import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn() },
  expense: { findUnique: vi.fn() },
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
