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
    await trpcMutation(ctx, "auth.updateProfile", { venmoUsername: null });
    await ctx.dispose();
  });

});
