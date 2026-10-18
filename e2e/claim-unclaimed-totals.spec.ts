import { test, expect, request } from '@playwright/test';
import { rememberClaimIdentity, trpcMutation } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// #264: while items were unclaimed, the claim page put all the tax and tip on the people who had
// claimed something, and nothing showed the unclaimed amount
test('in-progress totals prorate tax and tip over every item and show what is unclaimed', async ({ browser }) => {
  const ctx = await request.newContext({ baseURL: BASE });
  const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
    receiptData: { merchantName: 'Unclaimed Diner', subtotal: 3248, tax: 260, tip: 500, total: 4008, currency: 'USD' },
    items: [
      { name: 'Steak', quantity: 1, unitPrice: 2524, totalPrice: 2524 },
      { name: 'Fries', quantity: 1, unitPrice: 500, totalPrice: 500 },
      { name: 'Soda', quantity: 1, unitPrice: 224, totalPrice: 224 },
    ],
    creatorName: 'Alice',
    paidByName: 'Alice',
    joinCreator: true,
  });
  expect(createRes.ok()).toBe(true);
  const { shareToken, creator } = (await createRes.json()).result.data.json;
  await ctx.dispose();

  const browserCtx = await browser.newContext();
  try {
    await rememberClaimIdentity(browserCtx, shareToken, { name: creator.name, personToken: creator.personToken });
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId('claim-item-0')).toBeVisible({ timeout: 15000 });

    // Before anyone claims anything, the whole bill is unclaimed
    const alice = page.getByTestId('person-total-0');
    const unclaimed = page.getByTestId('unclaimed-total');
    await expect(unclaimed).toContainText('$40.08');
    await expect(alice).toHaveCount(0);

    // Alice claims the $25.24 steak: her share of tax and tip is prorated over the whole $32.48
    await page.getByTestId('claim-item-0').click();
    await expect(alice).toContainText('$31.15');
    await expect(alice).toContainText('Tax: $2.02');
    await expect(alice).toContainText('Tip: $3.89');
    await expect(unclaimed).toContainText('Unclaimed');
    await expect(unclaimed).toContainText('$8.93');
    await expect(unclaimed).toContainText('Items: $7.24');

    // The same once saved and reloaded, from the server's copy of the claims
    await page.getByTestId('save-claims-btn').click();
    await expect(page.getByTestId('save-claims-btn')).toBeDisabled({ timeout: 15000 });
    await page.reload();
    await expect(alice).toContainText('$31.15', { timeout: 15000 });
    await expect(unclaimed).toContainText('$8.93');

    // With every item claimed the unclaimed row goes away and Alice owes the whole bill
    await page.getByTestId('claim-item-1').click();
    await page.getByTestId('claim-item-2').click();
    await expect(alice).toContainText('$40.08');
    await expect(unclaimed).toHaveCount(0);
  } finally {
    await browserCtx.close();
  }
});
