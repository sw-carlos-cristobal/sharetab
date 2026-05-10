import { test, expect, request } from "@playwright/test";
import { login, users, authedContext, trpcMutation, trpcQuery, trpcResult } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.use({ viewport: { width: 430, height: 932 } });

test.describe("Venmo profile integration", () => {
  test("settings page shows Venmo username field", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/en/settings");

    const venmoInput = page.getByTestId("venmo-username-input");
    await expect(venmoInput).toBeVisible({ timeout: 15000 });

    // Screenshot: settings page with Venmo field
    await page.screenshot({ path: "docs/screenshots/venmo-settings.png" });
  });

  test("saving Venmo username persists in profile", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/en/settings");

    const venmoInput = page.getByTestId("venmo-username-input");
    await expect(venmoInput).toBeVisible({ timeout: 15000 });

    // Enter Venmo username
    await venmoInput.fill("alice-venmo-test");

    // Save
    await page.getByTestId("save-profile-btn").click();
    await page.waitForTimeout(2000);

    // Reload and verify it persisted
    await page.reload();
    await expect(page.getByTestId("venmo-username-input")).toHaveValue("alice-venmo-test", { timeout: 15000 });

    // Clean up — clear the venmo username
    await page.getByTestId("venmo-username-input").fill("");
    await page.getByTestId("save-profile-btn").click();
  });

  test("API: getProfile returns venmoUsername", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Set venmo username
    await trpcMutation(ctx, "auth.updateProfile", { venmoUsername: "alice-api-test" });

    // Get profile
    const getRes = await trpcQuery(ctx, "auth.getProfile", {});
    const profile = await trpcResult(getRes);
    expect(profile.venmoUsername).toBe("alice-api-test");

    // Clean up
    await trpcMutation(ctx, "auth.updateProfile", { venmoUsername: "" });
    await ctx.dispose();
  });

  test("split page auto-populates Venmo handle from profile for logged-in users", async ({ page }) => {
    // Enable Venmo first
    const adminCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(adminCtx, "admin.setVenmoEnabled", { enabled: true });
    // Set Alice's Venmo username
    await trpcMutation(adminCtx, "auth.updateProfile", { venmoUsername: "alice-auto" });
    await adminCtx.dispose();

    // Create a split as Alice
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Auto Populate Test",
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

    // Login and view the split
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/split/${shareToken}`);

    // Venmo handle should be auto-populated from profile
    const venmoInput = page.getByTestId("venmo-handle-input");
    await expect(venmoInput).toBeVisible({ timeout: 15000 });
    await expect(venmoInput).toHaveValue("alice-auto", { timeout: 10000 });

    // Pay button should show for Bob
    await expect(page.locator('[data-testid^="venmo-pay-"]').first()).toBeVisible();

    // Clean up
    const cleanCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(cleanCtx, "auth.updateProfile", { venmoUsername: "" });
    await trpcMutation(cleanCtx, "admin.setVenmoEnabled", { enabled: false });
    await cleanCtx.dispose();
  });
});
