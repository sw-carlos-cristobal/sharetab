import { test, expect, request } from "@playwright/test";
import { trpcMutation } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Finalize claim session", () => {
  test("finalize button appears after claims are saved", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Finalize Test Cafe",
        subtotal: 2000,
        tax: 200,
        tip: 300,
        total: 2500,
        currency: "USD",
      },
      items: [
        { name: "Latte", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Muffin", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Alice claims both items via API
    const joinRes = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Alice",
    });
    const { personToken } = (await joinRes.json()).result?.data?.json;
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken, personIndex: 0, personToken, claimedItemIndices: [0, 1],
    });
    await ctx.dispose();

    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    // Join as Alice (auto-rejoin from localStorage won't work, join manually)
    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("claim-name-input").fill("Alice");
    await page.getByTestId("claim-join-btn").click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });

    // Wait for join toast to clear
    await expect(page.locator('[data-sonner-toast]')).toBeHidden({ timeout: 10000 });

    // Finalize button should be visible (claims saved, no unsaved changes)
    const finalizeBtn = page.getByTestId("finalize-btn");
    await finalizeBtn.scrollIntoViewIfNeeded();
    await expect(finalizeBtn).toBeVisible();

    await page.close();
    await browserCtx.close();
  });

  test("finalize button hidden when unsaved changes exist", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Unsaved Test",
        subtotal: 1000,
        tax: 100,
        tip: 0,
        total: 1100,
        currency: "USD",
      },
      items: [
        { name: "Coffee", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;
    await ctx.dispose();

    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("claim-name-input").fill("Alice");
    await page.getByTestId("claim-join-btn").click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-sonner-toast]')).toBeHidden({ timeout: 10000 });

    // Toggle a claim — creates unsaved changes
    await page.getByTestId("claim-item-0").click();

    // Finalize button should NOT be visible
    await expect(page.getByTestId("finalize-btn")).not.toBeVisible();

    await page.close();
    await browserCtx.close();
  });

  test("full finalize flow: claim items, save, finalize, see summary", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Full Flow Bistro",
        subtotal: 3000,
        tax: 300,
        tip: 400,
        total: 3700,
        currency: "USD",
      },
      items: [
        { name: "Burger", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
        { name: "Salad", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Bob joins via API and claims item 1
    const joinBob = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Bob",
    });
    const bobData = (await joinBob.json()).result?.data?.json;
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex: bobData.personIndex,
      personToken: bobData.personToken,
      claimedItemIndices: [1],
    });
    await ctx.dispose();

    // Alice opens in browser
    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("claim-name-input").fill("Alice");
    await page.getByTestId("claim-join-btn").click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-sonner-toast]')).toBeHidden({ timeout: 10000 });

    // Alice claims item 0 (Burger)
    await page.getByTestId("claim-item-0").click();

    // Save claims first
    const saveBtn = page.getByTestId("save-claims-btn");
    await saveBtn.scrollIntoViewIfNeeded();
    await saveBtn.click();
    await expect(saveBtn).toContainText(/saved/i, { timeout: 10000 });

    // Now finalize button should appear
    const finalizeBtn = page.getByTestId("finalize-btn");
    await finalizeBtn.scrollIntoViewIfNeeded();
    await expect(finalizeBtn).toBeVisible({ timeout: 5000 });

    // Accept the confirmation dialog
    page.on("dialog", (dialog) => dialog.accept());
    await finalizeBtn.click();

    // Should transition to finalized summary view
    await expect(page.getByText(/finalized/i).first()).toBeVisible({ timeout: 15000 });

    // Should show per-person totals in summary cards
    await expect(page.getByText("Alice").first()).toBeVisible();
    await expect(page.getByText("Bob").first()).toBeVisible();

    // Should show the total bill
    await expect(page.getByText("$37.00")).toBeVisible();

    // Should show View Summary button
    await expect(page.getByRole("button", { name: /view.*summary/i })).toBeVisible();

    await page.close();
    await browserCtx.close();
  });

  test("API: finalizeSession calculates correct per-person totals", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "API Finalize",
        subtotal: 2000,
        tax: 200,
        tip: 300,
        total: 2500,
        currency: "USD",
      },
      items: [
        { name: "Pizza", quantity: 1, unitPrice: 1200, totalPrice: 1200 },
        { name: "Pasta", quantity: 1, unitPrice: 800, totalPrice: 800 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Alice claims Pizza, Bob claims Pasta
    const joinAlice = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Alice",
    });
    const aliceData = (await joinAlice.json()).result?.data?.json;

    const joinBob = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Bob",
    });
    const bobData = (await joinBob.json()).result?.data?.json;

    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken, personIndex: aliceData.personIndex,
      personToken: aliceData.personToken, claimedItemIndices: [0],
    });
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken, personIndex: bobData.personIndex,
      personToken: bobData.personToken, claimedItemIndices: [1],
    });

    // Finalize
    const finalizeRes = await trpcMutation(ctx, "guest.finalizeSession", {
      token: shareToken, personIndex: aliceData.personIndex,
      personToken: aliceData.personToken,
    });
    expect(finalizeRes.ok()).toBe(true);

    // Check session is finalized with summary
    const getRes = await ctx.get(
      `/api/trpc/guest.getSession?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: { token: shareToken } } }))}`
    );
    const body = await getRes.json();
    const session = body[0]?.result?.data?.json;

    expect(session.status).toBe("FINALIZED");
    expect(session.summary).toHaveLength(2);

    // Totals should sum to 2500
    const totalSum = session.summary.reduce(
      (sum: number, s: { total: number }) => sum + s.total, 0
    );
    expect(totalSum).toBe(2500);

    // Alice should have more (Pizza $12 > Pasta $8)
    const aliceSummary = session.summary.find(
      (s: { name: string }) => s.name === "Alice"
    );
    const bobSummary = session.summary.find(
      (s: { name: string }) => s.name === "Bob"
    );
    expect(aliceSummary.total).toBeGreaterThan(bobSummary.total);

    await ctx.dispose();
  });
});
