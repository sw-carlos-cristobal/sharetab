import { test, expect, request } from "@playwright/test";
import { login, users, authedContext, trpcMutation, trpcQuery, trpcResult } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.use({ viewport: { width: 430, height: 932 } });

test.describe("Venmo admin toggle", () => {
  test("admin can enable and disable Venmo setting", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/en/admin");

    // Find the Venmo section
    await expect(page.getByText("Venmo Payments")).toBeVisible({ timeout: 15000 });

    // Should default to disabled
    const toggleBtn = page.getByRole("button", { name: /disabled/i });
    await expect(toggleBtn).toBeVisible();

    // Enable it
    await toggleBtn.click();
    await expect(page.getByRole("button", { name: /enabled/i })).toBeVisible({ timeout: 5000 });

    // Screenshot: Venmo enabled in admin
    await page.screenshot({ path: "docs/screenshots/venmo-admin-enabled.png" });

    // Disable it again
    await page.getByRole("button", { name: /enabled/i }).click();
    await expect(page.getByRole("button", { name: /disabled/i })).toBeVisible({ timeout: 5000 });
  });

  test("API: getVenmoEnabled returns correct state", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Enable Venmo
    const enableRes = await trpcMutation(ctx, "admin.setVenmoEnabled", { enabled: true });
    expect(enableRes.ok()).toBe(true);

    // Check it's enabled
    const getRes = await trpcQuery(ctx, "admin.getVenmoEnabled", {});
    const data = await trpcResult(getRes);
    expect(data.enabled).toBe(true);

    // Disable Venmo
    await trpcMutation(ctx, "admin.setVenmoEnabled", { enabled: false });

    // Check it's disabled
    const getRes2 = await trpcQuery(ctx, "admin.getVenmoEnabled", {});
    const data2 = await trpcResult(getRes2);
    expect(data2.enabled).toBe(false);

    await ctx.dispose();
  });

  test("Venmo buttons hidden when setting is disabled", async ({ browser }) => {
    // Ensure Venmo is disabled
    const adminCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(adminCtx, "admin.setVenmoEnabled", { enabled: false });
    await adminCtx.dispose();

    // Create a split
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Toggle Test",
        subtotal: 2000,
        tax: 200,
        tip: 0,
        total: 2200,
        currency: "USD",
      },
      items: [{ name: "Item", quantity: 1, unitPrice: 2000, totalPrice: 2000 }],
      people: [{ name: "Alice" }, { name: "Bob" }],
      assignments: [{ itemIndex: 0, personIndices: [1] }],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;
    await ctx.dispose();

    // Open split result page
    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}`);

    // Wait for page to load
    await expect(page.getByText("Toggle Test")).toBeVisible({ timeout: 15000 });

    // Venmo handle input should NOT be visible
    await expect(page.getByTestId("venmo-handle-input")).not.toBeVisible();

    await page.close();
    await browserCtx.close();
  });

  test("Venmo buttons visible when setting is enabled", async ({ browser }) => {
    // Enable Venmo
    const adminCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(adminCtx, "admin.setVenmoEnabled", { enabled: true });
    await adminCtx.dispose();

    // Create a split
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Enabled Test",
        subtotal: 2000,
        tax: 200,
        tip: 0,
        total: 2200,
        currency: "USD",
      },
      items: [{ name: "Item", quantity: 1, unitPrice: 2000, totalPrice: 2000 }],
      people: [{ name: "Alice" }, { name: "Bob" }],
      assignments: [{ itemIndex: 0, personIndices: [1] }],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;
    await ctx.dispose();

    // Open split result page
    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}`);

    // Venmo handle input SHOULD be visible
    await expect(page.getByTestId("venmo-handle-input")).toBeVisible({ timeout: 15000 });

    // Disable Venmo after test (cleanup)
    const cleanupCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(cleanupCtx, "admin.setVenmoEnabled", { enabled: false });
    await cleanupCtx.dispose();

    await page.close();
    await browserCtx.close();
  });
});
