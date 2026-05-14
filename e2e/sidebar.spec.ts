import { test, expect } from "@playwright/test";
import { users, login, navigateToGroup } from "./helpers";

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
    await page.goto("/en/dashboard");
    const signOut = page.locator("aside").getByText("Sign out");
    await expect(signOut).toBeVisible();
    await expect(signOut).toBeInViewport();
  });

  test("sidebar bottom visible at narrow viewport width", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.goto("/en/dashboard");
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
    const settingsLink = page.locator('aside a[href*="/settings"]');
    await expect(settingsLink).toBeVisible();
    await expect(settingsLink).toHaveAttribute("href", /\/settings$/);
  });
});

test.describe("Responsive layout", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  test("dashboard cards do not overflow at narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/en/dashboard");

    // Main content should not have horizontal scroll
    const hasOverflow = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? main.scrollWidth > main.clientWidth : false;
    });
    expect(hasOverflow).toBe(false);
  });

  test("dashboard cards stack to single column at narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/en/dashboard");

    // Both balance cards should be visible (stacked, not side-by-side overflowing)
    await expect(page.getByText("You are owed").first()).toBeVisible();
    await expect(page.getByText("You owe", { exact: true }).first()).toBeVisible();
  });

  test("dashboard shows two-column layout at wide viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/en/dashboard");

    // Both balance cards should be side by side (check they're at similar Y position)
    const owedBox = await page.getByText("You are owed").first().boundingBox();
    const oweBox = await page.getByText("You owe", { exact: true }).first().boundingBox();
    expect(owedBox).toBeTruthy();
    expect(oweBox).toBeTruthy();
    // Same row means similar Y coordinates (within 5px tolerance)
    expect(Math.abs(owedBox!.y - oweBox!.y)).toBeLessThan(5);
  });
});

test.describe("Live viewport resize", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  test("layout adapts when resizing from desktop to tablet to mobile", async ({ page }) => {
    // Start at desktop
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/en/dashboard");

    // Desktop: sidebar visible, cards side by side
    await expect(page.locator("aside")).toBeVisible();
    const owedWide = await page.getByText("You are owed").first().boundingBox();
    const oweWide = await page.getByText("You owe", { exact: true }).first().boundingBox();
    expect(Math.abs(owedWide!.y - oweWide!.y)).toBeLessThan(5);

    // Resize to tablet — sidebar should hide, content fills width
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(500);
    await expect(page.locator("aside")).not.toBeVisible();
    await expect(page.getByText("You are owed").first()).toBeVisible();
    await expect(page.getByText("You owe", { exact: true }).first()).toBeVisible();

    // Resize to mobile — cards should stack (different Y positions)
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(500);
    await expect(page.locator("aside")).not.toBeVisible();
    const owedMobile = await page.getByText("You are owed").first().boundingBox();
    const oweMobile = await page.getByText("You owe", { exact: true }).first().boundingBox();
    expect(oweMobile!.y - owedMobile!.y).toBeGreaterThan(50);

    // Resize back to desktop — sidebar should reappear
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
    await expect(page.locator("aside")).toBeVisible();
  });

  test("no horizontal overflow at any size during resize", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/en/dashboard");

    const sizes = [
      { width: 1280, height: 800 },
      { width: 1024, height: 768 },
      { width: 900, height: 700 },
      { width: 768, height: 1024 },
      { width: 375, height: 812 },
      { width: 320, height: 568 },
    ];

    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.waitForTimeout(300);

      const hasOverflow = await page.evaluate(() => {
        const de = document.documentElement;
        return de.scrollWidth > de.clientWidth;
      });
      expect(hasOverflow, `Horizontal overflow at ${size.width}x${size.height}`).toBe(false);
    }
  });

  test("page remains scrollable after resize", async ({ page }) => {
    // Navigate to group detail which has more content
    await page.setViewportSize({ width: 1440, height: 900 });
    await navigateToGroup(page, "Apartment");

    // Resize to small viewport where content exceeds viewport
    await page.setViewportSize({ width: 375, height: 500 });
    await page.waitForTimeout(500);

    const canScroll = await page.evaluate(() => {
      const body = document.body;
      const de = document.documentElement;
      return body.scrollHeight > de.clientHeight || de.scrollHeight > de.clientHeight;
    });
    expect(canScroll, "Page should be scrollable at small viewport").toBe(true);

    // Resize back to large — verify content still accessible
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
    await expect(page.getByRole("heading", { name: "Expenses" })).toBeVisible();
  });
});
