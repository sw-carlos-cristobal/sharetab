import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));
vi.mock('@/server/lib/receipt-processor', () => ({ processReceiptImage: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn() },
  receiptItem: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function caller() {
  const { receiptsRouter } = await import('./receipts');
  const ctx = { session: { user: { id: 'u1' } }, db: mockDb, headers: new Headers(), impersonating: null };
  return receiptsRouter.createCaller(ctx as unknown as Parameters<typeof receiptsRouter.createCaller>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
});

describe('AI provider setup (#280)', () => {
  test('no receipts procedure exposes the AI provider setup', async () => {
    const { receiptsRouter } = await import('./receipts');
    const names = Object.keys(receiptsRouter._def.procedures).filter((name) => /provider/i.test(name));
    expect(names, 'the AI provider setup is admin-only, in admin.getSystemHealth').toEqual([]);
  });
});

describe('receipt item names are trimmed', () => {
  test('addItem refuses a name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.addItem({ receiptId: 'r1', name: '   ', unitPrice: 100, totalPrice: 100 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.receiptItem.create).not.toHaveBeenCalled();
  });

  test('updateItem refuses a name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.updateItem({ itemId: 'i1', name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.receiptItem.findUnique).not.toHaveBeenCalled();
  });
});
