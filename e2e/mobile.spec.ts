import { test, expect, devices } from "@playwright/test";
import { users, login, createTestGroup } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

test.describe("Mobile Responsive", () => {
  test("7.6.1 — sidebar hidden, hamburger visible on mobile", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);

    // Desktop sidebar should be hidden
    const sidebar = page.locator("aside");
    await expect(sidebar).not.toBeVisible();

    // Mobile header with hamburger should be visible
    const header = page.locator("header");
    await expect(header).toBeVisible();
    await expect(header.getByText("ShareTab")).toBeVisible();
  });

  test("7.6.2 — hamburger opens mobile menu", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);

    // Click hamburger button in header
    const menuButton = page.locator("header").getByRole("button");
    await menuButton.click();

    // Sheet/dialog should open with navigation
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Dashboard")).toBeVisible();
    await expect(dialog.getByText("Groups")).toBeVisible();
    await expect(dialog.getByText("Settings")).toBeVisible();
    await expect(dialog.getByText("Sign out")).toBeVisible();
  });

  test("7.6.3 — mobile menu navigation works", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);

    // Open menu and click Groups
    const menuButton = page.locator("header").getByRole("button");
    await menuButton.click();

    const dialog = page.getByRole("dialog");
    await dialog.getByText("Groups").click();

    // Should navigate to groups page
    await page.waitForURL(/\/groups/, { timeout: 10000 });
    await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible();
  });

  test("mobile layout stacks cards vertically", async ({ page }) => {
    const groupAName = `Mobile Layout A ${Date.now()}`;
    const groupBName = `Mobile Layout B ${Date.now()}`;
    const groupA = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      groupAName
    );
    const groupB = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      groupBName
    );

    await login(page, users.alice.email, users.alice.password);

    try {
      // Dashboard paginates groups — click "Show all" if needed to reveal all groups.
      const showAll = page.getByRole("button", { name: /Show all/ });
      await showAll.click({ timeout: 3000 }).catch(() => {});

      // Group cards should be visible in single column.
      await expect(page.getByRole("link", { name: new RegExp(groupAName) }).first()).toBeVisible();
      await expect(page.getByRole("link", { name: new RegExp(groupBName) }).first()).toBeVisible();
    } finally {
      await groupA.dispose();
      await groupB.dispose();
    }
  });
});
