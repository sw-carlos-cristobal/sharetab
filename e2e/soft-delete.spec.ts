import { test, expect } from '@playwright/test';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { users, login, createTestGroup, trpcMutation, trpcQuery, trpcResult, trpcError } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// #327: deleting an expense or a payment removed its row, so one mis-tap lost it for the
// whole group. It's marked deleted now: gone from the lists and balances, and restorable
// exactly as it was.

type Ctx = Awaited<ReturnType<typeof createTestGroup>>['owner'];

async function ok(ctx: Ctx, proc: string, input: unknown) {
  const body = await (await trpcMutation(ctx, proc, input)).json();
  expect(body.result, JSON.stringify(body)).toBeDefined();
  return body.result.data.json;
}

async function balances(ctx: Ctx, groupId: string) {
  const { balances } = await trpcResult(await trpcQuery(ctx, 'balances.getGroupBalances', { groupId }));
  return Object.fromEntries(
    (balances as { userId: string; net: number }[]).filter((b) => b.net !== 0).map((b) => [b.userId, b.net]),
  );
}

async function expenseIds(ctx: Ctx, groupId: string, deleted = false) {
  const { expenses } = await trpcResult(await trpcQuery(ctx, 'expenses.list', { groupId, limit: 100, deleted }));
  return (expenses as { id: string }[]).map((e) => e.id);
}

async function paymentIds(ctx: Ctx, groupId: string, deleted = false) {
  const { items } = await trpcResult(await trpcQuery(ctx, 'settlements.list', { groupId, deleted }));
  return (items as { id: string }[]).map((p) => p.id);
}

test.describe('deleting and restoring (#327)', () => {
  test('an expense leaves the list and balances, and restoring brings both back exactly', async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Soft Delete Expense',
    );
    try {
      const alice = memberIds[users.alice.email]!;
      const bob = memberIds[users.bob.email]!;
      await ok(owner, 'expenses.create', {
        groupId,
        title: 'Groceries',
        amount: 3000,
        paidById: bob,
        splitMode: 'EQUAL',
        shares: [
          { userId: alice, amount: 1500 },
          { userId: bob, amount: 1500 },
        ],
      });
      const dinner = await ok(owner, 'expenses.create', {
        groupId,
        title: 'Dinner',
        amount: 1001,
        paidById: alice,
        splitMode: 'EXACT',
        shares: [
          { userId: alice, amount: 334 },
          { userId: bob, amount: 667 },
        ],
      });
      const before = await balances(owner, groupId);

      await ok(owner, 'expenses.delete', { groupId, expenseId: dinner.id });
      expect(await expenseIds(owner, groupId)).not.toContain(dinner.id);
      expect(await expenseIds(owner, groupId, true)).toEqual([dinner.id]);
      expect(await balances(owner, groupId)).toEqual({ [alice]: -1500, [bob]: 1500 });
      // Its page still opens, saying who deleted it
      const page = await trpcResult(await trpcQuery(owner, 'expenses.get', { groupId, expenseId: dinner.id }));
      expect(page.deletedAt).toBeTruthy();
      expect(page.deletedBy).toEqual({ id: alice, name: users.alice.name });
      // Deleting it again, or editing it, is refused
      expect(
        (await trpcError(await trpcMutation(owner, 'expenses.delete', { groupId, expenseId: dinner.id }))).data.code,
      ).toBe('NOT_FOUND');
      expect(
        (
          await trpcError(
            await trpcMutation(owner, 'expenses.update', { groupId, expenseId: dinner.id, title: 'Lunch' }),
          )
        ).message,
      ).toBe('This expense was deleted. Restore it before editing it.');

      await ok(owner, 'expenses.restore', { groupId, expenseId: dinner.id });
      expect(await balances(owner, groupId)).toEqual(before);
      expect(await expenseIds(owner, groupId)).toContain(dinner.id);
      expect(await expenseIds(owner, groupId, true)).toEqual([]);
      const restored = await trpcResult(await trpcQuery(owner, 'expenses.get', { groupId, expenseId: dinner.id }));
      expect(restored).toMatchObject({ deletedAt: null, deletedById: null, splitMode: 'EXACT' });
      expect(restored.shares.map((s: { amount: number }) => s.amount).sort()).toEqual([334, 667]);

      const { items } = await trpcResult(await trpcQuery(owner, 'activity.getGroupActivity', { groupId }));
      expect(items.map((a: { type: string }) => a.type).slice(0, 2)).toEqual(['EXPENSE_RESTORED', 'EXPENSE_DELETED']);
    } finally {
      await dispose();
    }
  });

  test('a payment leaves the list and balances, and restoring brings both back exactly', async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Soft Delete Payment',
    );
    try {
      const alice = memberIds[users.alice.email]!;
      const bob = memberIds[users.bob.email]!;
      const bobCtx = memberContexts[0]!;
      await ok(owner, 'expenses.create', {
        groupId,
        title: 'Taxi',
        amount: 2000,
        paidById: alice,
        splitMode: 'EQUAL',
        shares: [
          { userId: alice, amount: 1000 },
          { userId: bob, amount: 1000 },
        ],
      });
      const paid = await ok(bobCtx, 'settlements.create', { groupId, toId: alice, amount: 400 });
      const before = await balances(owner, groupId);

      await ok(bobCtx, 'settlements.delete', { groupId, settlementId: paid.id });
      expect(await paymentIds(owner, groupId)).toEqual([]);
      expect(await paymentIds(owner, groupId, true)).toEqual([paid.id]);
      expect(await balances(owner, groupId)).toEqual({ [alice]: 1000, [bob]: -1000 });

      await ok(bobCtx, 'settlements.restore', { groupId, settlementId: paid.id });
      expect(await balances(owner, groupId)).toEqual(before);
      expect(await paymentIds(owner, groupId)).toEqual([paid.id]);
    } finally {
      await dispose();
    }
  });

  test('the archive and leave checks leave deleted records out, and an archived group refuses a restore', async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Soft Delete Checks',
    );
    try {
      const alice = memberIds[users.alice.email]!;
      const bob = memberIds[users.bob.email]!;
      const bobCtx = memberContexts[0]!;
      const owed = await ok(owner, 'expenses.create', {
        groupId,
        title: 'Concert',
        amount: 5000,
        paidById: alice,
        splitMode: 'EQUAL',
        shares: [
          { userId: alice, amount: 2500 },
          { userId: bob, amount: 2500 },
        ],
      });
      const leave = () => trpcMutation(bobCtx, 'groups.removeMember', { groupId, userId: bob });
      expect((await trpcError(await leave())).data.code).toBe('PRECONDITION_FAILED');
      expect((await trpcError(await trpcMutation(owner, 'groups.archive', { groupId }))).data.code).toBe(
        'PRECONDITION_FAILED',
      );

      await ok(owner, 'expenses.delete', { groupId, expenseId: owed.id });
      await ok(owner, 'groups.archive', { groupId });
      const refused = await trpcError(await trpcMutation(owner, 'expenses.restore', { groupId, expenseId: owed.id }));
      expect(refused.message).toBe('Cannot restore expenses in an archived group');
      await ok(owner, 'groups.unarchive', { groupId });

      // Bob owes nothing once it's deleted, so he can leave
      expect((await leave()).ok()).toBe(true);
    } finally {
      await dispose();
    }
  });

  // A removed person can't be put in a new balance, but a restore that only settles theirs is
  // the undo of the mis-tap this exists for (#284: removed at zero, then an old expense deleted)
  test('restoring an expense with someone removed only goes ahead when it settles their balance', async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Soft Delete Removed',
    );
    try {
      const alice = memberIds[users.alice.email]!;
      const hal = await ok(owner, 'groups.addPlaceholder', { groupId, name: 'Hal' });
      const split = (paidById: string, title: string) =>
        ok(owner, 'expenses.create', {
          groupId,
          title,
          amount: 1000,
          paidById,
          splitMode: 'EQUAL',
          shares: [
            { userId: alice, amount: 500 },
            { userId: hal.id, amount: 500 },
          ],
        });
      const alicePaid = await split(alice, 'Alice paid');
      const halPaid = await split(hal.id, 'Hal paid');
      // Settled up, so Hal can be removed
      await ok(owner, 'groups.removeMember', { groupId, userId: hal.id });

      // A mis-tap: Hal is now owed $5.00, and restoring settles it
      await ok(owner, 'expenses.delete', { groupId, expenseId: alicePaid.id });
      expect(await balances(owner, groupId)).toEqual({ [alice]: -500, [hal.id]: 500 });
      await ok(owner, 'expenses.restore', { groupId, expenseId: alicePaid.id });
      expect(await balances(owner, groupId)).toEqual({});

      // Deleting both and restoring one would leave Hal owing money he can't settle in the group
      await ok(owner, 'expenses.delete', { groupId, expenseId: alicePaid.id });
      await ok(owner, 'expenses.delete', { groupId, expenseId: halPaid.id });
      const refused = await trpcError(
        await trpcMutation(owner, 'expenses.restore', { groupId, expenseId: alicePaid.id }),
      );
      expect(refused.message).toBe(
        'Hal is no longer in the group, so this expense can be restored only if it settles what they still owe or are owed.',
      );
      expect(await balances(owner, groupId)).toEqual({});
    } finally {
      await dispose();
    }
  });

  // #423: deleting a receipt expense put the receipt back under Saved receipts. The deleted
  // expense keeps it now, and restoring brings both back.
  test("a deleted receipt expense keeps its receipt, which doesn't come back to the saved receipts", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Soft Delete Receipt',
    );
    try {
      const alice = memberIds[users.alice.email]!;
      const bob = memberIds[users.bob.email]!;
      const upload = await owner.post(`${BASE}/api/upload`, {
        multipart: {
          file: { name: 'dinner.png', mimeType: 'image/png', buffer: readFileSync(resolve('e2e/test-receipt.png')) },
        },
      });
      const { receiptId } = await upload.json();
      await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 120000);
      const { items } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
      const expense = await ok(owner, 'receipts.assignItemsAndCreateExpense', {
        groupId,
        receiptId,
        title: 'Scanned dinner',
        paidById: alice,
        assignments: items.map((item: { id: string }) => ({ receiptItemId: item.id, userIds: [alice, bob] })),
      });
      const before = await balances(owner, groupId);
      const pending = async () =>
        ((await trpcResult(await trpcQuery(owner, 'receipts.listPending', { groupId }))) as { id: string }[]).map(
          (r) => r.id,
        );

      await ok(owner, 'expenses.delete', { groupId, expenseId: expense.id });
      expect(await pending()).not.toContain(receiptId);

      await ok(owner, 'expenses.restore', { groupId, expenseId: expense.id });
      expect(await balances(owner, groupId)).toEqual(before);
      const restored = await trpcResult(await trpcQuery(owner, 'expenses.get', { groupId, expenseId: expense.id }));
      expect(restored.receiptId).toBe(receiptId);
    } finally {
      await dispose();
    }
  });

  test('the group page lists what was deleted: an expense restores from its page, a payment from the list', async ({
    page,
  }) => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Soft Delete UI',
    );
    try {
      const alice = memberIds[users.alice.email]!;
      const bob = memberIds[users.bob.email]!;
      const ferry = await ok(owner, 'expenses.create', {
        groupId,
        title: 'Ferry tickets',
        amount: 1200,
        paidById: alice,
        splitMode: 'EQUAL',
        shares: [
          { userId: alice, amount: 600 },
          { userId: bob, amount: 600 },
        ],
      });
      await ok(memberContexts[0]!, 'settlements.create', { groupId, toId: alice, amount: 250 });

      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/expenses/${ferry.id}`);
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Delete this expense?' });
      await expect(dialog).toContainText('You can restore it later from the group page.');
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.waitForURL(new RegExp(`/groups/${groupId}$`));
      await expect(page.getByTestId('expense-row')).toHaveCount(0);

      // The payment, from the payments list
      await page.getByTestId('delete-payment').click();
      await page.getByTestId('confirm-delete-payment').click();
      await expect(page.getByTestId('payment-row')).toHaveCount(0);

      const deleted = page.getByTestId('deleted-section');
      await deleted.getByRole('button', { name: 'Deleted expenses and payments' }).click();
      await expect(deleted.getByTestId('deleted-payment-row')).toContainText(`Deleted by ${users.alice.name}`);
      await deleted
        .getByRole('button', { name: `Restore the payment of $2.50 from ${users.bob.name} to ${users.alice.name}` })
        .click();
      await expect(page.getByText('Payment restored')).toBeVisible();
      await expect(page.getByTestId('payment-row')).toHaveCount(1);
      await expect(deleted.getByTestId('deleted-payment-row')).toHaveCount(0);

      await deleted.getByTestId('deleted-expense-row').filter({ hasText: 'Ferry tickets' }).click();
      await page.waitForURL(new RegExp(`/expenses/${ferry.id}$`));
      await expect(page.getByTestId('deleted-notice')).toContainText(`Deleted by ${users.alice.name}`);
      await expect(page.getByText('Edit Expense', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Restore expense' }).click();
      await expect(page.getByText('Expense restored')).toBeVisible();
      await expect(page.getByTestId('deleted-notice')).toHaveCount(0);
      await expect(page.getByText('Edit Expense', { exact: true })).toBeVisible();

      await page.goto(`/en/groups/${groupId}`);
      await expect(page.getByTestId('expense-row')).toHaveCount(1);
      await page.getByTestId('deleted-section').getByRole('button', { name: 'Deleted expenses and payments' }).click();
      await expect(page.getByTestId('deleted-section')).toContainText('Nothing has been deleted.');
    } finally {
      await dispose();
    }
  });
});
