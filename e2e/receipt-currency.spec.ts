import { test, expect, type Page } from '@playwright/test';
import {
  users,
  login,
  authedContext,
  createTestGroup,
  trpcMutation,
  trpcQuery,
  trpcResult,
  FAKE_JPEG,
} from './helpers';

type Ctx = Awaited<ReturnType<typeof authedContext>>;

// The scans use the mock AI provider (AI_PROVIDER_PRIORITY=mock, as CI runs), which reads 18 items
// and an 8% tax from any image, and no currency, as with a receipt that shows only "$"
async function scanReceipt(owner: Ctx, groupId: string) {
  const uploadRes = await owner.post('/api/upload', {
    multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
  });
  const { receiptId } = await uploadRes.json();
  const processed = await (await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000)).json();
  expect(processed.result, JSON.stringify(processed)).toBeDefined();
  const { receipt } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
  return { receiptId: receiptId as string, total: receipt.extractedData.total as number };
}

async function openReceipt(page: Page, groupId: string, receiptId: string) {
  await login(page, users.alice.email, users.alice.password);
  await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
  await expect(page.getByTestId('split-all-btn')).toBeVisible({ timeout: 30000 });
}

async function createExpenseFromPage(page: Page, groupId: string) {
  await page.getByTestId('split-all-btn').click();
  await page.getByTestId('create-expense-btn').click();
  await page.waitForURL(new RegExp(`/groups/${groupId}$`), { timeout: 30000 });
}

async function savedExpense(owner: Ctx, groupId: string) {
  const { expenses } = await trpcResult(await trpcQuery(owner, 'expenses.list', { groupId, limit: 1 }));
  return trpcResult(await trpcQuery(owner, 'expenses.get', { groupId, expenseId: expenses[0].id }));
}

async function setReceiptCurrency(owner: Ctx, receiptId: string, currency: string) {
  const res = await trpcMutation(owner, 'receipts.setCurrency', { receiptId, currency });
  expect(res.ok(), await res.text()).toBe(true);
}

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

// #361: a receipt's currency was guessed as USD, couldn't be changed short of a rescan, and a
// currency with no automatic rate blocked the expense
test.describe('Receipt currency (#361)', () => {
  test('a receipt with no readable currency, scanned in a EUR group, is in EUR', async ({ page }) => {
    const owner = await authedContext(users.alice.email, users.alice.password);
    const created = await trpcMutation(owner, 'groups.create', { name: 'Euro Scan', currency: 'EUR' });
    const group = (await created.json()).result?.data?.json;
    expect(group?.currency, 'groups.create').toBe('EUR');
    try {
      const { receiptId, total } = await scanReceipt(owner, group.id);

      await openReceipt(page, group.id, receiptId);
      await expect(page.getByTestId('receipt-currency-select')).toHaveValue('EUR');
      await expect(page.getByText(money(total, 'EUR'), { exact: true })).toBeVisible();
      // In the group's currency: nothing to convert
      await expect(page.getByTestId('receipt-rate')).toHaveCount(0);

      await createExpenseFromPage(page, group.id);
      expect(await savedExpense(owner, group.id)).toMatchObject({
        amount: total,
        currency: 'EUR',
        exchangeRate: 1,
        baseCurrencyAmount: null,
      });
    } finally {
      await trpcMutation(owner, 'groups.delete', { groupId: group.id });
      await owner.dispose();
    }
  });

  test('a currency chosen on the receipt page, with a rate entered by hand, is the one saved', async ({ page }) => {
    const { owner, groupId, dispose } = await createTestGroup(users.alice.email, users.alice.password, [], 'FX Scan');
    try {
      const { receiptId, total } = await scanReceipt(owner, groupId);

      await openReceipt(page, groupId, receiptId);
      const select = page.getByTestId('receipt-currency-select');
      await expect(select).toHaveValue('USD');
      await select.selectOption('GBP');
      // Saved on the receipt, and the page shows it in pounds
      await expect(select).toBeEnabled();
      await expect(page.getByText(money(total, 'GBP'), { exact: true })).toBeVisible();
      await expect
        .poll(async () => {
          const { receipt } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
          return receipt.extractedData.currency;
        })
        .toBe('GBP');

      const rate = page.getByTestId('receipt-rate');
      await expect(rate).toContainText('This expense is in GBP, but the group uses USD.');
      await rate.getByLabel('Set exchange rate manually').check();
      await page.getByTestId('receipt-rate-input').fill('1.25');
      await page.getByTestId('split-all-btn').click();
      await expect(rate).toContainText(`Converted: ${money(Math.round(total * 1.25), 'USD')}`);

      await page.getByTestId('create-expense-btn').click();
      await page.waitForURL(new RegExp(`/groups/${groupId}$`), { timeout: 30000 });
      expect(await savedExpense(owner, groupId)).toMatchObject({
        amount: total,
        currency: 'GBP',
        exchangeRate: 1.25,
        baseCurrencyAmount: Math.round(total * 1.25),
      });
    } finally {
      await dispose();
    }
  });

  test('a receipt in a currency with no automatic rate becomes an expense once a rate is entered', async ({ page }) => {
    const { owner, groupId, dispose } = await createTestGroup(users.alice.email, users.alice.password, [], 'No Rate');
    try {
      const { receiptId, total } = await scanReceipt(owner, groupId);
      // A code no rate source carries, so the lookup fails whether or not the server is online
      await setReceiptCurrency(owner, receiptId, 'XYZ');

      await openReceipt(page, groupId, receiptId);
      await page.getByTestId('split-all-btn').click();
      await page.getByTestId('create-expense-btn').click();
      // Refused, and the page asks for the rate
      await expect(
        page.getByText('Could not fetch exchange rate. Please provide a manual rate or try again.'),
      ).toBeVisible({
        timeout: 15000,
      });
      const rateInput = page.getByTestId('receipt-rate-input');
      await expect(rateInput).toBeVisible();

      await rateInput.fill('0.5');
      await page.getByTestId('create-expense-btn').click();
      await page.waitForURL(new RegExp(`/groups/${groupId}$`), { timeout: 30000 });
      expect(await savedExpense(owner, groupId)).toMatchObject({
        amount: total,
        currency: 'XYZ',
        exchangeRate: 0.5,
        baseCurrencyAmount: Math.round(total * 0.5),
      });
    } finally {
      await dispose();
    }
  });

  test("a saved receipt shows its own currency, not the group's", async ({ page }) => {
    const { owner, groupId, dispose } = await createTestGroup(users.alice.email, users.alice.password, [], 'Saved FX');
    try {
      const { receiptId, total } = await scanReceipt(owner, groupId);
      await setReceiptCurrency(owner, receiptId, 'GBP');
      const saved = await trpcMutation(owner, 'receipts.saveForLater', { groupId, receiptId });
      expect(saved.ok(), await saved.text()).toBe(true);

      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}`);
      await expect(page.getByText(money(total, 'GBP'), { exact: true })).toBeVisible({ timeout: 30000 });
    } finally {
      await dispose();
    }
  });
});
