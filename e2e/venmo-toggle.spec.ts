import { test, expect, request } from "@playwright/test";
import { login, users, authedContext, trpcMutation, trpcQuery, trpcResult } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.use({ viewport: { width: 430, height: 932 } });

test.describe("Venmo admin toggle", () => {
  test("admin can enable and disable Venmo setting", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/en/admin");

    // Find the Venmo section
    const toggleBtn = page.getByTestId("venmo-toggle-btn");
    await expect(toggleBtn).toBeVisible({ timeout: 15000 });

    // Should default to disabled
    await expect(toggleBtn).toContainText("Disabled");

    // Enable it
    await toggleBtn.click();
    await expect(toggleBtn).toContainText("Enabled", { timeout: 5000 });

    // Screenshot: Venmo enabled in admin
    await page.screenshot({ path: "docs/screenshots/venmo-admin-enabled.png" });

    // Disable it again
    await toggleBtn.click();
    await expect(toggleBtn).toContainText("Disabled", { timeout: 5000 });
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

});
