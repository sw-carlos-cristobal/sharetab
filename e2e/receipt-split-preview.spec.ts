import { test, expect, type Page } from '@playwright/test';
import { users, login, createTestGroup, trpcMutation, trpcQuery, trpcResult, FAKE_JPEG } from './helpers';

type Owner = Awaited<ReturnType<typeof createTestGroup>>['owner'];
type Item = { id: string; name: string; totalPrice: number; assignments: { userId: string }[] };

async function scanReceipt(owner: Owner, groupId: string) {
  const uploadRes = await owner.post('/api/upload', {
    multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
  });
  const { receiptId } = await uploadRes.json();
  const processed = await (await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000)).json();
  expect(processed.result, JSON.stringify(processed)).toBeDefined();
  const { receipt, items } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
  return { receiptId: receiptId as string, items: items as Item[], tax: receipt.extractedData.tax as number };
}

async function openReceipt(page: Page, groupId: string, receiptId: string) {
  await login(page, users.alice.email, users.alice.password);
  await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
  await expect(page.getByTestId('split-all-btn')).toBeVisible({ timeout: 30000 });
}

async function removeItem(page: Page, item: Item) {
  await page.getByRole('button', { name: `Remove ${item.name}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByTestId(`item-card-${item.id}`)).toHaveCount(0);
}

// Each person's total as the page shows it, in cents
async function shownTotals(page: Page, userIds: string[]) {
  const totals: Record<string, number> = {};
  for (const userId of userIds) {
    const text = await page.getByTestId(`person-total-${userId}`).textContent();
    totals[userId] = Math.round(parseFloat(text!.replace(/[^0-9.-]/g, '')) * 100);
  }
  return totals;
}

async function savedExpense(owner: Owner, groupId: string) {
  const { expenses } = await trpcResult(await trpcQuery(owner, 'expenses.list', { groupId, limit: 1 }));
  const expense = await trpcResult(await trpcQuery(owner, 'expenses.get', { groupId, expenseId: expenses[0].id }));
  const shares = Object.fromEntries(
    (expense.shares as { userId: string; amount: number }[]).map((s) => [s.userId, s.amount]),
  );
  return { amount: expense.amount as number, shares };
}

async function newGroup(name: string) {
  return createTestGroup(
    users.alice.email,
    users.alice.password,
    [{ email: users.bob.email, password: users.bob.password }],
    name,
  );
}

// #364: the receipt page previews each person's total sharing tax and tip over the items, but the
// expense was saved sharing them over the subtotal the scan read. Once the items no longer add up
// to that subtotal (one added, deleted or repriced), the saved split wasn't the one shown.
// The scans use the mock AI provider (AI_PROVIDER_PRIORITY=mock, as CI runs), which reads 18 items
// and an 8% tax from any image.
test.describe('Receipt scan: the split saved is the one previewed (#364)', () => {
  test('after items are added, repriced and deleted, with a tip override', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await newGroup('Scan Preview');
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

      await openReceipt(page, groupId, receiptId);
      // And a line read twice, removed before anything is assigned
      await removeItem(page, deleted!);
      await page.getByTestId('split-all-btn').click();
      // Bob alone on the line the scan missed, Alice alone on the repriced one
      await page.getByTestId(`item-card-${added.id}`).getByTestId(`member-toggle-${alice}`).click();
      await page.getByTestId(`item-card-${repriced!.id}`).getByTestId(`member-toggle-${bob}`).click();
      await page.getByLabel('Tip override (optional)').fill('7.77');
      await expect(page.getByText('$7.77', { exact: true })).toBeVisible();

      const preview = await shownTotals(page, [alice, bob]);
      await page.getByTestId('create-expense-btn').click();
      await page.waitForURL(`**/groups/${groupId}`);

      const saved = await savedExpense(owner, groupId);
      expect(saved.shares).toEqual(preview);
      // The items as they are now, plus the scanned tax and the tip entered
      const itemSum = items.reduce((sum, item) => sum + item.totalPrice, 0) + 500 + 1000 - deleted!.totalPrice;
      expect(tax, 'the mock scan reads a tax').toBeGreaterThan(0);
      expect(saved.amount).toBe(itemSum + tax + 777);
    } finally {
      await dispose();
    }
  });

  // The page sends the totals it showed: a receipt changed on another device after the page loaded
  // it is refused, the page shows the receipt as it is now, and the next Create saves that
  test('an item repriced on another device after the page loaded is caught', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await newGroup('Scan Changed Elsewhere');
    const alice = memberIds[users.alice.email]!;
    const bob = memberIds[users.bob.email]!;
    try {
      const { receiptId, items } = await scanReceipt(owner, groupId);

      await openReceipt(page, groupId, receiptId);
      await page.getByTestId('split-all-btn').click();
      await page.getByTestId(`item-card-${items[0]!.id}`).getByTestId(`member-toggle-${bob}`).click();
      const before = await shownTotals(page, [alice, bob]);

      const updateRes = await trpcMutation(owner, 'receipts.updateItem', {
        itemId: items[0]!.id,
        totalPrice: items[0]!.totalPrice + 700,
      });
      expect(updateRes.ok(), await updateRes.text()).toBe(true);

      await page.getByTestId('create-expense-btn').click();
      await expect(page.getByText('This receipt changed since this page loaded it')).toBeVisible();
      await expect
        .poll(async () => (await shownTotals(page, [alice]))[alice], { message: 'the new price is shown' })
        .toBeGreaterThan(before[alice]!);

      const after = await shownTotals(page, [alice, bob]);
      await page.getByTestId('create-expense-btn').click();
      await page.waitForURL(`**/groups/${groupId}`);
      expect((await savedExpense(owner, groupId)).shares).toEqual(after);
    } finally {
      await dispose();
    }
  });

  // #411: a removed item kept its place in the page's selections, so it was counted as assigned
  // and Create and Save for later sent its id
  test('Create works after an assigned item is removed', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await newGroup('Scan Remove Create');
    const alice = memberIds[users.alice.email]!;
    const bob = memberIds[users.bob.email]!;
    try {
      const { receiptId, items, tax } = await scanReceipt(owner, groupId);

      await openReceipt(page, groupId, receiptId);
      await page.getByTestId('split-all-btn').click();
      await page.getByTestId(`item-card-${items[1]!.id}`).getByTestId(`member-toggle-${bob}`).click();
      await removeItem(page, items[0]!);

      const preview = await shownTotals(page, [alice, bob]);
      await page.getByTestId('create-expense-btn').click();
      await page.waitForURL(`**/groups/${groupId}`);

      const saved = await savedExpense(owner, groupId);
      expect(saved.shares).toEqual(preview);
      expect(saved.amount).toBe(items.slice(1).reduce((sum, item) => sum + item.totalPrice, 0) + tax);
    } finally {
      await dispose();
    }
  });

  test('removing an assigned item leaves the count, Create and Save for later right', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await newGroup('Scan Save Later');
    const alice = memberIds[users.alice.email]!;
    const bob = memberIds[users.bob.email]!;
    try {
      const { receiptId, items } = await scanReceipt(owner, groupId);
      const remaining = items.length - 1;

      await openReceipt(page, groupId, receiptId);
      await page.getByTestId('split-all-btn').click();
      await removeItem(page, items[0]!);
      await expect(page.getByText(`Assign items (${remaining}/${remaining} assigned)`)).toBeVisible();
      await expect(page.getByTestId('create-expense-btn')).toBeEnabled();

      // With another item left with nobody, Create waits for it
      const cleared = page.getByTestId(`item-card-${items[1]!.id}`);
      await cleared.getByTestId(`member-toggle-${alice}`).click();
      await cleared.getByTestId(`member-toggle-${bob}`).click();
      await expect(page.getByTestId('create-expense-btn')).toBeDisabled();
      await expect(page.getByTestId('create-expense-btn')).toHaveText('Assign all items (1 remaining)');

      await page.getByTestId('save-for-later-btn').click();
      await page.waitForURL(`**/groups/${groupId}`);

      const saved = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
      const savedItems = saved.items as Item[];
      expect(savedItems.map((item) => item.id)).toEqual(items.slice(1).map((item) => item.id));
      for (const item of savedItems) {
        expect(item.assignments, item.name).toHaveLength(item.id === items[1]!.id ? 0 : 2);
      }
    } finally {
      await dispose();
    }
  });
});
