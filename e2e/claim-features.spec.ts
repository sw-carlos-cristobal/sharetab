import { test, expect, request } from "@playwright/test";
import { trpcMutation, trpcResult, trpcQuery, FAKE_PNG, authedContext, users } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Claim page — rejoin buttons", () => {
  test("shows existing participants as rejoin buttons", async ({ page }) => {
    // Create a claiming session with two people already joined
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Rejoin Cafe",
        subtotal: 2000,
        tax: 200,
        tip: 100,
        total: 2300,
        currency: "USD",
      },
      items: [
        { name: "Coffee", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Muffin", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    expect(createRes.ok()).toBe(true);
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Join as Alice first to create a participant
    const joinRes = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Alice",
    });
    expect(joinRes.ok()).toBe(true);

    await ctx.dispose();

    // Open the claim page in a browser — should show rejoin button for Alice
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 10000 });

    // Rejoin button for Alice should be visible
    const rejoinBtn = page.getByTestId("rejoin-person-0");
    await expect(rejoinBtn).toBeVisible();
    await expect(rejoinBtn).toContainText("Alice");
  });

  test("clicking rejoin button auto-joins as that person", async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create session with Carol as creator — she's in people[] but has no personToken yet
    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Auto Join Diner",
        subtotal: 1500,
        tax: 150,
        tip: 200,
        total: 1850,
        currency: "USD",
      },
      items: [
        { name: "Burger", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
      ],
      creatorName: "Carol",
      paidByName: "Carol",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;
    await ctx.dispose();

    // Open in browser and click Carol's rejoin button (first join — no token needed)
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 10000 });

    await page.getByTestId("rejoin-person-0").click();

    // Should auto-join and show claim items (join form disappears)
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
  });
});

test.describe("Claim page — receipt image", () => {
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS)
      testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable (requires receipt with image)");
  });

  test("toggle button shows and hides receipt image", async ({ page }) => {
    // This test requires a real receipt with an image.
    // Create a receipt via upload, then a claiming session linked to it.
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Upload a receipt image
    const uploadRes = await ctx.post(`${BASE}/api/upload?guest=true`, {
      multipart: {
        file: { name: "receipt.png", mimeType: "image/png", buffer: FAKE_PNG },
      },
    });
    expect(uploadRes.status()).toBe(200);
    const { receiptId } = await uploadRes.json();

    // Add items to the receipt
    await trpcMutation(ctx, "receipts.addItem", {
      receiptId,
      name: "Test Item",
      quantity: 1,
      unitPrice: 1000,
      totalPrice: 1000,
    });

    // Create a claiming session linked to the receipt
    const anonCtx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(anonCtx, "guest.createClaimSession", {
      receiptId,
      receiptData: {
        merchantName: "Image Test Cafe",
        subtotal: 1000,
        tax: 100,
        tip: 0,
        total: 1100,
        currency: "USD",
      },
      items: [
        { name: "Test Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Tester",
      paidByName: "Tester",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    await ctx.dispose();
    await anonCtx.dispose();

    // Open claim page
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 10000 });

    // Receipt image toggle should be visible
    const toggleBtn = page.getByTestId("toggle-receipt-image");
    await expect(toggleBtn).toBeVisible();

    // Image should not be visible initially
    await expect(page.getByTestId("receipt-image")).not.toBeVisible();

    // Click toggle to show image
    await toggleBtn.click();
    await expect(page.getByTestId("receipt-image")).toBeVisible();

    // Click toggle again to hide
    await toggleBtn.click();
    await expect(page.getByTestId("receipt-image")).not.toBeVisible();
  });
});

test.describe("Claim session — API: mySplits tracks claim sessions", () => {
  test("claim session created by logged-in user appears in mySplits", async () => {
    const ctx = await authedContext(users.bob.email, users.bob.password);

    // Create a claiming session as Bob
    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Bob's Pizza",
        subtotal: 2500,
        tax: 250,
        tip: 300,
        total: 3050,
        currency: "USD",
      },
      items: [
        { name: "Pepperoni", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
        { name: "Margherita", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Bob",
      paidByName: "Bob",
    });
    expect(createRes.ok()).toBe(true);

    // Query mySplits — should include the new session
    const splitsRes = await trpcQuery(ctx, "guest.mySplits", { limit: 10 });
    const data = await trpcResult(splitsRes);

    expect(data.splits.length).toBeGreaterThanOrEqual(1);
    const bobsPizza = data.splits.find((s: { merchantName: string }) => s.merchantName === "Bob's Pizza");
    expect(bobsPizza).toBeDefined();
    expect(bobsPizza.status).toBe("CLAIMING");
    expect(bobsPizza.total).toBe(3050);
    expect(bobsPizza.peopleCount).toBe(1);

    await ctx.dispose();
  });
});
