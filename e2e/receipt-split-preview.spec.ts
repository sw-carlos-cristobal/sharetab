import { test, expect, type Page } from '@playwright/test';
import { users, login, createTestGroup, trpcMutation, trpcQuery, trpcResult, FAKE_JPEG } from './helpers';

type Item = { id: string; name: string; totalPrice: number; assignments: { userId: string }[] };

async function scanReceipt(owner: Awaited<ReturnType<typeof createTestGroup>>['owner'], groupId: string) {
  const uploadRes = await owner.post('/api/upload', {
    multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
  });
  const { receiptId } = await uploadRes.json();
  const processed = await (await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000)).json();
  expect(processed.result, JSON.stringify(processed)).toBeDefined();
  const { receipt, items } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
  return { receiptId: receiptId as string, items: items as Item[], tax: receipt.extractedData.tax as number };
}

async function removeItem(page: Page, item: Item) {
  await page.getByRole('button', { name: `Remove ${item.name}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId(`item-card-${item.id}`)).toHaveCount(0);
}

// #364: the receipt page previews each person's total sharing tax and tip over the items, but the
// expense was saved sharing them over the subtotal the scan read. Once an item is added, deleted
// or repriced the two differ, and the saved split wasn't the one shown.
test.describe('Receipt scan: the split saved is the one previewed (#364)', () => {
  test('after items are added, repriced and deleted, with a tip override', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Scan Preview',
    );
    const alice = memberIds[users.alice.email]!;
    const bob = memberIds[users.bob.email]!;
    try {
      const { receiptId, items, tax } = await scanReceipt(owner, groupId);

      // A price the scan misread, and a line it missed
      const [repriced, deleted] = items;
      const updateRes = await trpcMutation(owner, 'receipts.updateItem', {
        itemId: repriced!.id,
        totalPrice: repriced!.totalPrice + 500,
      });
      expect(updateRes.ok(), await updateRes.text()).toBe(true);
      const addRes = await trpcMutation(owner, 'receipts.addItem', {
        receiptId,
        name: 'Missed Item',
        unitPrice: 1000,
        totalPrice: 1000,
      });
      const added = (await addRes.json()).result?.data?.json;
      expect(added?.id, 'addItem').toBeDefined();

      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
      await page.getByTestId('split-all-btn').click({ timeout: 30000 });
      // Bob alone on the line the scan missed, Alice alone on the repriced one
      await page.getByTestId(`item-card-${added.id}`).getByTestId(`member-toggle-${alice}`).click();
      await page.getByTestId(`item-card-${repriced!.id}`).getByTestId(`member-toggle-${bob}`).click();
      // And another line removed once it's assigned (#411)
      await removeItem(page, deleted!);
      await page.getByLabel('Tip override (optional)').fill('7.77');

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
      // The items as they are now, plus the scanned tax and the tip entered
      const itemSum = items.reduce((sum, item) => sum + item.totalPrice, 0) + 500 + 1000 - deleted!.totalPrice;
      expect(tax, 'the mock scan reads a tax').toBeGreaterThan(0);
      expect(expense.amount).toBe(itemSum + tax + 777);
    } finally {
      await dispose();
    }
  });

  // #411: a removed item kept its place in the page's selections, and Save for later sent its id
  test('Save for later works after an assigned item is removed', async ({ page }) => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Scan Save Later',
    );
    try {
      const { receiptId, items } = await scanReceipt(owner, groupId);

      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
      await page.getByTestId('split-all-btn').click({ timeout: 30000 });
      await removeItem(page, items[0]!);
      await expect(page.getByTestId('create-expense-btn')).toBeEnabled();

      await page.getByTestId('save-for-later-btn').click();
      await page.waitForURL(`**/groups/${groupId}`);

      const saved = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
      expect((saved.items as Item[]).map((item) => item.id)).toEqual(items.slice(1).map((item) => item.id));
      for (const item of saved.items as Item[]) {
        expect(item.assignments, item.name).toHaveLength(2);
      }
    } finally {
      await dispose();
    }
  });
});
