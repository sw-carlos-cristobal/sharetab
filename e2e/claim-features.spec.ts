import { test, expect, request } from '@playwright/test';
import { joinGuestSession, trpcMutation, trpcResult, trpcQuery, FAKE_PNG, authedContext, users } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

test.describe('Claim page — rejoin buttons', () => {
  test("offers people nobody has joined as yet, but won't let a new device take over someone who joined", async ({
    page,
  }) => {
    // Alice created the split and Pat paid; only Alice has joined
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Rejoin Cafe',
        subtotal: 2000,
        tax: 200,
        tip: 100,
        total: 2300,
        currency: 'USD',
      },
      items: [
        { name: 'Coffee', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: 'Muffin', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: 'Alice',
      paidByName: 'Pat',
    });
    expect(createRes.ok()).toBe(true);
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    await ctx.dispose();

    // A browser without Alice's stored identity sees a join button for Pat only
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('rejoin-person-1')).toContainText('Pat');
    await expect(page.getByTestId('rejoin-person-0')).toHaveCount(0);

    // Typing Alice's name is refused, and the page stays on the join form
    await page.getByTestId('claim-name-input').fill('alice');
    await page.getByTestId('claim-join-btn').click();
    await expect(page.getByText('Someone has already joined under this name')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('claim-join-form')).toBeVisible();
    await expect(page.locator('[data-testid^="claim-item-"]')).toHaveCount(0);
  });

  test('clicking rejoin button auto-joins as that person', async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create session with Carol as creator — she's in people[] but has no personToken yet
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Auto Join Diner',
        subtotal: 1500,
        tax: 150,
        tip: 200,
        total: 1850,
        currency: 'USD',
      },
      items: [{ name: 'Burger', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      creatorName: 'Carol',
      paidByName: 'Carol',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;
    await ctx.dispose();

    // Open in browser and click Carol's rejoin button (first join — no token needed)
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('rejoin-person-0').click();

    // Should auto-join and show claim items (join form disappears)
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
  });

  test('double-tapping a join button joins once, without an "already joined" error', async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Double Tap Diner', subtotal: 1500, tax: 0, tip: 0, total: 1500, currency: 'USD' },
      items: [{ name: 'Burger', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      creatorName: 'Carol',
      paidByName: 'Carol',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    const joinRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('guest.joinSession')) joinRequests.push(req.url());
    });

    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('rejoin-person-0').dblclick();

    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
    await page.waitForLoadState('networkidle');
    // A second join for the same name would be refused ("Someone has already joined under this name")
    expect(joinRequests).toHaveLength(1);
    await expect(page.getByText('Someone has already joined under this name')).toHaveCount(0);
    const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
    expect(session.people).toHaveLength(1);
    await ctx.dispose();
  });

  test('someone who renamed themselves is still recognized when they come back', async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Rename Bistro', subtotal: 1500, tax: 0, tip: 0, total: 1500, currency: 'USD' },
      items: [{ name: 'Soup', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      creatorName: 'Alice',
      paidByName: 'Alice',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    await page.goto(`/en/split/${shareToken}/claim`);
    await page.getByTestId('rejoin-person-0').click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });

    // Rename herself, then come back to the page
    await page.getByTestId('edit-person-0').click();
    await page.getByTestId('edit-name-input-0').fill('Alice S.');
    await page.locator('button[type="submit"]').click();
    await expect(page.getByText('Alice S. (you)').first()).toBeVisible({ timeout: 10000 });
    await page.reload();

    // Still recognized as the same person: no second "Alice" was created
    await expect(page.getByText('Alice S. (you)').first()).toBeVisible({ timeout: 15000 });
    const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
    expect(session.people.map((p: { name: string }) => p.name)).toEqual(['Alice S.']);
    await ctx.dispose();
  });
});

test.describe('Claim page — receipt image', () => {
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS) testInfo.skip(true, 'Set RUN_AI_TESTS=1 to enable (requires receipt with image)');
  });

  test('toggle button shows and hides receipt image', async ({ page }) => {
    // This test requires a real receipt with an image.
    // Create a receipt via upload, then a claiming session linked to it.
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Upload a receipt image
    const uploadRes = await ctx.post(`${BASE}/api/upload?guest=true`, {
      multipart: {
        file: { name: 'receipt.png', mimeType: 'image/png', buffer: FAKE_PNG },
      },
    });
    expect(uploadRes.status()).toBe(200);
    const { receiptId } = await uploadRes.json();

    // Add items to the receipt
    await trpcMutation(ctx, 'receipts.addItem', {
      receiptId,
      name: 'Test Item',
      quantity: 1,
      unitPrice: 1000,
      totalPrice: 1000,
    });

    // Create a claiming session linked to the receipt
    const anonCtx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(anonCtx, 'guest.createClaimSession', {
      receiptId,
      receiptData: {
        merchantName: 'Image Test Cafe',
        subtotal: 1000,
        tax: 100,
        tip: 0,
        total: 1100,
        currency: 'USD',
      },
      items: [{ name: 'Test Item', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
      creatorName: 'Tester',
      paidByName: 'Tester',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    await ctx.dispose();
    await anonCtx.dispose();

    // Open claim page
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 10000 });

    // Receipt image toggle should be visible
    const toggleBtn = page.getByTestId('toggle-receipt-image');
    await expect(toggleBtn).toBeVisible();

    // Image should not be visible initially
    await expect(page.getByTestId('receipt-image')).not.toBeVisible();

    // Click toggle to show image
    await toggleBtn.click();
    await expect(page.getByTestId('receipt-image')).toBeVisible();

    // Click toggle again to hide
    await toggleBtn.click();
    await expect(page.getByTestId('receipt-image')).not.toBeVisible();
  });
});

test.describe('Claim session — API: mySplits tracks claim sessions', () => {
  test('claim session created by logged-in user appears in mySplits', async () => {
    const ctx = await authedContext(users.bob.email, users.bob.password);

    // Create a claiming session as Bob
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: {
        merchantName: "Bob's Pizza",
        subtotal: 2500,
        tax: 250,
        tip: 300,
        total: 3050,
        currency: 'USD',
      },
      items: [
        { name: 'Pepperoni', quantity: 1, unitPrice: 1500, totalPrice: 1500 },
        { name: 'Margherita', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: 'Bob',
      paidByName: 'Bob',
    });
    expect(createRes.ok()).toBe(true);

    // Query mySplits — should include the new session
    const splitsRes = await trpcQuery(ctx, 'guest.mySplits', { limit: 10 });
    const data = await trpcResult(splitsRes);

    expect(data.splits.length).toBeGreaterThanOrEqual(1);
    const bobsPizza = data.splits.find((s: { merchantName: string }) => s.merchantName === "Bob's Pizza");
    expect(bobsPizza).toBeDefined();
    expect(bobsPizza.status).toBe('CLAIMING');
    expect(bobsPizza.total).toBe(3050);
    expect(bobsPizza.peopleCount).toBe(1);

    await ctx.dispose();
  });
});
