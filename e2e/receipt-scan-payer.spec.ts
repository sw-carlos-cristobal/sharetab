import { test, expect } from '@playwright/test';
import { users, login, createTestGroup, trpcMutation, FAKE_JPEG } from './helpers';

// #265: Add Expense defaults "Paid by" to the signed-in user (#271), but the receipt scan
// page kept its own empty default, so every scanned expense needed one more pick
test.describe('Receipt scan: Paid by', () => {
  test('defaults to the signed-in user, and a payer saved with the receipt still wins', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Scan Payer',
    );
    try {
      const uploadRes = await owner.post('/api/upload', {
        multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
      });
      const { receiptId } = await uploadRes.json();
      const processed = await (
        await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000)
      ).json();
      expect(processed.result, JSON.stringify(processed)).toBeDefined();

      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
      await expect(page.getByTestId('paid-by-select')).toHaveValue(memberIds[users.alice.email]!, { timeout: 30000 });

      const saved = await trpcMutation(owner, 'receipts.saveForLater', {
        groupId,
        receiptId,
        paidById: memberIds[users.bob.email],
        assignments: [],
      });
      expect(saved.ok(), await saved.text()).toBe(true);
      await page.reload();
      await expect(page.getByTestId('paid-by-select')).toHaveValue(memberIds[users.bob.email]!, { timeout: 30000 });
    } finally {
      await dispose();
    }
  });
});
