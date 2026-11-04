import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { users, login, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

async function uploadQuickSplitScan(ctx: APIRequestContext) {
  const res = await ctx.post(`${BASE}/api/upload?guest=true`, {
    multipart: {
      file: { name: 'receipt.png', mimeType: 'image/png', buffer: readFileSync(resolve('e2e/test-receipt.png')) },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as { receiptId: string; imagePath: string };
}

// #312: receipts no group, expense or split uses stayed for good. Only ones over a day old
// count, so a scan still being split is left alone; deleting old ones is checked against
// Postgres, since the suite can't backdate a receipt
test.describe('Admin — unused receipts', () => {
  test('storage stats count them, and cleaning up leaves a scan made today', async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    try {
      const { imagePath } = await uploadQuickSplitScan(ctx);

      const stats = await trpcResult(await trpcQuery(ctx, 'admin.getStorageStats'));
      expect(typeof stats.unusedReceiptCount).toBe('number');
      expect(typeof stats.unusedReceiptBytesFormatted).toBe('string');

      const res = await trpcMutation(ctx, 'admin.cleanupUnusedReceipts', {});
      expect(res.ok(), await res.text()).toBe(true);
      expect((await res.json()).result.data.json.deletedCount).toBeGreaterThanOrEqual(0);
      expect((await ctx.get(`${BASE}/api/uploads/${imagePath}`)).status()).toBe(200);
    } finally {
      await ctx.dispose();
    }
  });

  test('a member who is not the admin cannot clean them up', async () => {
    const ctx = await authedContext(users.bob.email, users.bob.password);
    try {
      const error = await trpcError(await trpcMutation(ctx, 'admin.cleanupUnusedReceipts', {}));
      expect(error.data?.code).toBe('FORBIDDEN');
    } finally {
      await ctx.dispose();
    }
  });

  test('the storage section shows them', async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto('/en/admin');

    const card = page.getByTestId('unused-receipts-card');
    await expect(card).toBeVisible({ timeout: 30000 });
    await expect(card.getByText('Unused Receipts')).toBeVisible();
    await expect(card.getByText(/receipts over a day old that no group, expense or split uses/)).toBeVisible();
  });
});
