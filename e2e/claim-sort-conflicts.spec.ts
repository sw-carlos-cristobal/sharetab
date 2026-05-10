import { test, expect, request } from "@playwright/test";
import { trpcMutation, trpcResult, trpcQuery } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Claim page — item sorting", () => {
  test("unclaimed items appear above claimed items with divider", async ({
    browser,
  }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create a session with 4 items
    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Sort Test Cafe",
        subtotal: 4000,
        tax: 400,
        tip: 0,
        total: 4400,
        currency: "USD",
      },
      items: [
        { name: "Latte", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Cappuccino", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Croissant", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Muffin", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Alice joins and claims first two items via API
    const joinRes = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Alice",
    });
    const { personToken } = (await joinRes.json()).result?.data?.json;

    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex: 0,
      personToken,
      claimedItemIndices: [0, 1],
    });
    await ctx.dispose();

    // Bob opens in browser
    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    // Join as Bob
    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("claim-name-input").fill("Bob");
    await page.getByTestId("claim-join-btn").click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });

    // The "Already claimed" divider should be visible
    await expect(page.getByText(/already claimed/i)).toBeVisible({ timeout: 5000 });

    // Verify item count
    const itemCards = page.locator('[data-testid^="claim-item-"]');
    const count = await itemCards.count();
    expect(count).toBe(4);

    // Verify sort order: unclaimed items (Croissant idx=2, Muffin idx=3) first,
    // claimed items (Latte idx=0, Cappuccino idx=1) last
    const firstItemText = await itemCards.nth(0).textContent();
    const secondItemText = await itemCards.nth(1).textContent();
    const thirdItemText = await itemCards.nth(2).textContent();
    const fourthItemText = await itemCards.nth(3).textContent();

    // First two should be unclaimed (Croissant, Muffin)
    expect(firstItemText).toContain("Croissant");
    expect(secondItemText).toContain("Muffin");
    // Last two should be claimed (Latte, Cappuccino) with Alice shown
    expect(thirdItemText).toContain("Latte");
    expect(fourthItemText).toContain("Cappuccino");
    expect(thirdItemText).toContain("Alice");
    expect(fourthItemText).toContain("Alice");

    await page.close();
    await browserCtx.close();
  });
});

test.describe("Claim page — conflict detection", () => {
  test("saving overlapping claims shows conflict warning", async ({
    browser,
  }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create session with 3 items
    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Conflict Test",
        subtotal: 3000,
        tax: 300,
        tip: 0,
        total: 3300,
        currency: "USD",
      },
      items: [
        { name: "Pizza", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Pasta", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Salad", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Alice joins and claims item 0 (Pizza) via API
    const joinRes = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Alice",
    });
    const { personToken: aliceToken } = (await joinRes.json()).result?.data?.json;

    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex: 0,
      personToken: aliceToken,
      claimedItemIndices: [0],
    });
    await ctx.dispose();

    // Bob opens in browser
    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    // Join as Bob
    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("claim-name-input").fill("Bob");
    await page.getByTestId("claim-join-btn").click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });

    // Wait for the "Joined" toast to disappear
    await expect(page.locator('[data-sonner-toast]')).toBeHidden({ timeout: 10000 });

    // Bob claims item 0 (Pizza — already claimed by Alice) and item 2 (Salad)
    await page.getByTestId("claim-item-0").click();
    await page.getByTestId("claim-item-2").click();

    // Save claims
    const saveBtn = page.getByTestId("save-claims-btn");
    await saveBtn.scrollIntoViewIfNeeded();
    await saveBtn.click();

    // Should show a conflict warning toast mentioning Alice and the item count
    const toast = page.locator('[data-sonner-toast]').last();
    await expect(toast).toBeVisible({ timeout: 10000 });
    const toastText = await toast.textContent();
    expect(toastText).toContain("Alice");
    expect(toastText).toMatch(/1/); // 1 conflicting item

    await page.close();
    await browserCtx.close();
  });

  test("API: claimItems returns conflicts for overlapping claims", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "API Conflict Test",
        subtotal: 2000,
        tax: 200,
        tip: 0,
        total: 2200,
        currency: "USD",
      },
      items: [
        { name: "Burger", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Fries", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Alice claims item 0
    const joinAlice = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Alice",
    });
    const aliceData = (await joinAlice.json()).result?.data?.json;
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex: aliceData.personIndex,
      personToken: aliceData.personToken,
      claimedItemIndices: [0],
    });

    // Bob also claims item 0 (overlap)
    const joinBob = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Bob",
    });
    const bobData = (await joinBob.json()).result?.data?.json;
    const claimRes = await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex: bobData.personIndex,
      personToken: bobData.personToken,
      claimedItemIndices: [0, 1],
    });
    expect(claimRes.ok()).toBe(true);
    const result = (await claimRes.json()).result?.data?.json;

    // Should return conflicts for item 0 (shared with Alice)
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].itemIndex).toBe(0);
    expect(result.conflicts[0].claimedBy).toContain("Alice");

    await ctx.dispose();
  });

  test("API: claimItems returns no conflicts for non-overlapping claims", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "No Conflict Test",
        subtotal: 2000,
        tax: 200,
        tip: 0,
        total: 2200,
        currency: "USD",
      },
      items: [
        { name: "Coffee", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Tea", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Alice claims item 0 only
    const joinAlice = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Alice",
    });
    const aliceData = (await joinAlice.json()).result?.data?.json;
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex: aliceData.personIndex,
      personToken: aliceData.personToken,
      claimedItemIndices: [0],
    });

    // Bob claims item 1 only (no overlap)
    const joinBob = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Bob",
    });
    const bobData = (await joinBob.json()).result?.data?.json;
    const claimRes = await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex: bobData.personIndex,
      personToken: bobData.personToken,
      claimedItemIndices: [1],
    });
    expect(claimRes.ok()).toBe(true);
    const result = (await claimRes.json()).result?.data?.json;

    // No conflicts
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts.length).toBe(0);

    await ctx.dispose();
  });
});
