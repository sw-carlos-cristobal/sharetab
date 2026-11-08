import { describe, test, expect, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { loadGroupBalances } from './group-balances';

// #327: a deleted expense or payment keeps its row so it can be restored, so the
// balances every check reads (the group page, archive, delete, leave, removal and the
// removed-member payment rule) have to leave it out.
describe('loadGroupBalances', () => {
  test('leaves out deleted expenses and payments', async () => {
    const tx = {
      expense: { findMany: vi.fn().mockResolvedValue([]) },
      settlement: { findMany: vi.fn().mockResolvedValue([]) },
    };

    await loadGroupBalances(tx as unknown as Prisma.TransactionClient, 'g1');

    expect(tx.expense.findMany.mock.calls[0]![0].where).toEqual({ groupId: 'g1', deletedAt: null });
    expect(tx.settlement.findMany.mock.calls[0]![0].where).toEqual({ groupId: 'g1', deletedAt: null });
  });
});
