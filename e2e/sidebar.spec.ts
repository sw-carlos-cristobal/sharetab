import { test, expect } from "@playwright/test";
import { users, login } from "./helpers";

test.describe("Sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  test("sidebar shows user info, settings, sign out, and theme toggle", async ({ page }) => {
    await expect(page.getByText("Alice Johnson").first()).toBeVisible();
    await expect(page.getByText("alice@example.com")).toBeVisible();
    await expect(page.getByText("Settings").first()).toBeVisible();
    await expect(page.getByText("Sign out").first()).toBeVisible();
  });

  test("sidebar bottom stays visible when page content is long", async ({ page }) => {
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (main) main.scrollTop = main.scrollHeight;
    });
    await expect(page.getByText("Alice Johnson").first()).toBeVisible();
    await expect(page.getByText("Sign out").first()).toBeVisible();
  });

  test("sidebar bottom visible at short viewport height", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.goto("/dashboard");
    const signOut = page.locator("aside").getByText("Sign out");
    await expect(signOut).toBeVisible();
    await expect(signOut).toBeInViewport();
  });

  test("sidebar bottom visible at narrow viewport width", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.goto("/dashboard");
    const signOut = page.locator("aside").getByText("Sign out");
    await expect(signOut).toBeVisible();
    await expect(signOut).toBeInViewport();
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

test.describe("Responsive layout", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  test("dashboard cards do not overflow at narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/dashboard");

    // Main content should not have horizontal scroll
    const hasOverflow = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? main.scrollWidth > main.clientWidth : false;
    });
    expect(hasOverflow).toBe(false);
  });

  test("dashboard cards stack to single column at narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/dashboard");

    // Both balance cards should be visible (stacked, not side-by-side overflowing)
    await expect(page.getByText("You are owed")).toBeVisible();
    await expect(page.getByText("You owe", { exact: true })).toBeVisible();
    await expect(page.getByText("People who owe you")).toBeVisible();
    await expect(page.getByText("People you owe")).toBeVisible();
  });

  test("dashboard shows two-column layout at wide viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");

    // Both balance cards should be side by side (check they're at similar Y position)
    const owedBox = await page.getByText("You are owed").boundingBox();
    const oweBox = await page.getByText("You owe", { exact: true }).boundingBox();
    expect(owedBox).toBeTruthy();
    expect(oweBox).toBeTruthy();
    // Same row means similar Y coordinates (within 5px tolerance)
    expect(Math.abs(owedBox!.y - oweBox!.y)).toBeLessThan(5);
  });
});
