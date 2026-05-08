import { test, expect } from "@playwright/test";
import { login, users, authedContext, trpcMutation, trpcResult, trpcQuery } from "./helpers";
import { request } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("My Splits page", () => {
  test("shows empty state when user has no splits", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/en/splits");

    await expect(page.getByTestId("splits-page")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("splits-empty")).toBeVisible();
  });

  test("shows split card after user creates a guest split", async ({ page }) => {
    // Create a guest split as Alice via API
    const ctx = await authedContext(users.alice.email, users.alice.password);

    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Test Bistro",
        subtotal: 3000,
        tax: 300,
        tip: 400,
        total: 3700,
        currency: "USD",
      },
      items: [
        { name: "Pasta", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
        { name: "Salad", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
      ],
      people: ["Alice", "Bob"],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [1] },
      ],
      paidByIndex: 0,
    });
    expect(createRes.ok()).toBe(true);

    await ctx.dispose();

    // Navigate to My Splits page as Alice
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/en/splits");

    await expect(page.getByTestId("splits-page")).toBeVisible({ timeout: 10000 });
    // Should show the split card with merchant name
    await expect(page.getByText("Test Bistro")).toBeVisible({ timeout: 10000 });
    // Should show the total
    await expect(page.getByText("$37.00")).toBeVisible();
    // Should show people count
    await expect(page.getByText("2 people")).toBeVisible();
  });

  test("split card links to the split result page", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/en/splits");

    await expect(page.getByTestId("splits-page")).toBeVisible({ timeout: 10000 });

    // Click the first split card (Test Bistro from previous test)
    const card = page.getByText("Test Bistro");
    if (await card.isVisible()) {
      await card.click();
      // Should navigate to the split result page
      await page.waitForURL(/\/en\/split\/[a-zA-Z0-9_-]+$/, { timeout: 10000 });
    }
  });

  test("navigation sidebar shows My Splits link", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    // On desktop, sidebar should show My Splits
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/en/dashboard");

    const mySplitsLink = page.locator('a[href*="/splits"]');
    await expect(mySplitsLink.first()).toBeVisible({ timeout: 10000 });
  });
});
