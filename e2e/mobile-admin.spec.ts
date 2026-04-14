import { test, expect } from "@playwright/test";
import { users, login } from "./helpers";

// iPhone 14 viewport — same as mobile.spec.ts
test.use({ viewport: { width: 390, height: 844 } });

test.describe("Mobile Admin Page", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  test("admin link visible in mobile hamburger menu", async ({ page }) => {
    const menuButton = page.locator("header").getByRole("button");
    await menuButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Admin")).toBeVisible();
  });

  test("hamburger menu navigates to admin page", async ({ page }) => {
    const menuButton = page.locator("header").getByRole("button");
    await menuButton.click();

    const dialog = page.getByRole("dialog");
    await dialog.getByText("Admin").click();

    await page.waitForURL(/\/admin/, { timeout: 10000 });
    await expect(
      page.getByRole("heading", { name: "Admin Dashboard" })
    ).toBeVisible();
  });

  test("admin page renders all sections on mobile", async ({ page }) => {
    await page.goto("/admin");

    const sections = [
      "System Health",
      "User Management",
      "Group Overview",
      "Storage Stats",
      "Registration Control",
      "Announcement Banner",
      "AI Usage",
      "Global Activity Feed",
      "Admin Tools",
      "Server Logs",
      "Audit Log",
    ];

    for (const name of sections) {
      await expect(
        page.getByRole("heading", { name })
      ).toBeVisible();
    }
  });

  test("user management table is horizontally scrollable", async ({ page }) => {
    await page.goto("/admin");

    const userSection = page.locator("section", {
      has: page.getByRole("heading", { name: "User Management" }),
    });

    // Wait for table to render (data loads async — headers appear immediately)
    const table = userSection.locator("table");
    await expect(table).toBeVisible();

    // Table should be inside an overflow-x-auto wrapper for mobile scrolling
    const scrollContainer = userSection.locator(".overflow-x-auto");
    await expect(scrollContainer).toBeVisible();
    const overflowX = await scrollContainer.evaluate(
      (el) => getComputedStyle(el).overflowX
    );
    expect(overflowX).toBe("auto");
  });

  test("group overview table is horizontally scrollable", async ({ page }) => {
    await page.goto("/admin");

    const groupSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Group Overview" }),
    });

    const table = groupSection.locator("table");
    await expect(table).toBeVisible();

    const scrollContainer = groupSection.locator(".overflow-x-auto");
    await expect(scrollContainer).toBeVisible();
    const overflowX = await scrollContainer.evaluate(
      (el) => getComputedStyle(el).overflowX
    );
    expect(overflowX).toBe("auto");
  });

  test("system health cards stack in single column", async ({ page }) => {
    await page.goto("/admin");

    const healthSection = page.locator("section", {
      has: page.getByRole("heading", { name: "System Health" }),
    });

    // Wait for data to load (skeleton replaced by real cards)
    await expect(healthSection.getByText("Database")).toBeVisible();
    await expect(healthSection.getByText("Version")).toBeVisible();
    await expect(healthSection.getByText("Uptime")).toBeVisible();

    // Use data-slot selectors matching shadcn Card component
    const cards = healthSection.locator("[data-slot='card']");
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(3);

    const firstBox = await cards.nth(0).boundingBox();
    const secondBox = await cards.nth(1).boundingBox();
    expect(firstBox).toBeTruthy();
    expect(secondBox).toBeTruthy();
    // Single column: cards share the same x, second is below first
    expect(Math.abs(firstBox!.x - secondBox!.x)).toBeLessThan(10);
    expect(secondBox!.y).toBeGreaterThan(firstBox!.y);
  });

  test("storage stats cards stack in single column", async ({ page }) => {
    await page.goto("/admin");

    const storageSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Storage Stats" }),
    });

    // Wait for data to load
    await expect(storageSection.getByText("Receipts")).toBeVisible();
    await expect(storageSection.getByText("Disk Usage")).toBeVisible();

    const cards = storageSection.locator("[data-slot='card']");
    const receiptsBox = await cards.nth(0).boundingBox();
    const diskBox = await cards.nth(1).boundingBox();
    expect(receiptsBox).toBeTruthy();
    expect(diskBox).toBeTruthy();
    // Stacked: same x position, disk below receipts
    expect(Math.abs(receiptsBox!.x - diskBox!.x)).toBeLessThan(10);
    expect(diskBox!.y).toBeGreaterThan(receiptsBox!.y);
  });

  test("server logs section renders with filter buttons", async ({ page }) => {
    await page.goto("/admin");

    const logsSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Server Logs" }),
    });
    await expect(logsSection).toBeVisible();

    await expect(logsSection.getByRole("button", { name: "debug" })).toBeVisible();
    await expect(logsSection.getByRole("button", { name: "info" })).toBeVisible();
    await expect(logsSection.getByRole("button", { name: "warn" })).toBeVisible();
    await expect(logsSection.getByRole("button", { name: "error" })).toBeVisible();
  });

  test("sidebar is hidden on mobile admin page", async ({ page }) => {
    await page.goto("/admin");

    await expect(page.locator("aside")).not.toBeVisible();
    await expect(page.locator("header")).toBeVisible();
  });

  test("non-admin user does not see admin link in mobile menu", async ({
    browser,
  }) => {
    // Use a fresh context so bob's login doesn't interfere with alice's beforeEach
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await login(page, users.bob.email, users.bob.password);

    const menuButton = page.locator("header").getByRole("button");
    await menuButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Dashboard")).toBeVisible();
    await expect(dialog.getByText("Admin")).not.toBeVisible();

    await context.close();
  });
});
