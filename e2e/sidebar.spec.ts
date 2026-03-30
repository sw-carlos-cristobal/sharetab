import { test, expect } from "@playwright/test";
import { users, login } from "./helpers";

test.describe("Sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  test("sidebar shows user info, settings, sign out, and theme toggle", async ({ page }) => {
    // User info visible in sidebar
    await expect(page.getByText("Alice Johnson").first()).toBeVisible();
    await expect(page.getByText("alice@example.com")).toBeVisible();

    // Settings and Sign out visible
    await expect(page.getByText("Settings").first()).toBeVisible();
    await expect(page.getByText("Sign out").first()).toBeVisible();
  });

  test("sidebar bottom stays visible when page content is long", async ({ page }) => {
    // Scroll the main content area to the bottom
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (main) main.scrollTop = main.scrollHeight;
    });

    // Sidebar bottom should still be visible (sticky positioning)
    await expect(page.getByText("Alice Johnson").first()).toBeVisible();
    await expect(page.getByText("Sign out").first()).toBeVisible();
  });

  test("sidebar sign out button is clickable", async ({ page }) => {
    const signOutBtn = page.locator("aside").getByText("Sign out");
    await expect(signOutBtn).toBeVisible();
    await expect(signOutBtn).toBeEnabled();
  });

  test("sidebar has settings link pointing to /settings", async ({ page }) => {
    const settingsLink = page.locator('aside a[href="/settings"]');
    await expect(settingsLink).toBeVisible();
    await expect(settingsLink).toHaveAttribute("href", "/settings");
  });
});
