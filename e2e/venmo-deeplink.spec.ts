import { test, expect, request } from "@playwright/test";
import { trpcMutation } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.use({ viewport: { width: 430, height: 932 } });

test.describe("Venmo deeplink payments", () => {
  test("venmo handle input appears on split result page", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Venmo Test Cafe",
        subtotal: 3000,
        tax: 300,
        tip: 400,
        total: 3700,
        currency: "USD",
      },
      items: [
        { name: "Latte", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
        { name: "Muffin", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
      ],
      people: [{ name: "Alice" }, { name: "Bob" }],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [1] },
      ],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;
    await ctx.dispose();

    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}`);

    // Venmo handle input should be visible
    const venmoInput = page.getByTestId("venmo-handle-input");
    await expect(venmoInput).toBeVisible({ timeout: 15000 });

    // No pay buttons yet (no handle entered)
    await expect(page.locator('[data-testid^="venmo-pay-"]')).not.toBeVisible();

    await page.close();
    await browserCtx.close();
  });

  test("entering venmo handle shows pay buttons for non-payers", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Pay Button Test",
        subtotal: 4000,
        tax: 400,
        tip: 600,
        total: 5000,
        currency: "USD",
      },
      items: [
        { name: "Steak", quantity: 1, unitPrice: 2000, totalPrice: 2000 },
        { name: "Salad", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Dessert", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      people: [{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [1] },
        { itemIndex: 2, personIndices: [2] },
      ],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;
    await ctx.dispose();

    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}`);

    await expect(page.getByTestId("venmo-handle-input")).toBeVisible({ timeout: 15000 });

    // Enter venmo handle
    await page.getByTestId("venmo-handle-input").fill("alice-venmo");
    await page.waitForTimeout(500);

    // Pay buttons should appear for Bob and Charlie (not Alice — she paid)
    const payButtons = page.locator('[data-testid^="venmo-pay-"]');
    const count = await payButtons.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Verify first pay button has correct Venmo URL
    const firstPayHref = await payButtons.first().getAttribute("href");
    expect(firstPayHref).toContain("venmo.com/alice-venmo");
    expect(firstPayHref).toContain("txn=pay");

    // Screenshot: pay buttons visible
    await page.evaluate(() => window.scrollTo({ top: 300, behavior: "instant" }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: "docs/screenshots/venmo-pay-buttons.png" });

    await page.close();
    await browserCtx.close();
  });

  test("venmo handle persists in localStorage", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Persist Test",
        subtotal: 1000,
        tax: 100,
        tip: 0,
        total: 1100,
        currency: "USD",
      },
      items: [
        { name: "Coffee", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      people: [{ name: "Alice" }, { name: "Bob" }],
      assignments: [{ itemIndex: 0, personIndices: [1] }],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;
    await ctx.dispose();

    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}`);

    await expect(page.getByTestId("venmo-handle-input")).toBeVisible({ timeout: 15000 });

    // Enter handle
    await page.getByTestId("venmo-handle-input").fill("my-venmo");

    // Verify localStorage
    const stored = await page.evaluate(() => localStorage.getItem("sharetab-venmo-handle"));
    expect(stored).toBe("my-venmo");

    // Reload — handle should persist
    await page.reload();
    await expect(page.getByTestId("venmo-handle-input")).toHaveValue("my-venmo", { timeout: 15000 });

    await page.close();
    await browserCtx.close();
  });

  test("venmo deeplink has correct amount and note", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Pizza Palace",
        subtotal: 2500,
        tax: 250,
        tip: 350,
        total: 3100,
        currency: "USD",
      },
      items: [
        { name: "Large Pizza", quantity: 1, unitPrice: 2500, totalPrice: 2500 },
      ],
      people: [{ name: "Alice" }, { name: "Bob" }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;
    await ctx.dispose();

    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}`);

    await expect(page.getByTestId("venmo-handle-input")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("venmo-handle-input").fill("alice-pays");

    // Find Bob's pay button
    const payBtn = page.locator('[data-testid^="venmo-pay-"]').first();
    await expect(payBtn).toBeVisible();
    const href = await payBtn.getAttribute("href");

    // Verify URL components
    expect(href).toContain("venmo.com/alice-pays");
    expect(href).toContain("txn=pay");
    // Amount should be Bob's share in dollars
    expect(href).toMatch(/amount=\d+\.\d{2}/);
    // Note should mention Pizza Palace
    expect(href).toContain("Pizza%20Palace");

    await page.close();
    await browserCtx.close();
  });
});
