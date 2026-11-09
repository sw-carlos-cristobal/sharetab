import { test, expect, request, type Page } from '@playwright/test';
import { resolve } from 'path';
import { joinGuestSession, trpcMutation, trpcQuery, trpcResult } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

test.describe('createSplit total with tipOverride', () => {
  test('stored total reflects tipOverride, not original tip', async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Receipt: subtotal 2000, tax 200, tip 100, total 2300
    // Override tip to 500 → expected total = 2000 + 200 + 500 = 2700
    const createRes = await trpcMutation(ctx, 'guest.createSplit', {
      receiptData: {
        merchantName: 'Tip Override Test',
        subtotal: 2000,
        tax: 200,
        tip: 100,
        total: 2300,
        currency: 'USD',
      },
      items: [{ name: 'Burger', quantity: 1, unitPrice: 2000, totalPrice: 2000 }],
      people: [{ name: 'Alice' }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
      paidByIndex: 0,
      tipOverride: 500,
    });
    expect(createRes.ok()).toBe(true);
    const { shareToken } = (await createRes.json()).result?.data?.json;

    // Fetch the split and check stored receiptData.total
    const getRes = await trpcQuery(ctx, 'guest.getSplit', { token: shareToken });
    const data = await trpcResult(getRes);

    // The stored tip should be the override value
    expect(data.receiptData.tip).toBe(500);
    // The stored total should be recalculated: subtotal + tax + overriddenTip
    expect(data.receiptData.total).toBe(2700);

    // Summary totals should also sum to the correct total
    const summaryTotal = data.summary.reduce((sum: number, s: { total: number }) => sum + s.total, 0);
    expect(summaryTotal).toBe(2700);

    await ctx.dispose();
  });

  test('stored total preserved when no tipOverride is provided', async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, 'guest.createSplit', {
      receiptData: {
        merchantName: 'No Override Test',
        subtotal: 2000,
        tax: 200,
        tip: 100,
        total: 2300,
        currency: 'USD',
      },
      items: [{ name: 'Salad', quantity: 1, unitPrice: 2000, totalPrice: 2000 }],
      people: [{ name: 'Alice' }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
      paidByIndex: 0,
    });
    expect(createRes.ok()).toBe(true);
    const { shareToken } = (await createRes.json()).result?.data?.json;

    const getRes = await trpcQuery(ctx, 'guest.getSplit', { token: shareToken });
    const data = await trpcResult(getRes);

    expect(data.receiptData.tip).toBe(100);
    expect(data.receiptData.total).toBe(2300);

    await ctx.dispose();
  });
});

// #408: "Total bill" showed the scanned total, which disagreed with what people owe once the tip
// changed before sharing for claiming, or an item was edited. The scan below: Pasta $36.01 and
// Soda $3.99 make $40.00, tax $3.20, no tip.
test.describe("Quick Split's bill adds up to what everyone owes (#408)", () => {
  const scanned = { merchantName: 'Bill Adds Up', subtotal: 4000, tax: 320, tip: 0, total: 4320, currency: 'USD' };
  const pasta = { name: 'Pasta', quantity: 1, unitPrice: 3601, totalPrice: 3601 };
  const soda = { name: 'Soda', quantity: 1, unitPrice: 399, totalPrice: 399 };
  const sumOwed = (summary: { total: number }[]) => summary.reduce((sum, s) => sum + s.total, 0);

  test('a tip entered before sharing for claiming is in Total Bill', async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    // What the Quick Split page sends after a tip of $8 is typed in: the scanned subtotal and total
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { ...scanned, tip: 800 },
      items: [pasta, soda],
      creatorName: 'Alice',
      paidByName: 'Alice',
    });
    expect(createRes.ok()).toBe(true);
    const { shareToken } = (await createRes.json()).result?.data?.json;

    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    const bob = await joinGuestSession(ctx, { token: shareToken, name: 'Bob' });
    for (const [person, claimedItemIndices] of [
      [alice, [0]],
      [bob, [1]],
    ] as const) {
      const claimRes = await trpcMutation(ctx, 'guest.claimItems', {
        token: shareToken,
        personId: person.personId,
        personToken: person.personToken,
        claimedItemIndices,
      });
      expect(claimRes.ok()).toBe(true);
    }
    // The claim page finalizes without a tip override
    const finalizeRes = await trpcMutation(ctx, 'guest.finalizeSession', {
      token: shareToken,
      personId: alice.personId,
      personToken: alice.personToken,
    });
    expect(finalizeRes.ok()).toBe(true);

    const data = await trpcResult(await trpcQuery(ctx, 'guest.getSplit', { token: shareToken }));
    expect(data.receiptData).toMatchObject({ subtotal: 4000, tax: 320, tip: 800, total: 5120 });
    expect(sumOwed(data.summary)).toBe(5120);
    await ctx.dispose();

    await page.goto(`/split/${shareToken}`);
    await expect(page.getByText('Total Bill').locator('..')).toContainText('$51.20');
  });

  test('an item repriced before creating the split is in Total Bill', async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Soda changed from $3.99 to $8.99: the items now come to $45.00
    const createRes = await trpcMutation(ctx, 'guest.createSplit', {
      receiptData: scanned,
      items: [pasta, { ...soda, unitPrice: 899, totalPrice: 899 }],
      people: [{ name: 'Alice' }, { name: 'Bob' }],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [0, 1] },
      ],
      paidByIndex: 0,
    });
    expect(createRes.ok()).toBe(true);
    const { shareToken } = (await createRes.json()).result?.data?.json;

    const data = await trpcResult(await trpcQuery(ctx, 'guest.getSplit', { token: shareToken }));
    expect(data.receiptData).toMatchObject({ subtotal: 4500, tax: 320, tip: 0, total: 4820 });
    expect(sumOwed(data.summary)).toBe(4820);
    await ctx.dispose();

    // The receipt details add up too
    await page.goto(`/split/${shareToken}`);
    await expect(page.getByText('Total Bill').locator('..')).toContainText('$48.20');
    const details = page.getByText('Receipt details').locator('../..');
    await expect(details).toContainText('$45.00');
    await expect(details).toContainText('$3.20');
    await expect(details).toContainText('$48.20');
  });

  // The scan is a real extraction when the server under test uses a live AI provider, so this reads
  // the scanned figures from the page rather than expecting the mock provider's
  test('the assign step and Total Bill follow an added item and a new tip', async ({ page }) => {
    test.setTimeout(330_000);
    const assignStep = page.getByTestId('guest-assign-step');
    const amount = (row: ReturnType<Page['locator']>) => async () => toCents(await row.textContent());
    const summary = (label: string) =>
      amount(assignStep.getByText(label, { exact: true }).locator('xpath=following-sibling::span[1]'));

    await page.goto('/en/split');
    await page.getByTestId('guest-file-input').setInputFiles(resolve('e2e/test-receipt.png'));
    await expect(page.getByTestId('guest-people-step')).toBeVisible({ timeout: 150_000 });
    await page.getByTestId('person-input-0').fill('Pat');
    await page.getByTestId('next-assign-btn').click();
    await expect(assignStep).toBeVisible();
    await expect(page.locator('[data-testid^="guest-item-card-"]').first()).toBeVisible({ timeout: 15_000 });
    const subtotal = await summary('Subtotal')();
    const tax = await summary('Tax')();

    await page.getByTestId('guest-add-item-btn').click();
    await page.getByPlaceholder('Item name').fill('Hand-added item');
    await page.getByPlaceholder('Price').fill('1.00');
    await page.getByTestId('guest-add-item-submit').click();
    await expect.poll(summary('Subtotal')).toBe(subtotal + 100);

    await page.getByLabel('Tip override (optional)').fill('8');
    await expect.poll(summary('Tip')).toBe(800);
    await expect.poll(summary('Total')).toBe(subtotal + 100 + tax + 800);

    await page.getByTestId('guest-split-all-btn').click();
    await page.getByTestId('create-split-btn').click();
    await expect(page).toHaveURL(/\/split\/[^/]+$/, { timeout: 30_000 });
    const totalBill = page.getByText('Total Bill').locator('xpath=following-sibling::span[1]');
    await expect.poll(amount(totalBill)).toBe(subtotal + 100 + tax + 800);
  });
});

// An amount as the page shows it in English ("$1,234.56"), in cents
function toCents(text: string | null): number {
  return Math.round(parseFloat((text ?? '').replace(/[^0-9.-]/g, '')) * 100);
}
