import { test, expect } from '@playwright/test';
import { users, login, createTestGroup, trpcMutation, trpcQuery, trpcResult, FAKE_JPEG } from './helpers';

// #364: the receipt page previews each person's total sharing tax and tip over the items, but the
// expense was saved sharing them over the subtotal the scan read. Once an item is added, deleted
// or repriced the two differ, and the saved split wasn't the one shown.
test.describe('Receipt scan: the split saved is the one previewed (#364)', () => {
  test('after items are added, repriced and deleted', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Scan Preview',
    );
    const alice = memberIds[users.alice.email]!;
    const bob = memberIds[users.bob.email]!;
    try {
      const uploadRes = await owner.post('/api/upload', {
        multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
      });
      const { receiptId } = await uploadRes.json();
      const processed = await (
        await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000)
      ).json();
      expect(processed.result, JSON.stringify(processed)).toBeDefined();

      // A price the scan misread, and a line it missed
      const { items } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
      const [repriced, deleted] = items as { id: string; name: string; totalPrice: number }[];
      const updateRes = await trpcMutation(owner, 'receipts.updateItem', {
        itemId: repriced!.id,
        totalPrice: repriced!.totalPrice + 500,
      });
      expect(updateRes.ok(), await updateRes.text()).toBe(true);
      const added = await trpcResult(
        await trpcMutation(owner, 'receipts.addItem', {
          receiptId,
          name: 'Missed Item',
          unitPrice: 1000,
          totalPrice: 1000,
        }),
      );

      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
      await page.getByTestId('split-all-btn').click({ timeout: 30000 });
      // Bob alone on the line the scan missed, Alice alone on the repriced one
      await page.getByTestId(`item-card-${added.id}`).getByTestId(`member-toggle-${alice}`).click();
      await page.getByTestId(`item-card-${repriced!.id}`).getByTestId(`member-toggle-${bob}`).click();
      // And a line read twice, removed once it's assigned
      await page.getByRole('button', { name: `Remove ${deleted!.name}` }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
      await expect(page.getByTestId(`item-card-${deleted!.id}`)).toHaveCount(0);

      const shown = async (userId: string) => {
        const text = await page.getByTestId(`person-total-${userId}`).textContent();
        return Math.round(parseFloat(text!.replace(/[^0-9.-]/g, '')) * 100);
      };
      const preview = { [alice]: await shown(alice), [bob]: await shown(bob) };

      await page.getByTestId('create-expense-btn').click();
      await page.waitForURL(`**/groups/${groupId}`);

      const { expenses } = await trpcResult(await trpcQuery(owner, 'expenses.list', { groupId, limit: 1 }));
      const expense = await trpcResult(await trpcQuery(owner, 'expenses.get', { groupId, expenseId: expenses[0].id }));
      const saved = Object.fromEntries(
        (expense.shares as { userId: string; amount: number }[]).map((s) => [s.userId, s.amount]),
      );
      expect(saved).toEqual(preview);
    } finally {
      await dispose();
    }
  });
});
