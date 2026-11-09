import { test, expect, type APIRequestContext } from '@playwright/test';
import { users, login, createTestGroup, trpcMutation, trpcQuery, trpcResult, FAKE_JPEG } from './helpers';

// A receipt scanned into the group with the mock provider ("The Golden Fork", scanned tip $0.00)
async function scanIntoGroup(owner: APIRequestContext, groupId: string) {
  const uploadRes = await owner.post('/api/upload', {
    multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
  });
  const { receiptId } = await uploadRes.json();
  const processed = await (await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000)).json();
  expect(processed.result, JSON.stringify(processed)).toBeDefined();
  return receiptId as string;
}

// #412: Save for later kept only the payer and the assignments, so a reopened receipt lost its
// tip override and title; and on a fresh scan a cleared title refilled itself with the merchant's name
test.describe('Receipt page: title and tip', () => {
  test("a fresh scan's title can be cleared and typed again", async ({ page }) => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Scan Title',
    );
    try {
      const receiptId = await scanIntoGroup(owner, groupId);

      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
      const title = page.getByLabel('Expense title');
      await expect(title).toHaveValue('The Golden Fork', { timeout: 30000 });

      await title.fill('');
      await title.pressSequentially('Brunch');
      await expect(title).toHaveValue('Brunch');
    } finally {
      await dispose();
    }
  });

  test('Save for later keeps the title and tip for anyone in the group, and the expense uses them', async ({
    page,
    browser,
  }) => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Scan Title Tip',
    );
    try {
      const receiptId = await scanIntoGroup(owner, groupId);

      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
      await expect(page.getByLabel('Expense title')).toHaveValue('The Golden Fork', { timeout: 30000 });
      await page.getByLabel('Expense title').fill('Team lunch');
      await page.getByLabel('Tip override (optional)').fill('12');
      await page.getByTestId('split-all-btn').click();
      await page.getByTestId('save-for-later-btn').click();
      await page.waitForURL(new RegExp(`/en/groups/${groupId}$`), { timeout: 15000 });

      // Bob opens the saved receipt
      const bobContext = await browser.newContext();
      try {
        const bobPage = await bobContext.newPage();
        await login(bobPage, users.bob.email, users.bob.password);
        await bobPage.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
        await expect(bobPage.getByLabel('Expense title')).toHaveValue('Team lunch', { timeout: 30000 });
        await expect(bobPage.getByLabel('Tip override (optional)')).toHaveValue('12.00');

        await bobPage.getByTestId('create-expense-btn').click();
        await bobPage.waitForURL(new RegExp(`/en/groups/${groupId}$`), { timeout: 15000 });
      } finally {
        await bobContext.close();
      }

      const { receipt, items } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
      const subtotal = items.reduce((sum: number, item: { totalPrice: number }) => sum + item.totalPrice, 0);
      const { expenses } = await trpcResult(await trpcQuery(owner, 'expenses.list', { groupId }));
      expect(expenses.map((e: { title: string; amount: number }) => [e.title, e.amount])).toEqual([
        ['Team lunch', subtotal + receipt.extractedData.tax + 1200],
      ]);
    } finally {
      await dispose();
    }
  });
});
