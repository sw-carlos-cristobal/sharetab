import { describe, test, expect, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { loadGroupBalances } from './group-balances';

// #327: a deleted expense or payment keeps its row so it can be restored, so the
// balances every check reads (the group page, archive, delete, leave, removal, the
// removed-member payment rule and the expense restore's former-member check) have to
// leave it out.
describe('loadGroupBalances', () => {
  test('leaves out deleted expenses and payments', async () => {
    const tx = {
      group: { findUnique: vi.fn().mockResolvedValue({ currency: 'USD' }) },
      expense: { findMany: vi.fn().mockResolvedValue([]) },
      settlement: { findMany: vi.fn().mockResolvedValue([]) },
    };

    await loadGroupBalances(tx as unknown as Prisma.TransactionClient, 'g1');

    expect(tx.expense.findMany.mock.calls[0]![0].where).toEqual({ groupId: 'g1', deletedAt: null });
    expect(tx.settlement.findMany.mock.calls[0]![0].where).toEqual({ groupId: 'g1', deletedAt: null });
  });
});

// #335: a converted expense's shares in a group whose currency has no decimals are whole units
test("loadGroupBalances shares a converted expense in whole units of the group's currency", async () => {
  const tx = {
    group: { findUnique: vi.fn().mockResolvedValue({ currency: 'JPY' }) },
    expense: {
      findMany: vi.fn().mockResolvedValue([
        // $10.00 converted to ¥1,503
        {
          paidById: 'a',
          amount: 1000,
          baseCurrencyAmount: 150300,
          shares: [
            { userId: 'a', amount: 334 },
            { userId: 'b', amount: 333 },
            { userId: 'c', amount: 333 },
          ],
        },
      ]),
    },
    settlement: { findMany: vi.fn().mockResolvedValue([]) },
  };

  const balances = await loadGroupBalances(tx as unknown as Prisma.TransactionClient, 'g1');

  expect(tx.group.findUnique).toHaveBeenCalledWith({ where: { id: 'g1' }, select: { currency: true } });
  expect(Object.fromEntries(balances.map((b) => [b.userId, b.owes]))).toEqual({ a: 50200, b: 50100, c: 50000 });
});
