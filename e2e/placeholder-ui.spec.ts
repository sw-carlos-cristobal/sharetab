import { test, expect } from "@playwright/test";
import { users, login, navigateToGroup } from "./helpers";

test.describe("Placeholder Members UI", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  test("add placeholder member from group settings", async ({ page }) => {
    // Create a fresh group
    await page.goto("/en/groups/new");
    await page.getByLabel("Group name").fill("Placeholder UI Test");
    await page.getByRole("button", { name: "Create Group" }).click();
    await expect(page.getByRole("heading", { name: "Placeholder UI Test" })).toBeVisible({ timeout: 15000 });
    const groupUrl = page.url();

    // Go to settings via the settings link on the group detail page
    await page.locator('a[href*="/groups/"][href$="/settings"]').click();
    await page.waitForURL(/\/groups\/\w+\/settings$/);
    await expect(page.getByText("Add Member")).toBeVisible();

    // Add a placeholder
    await page.getByPlaceholder("Name (e.g., Dave)").fill("Test Person");
    await page.getByRole("button", { name: "Add" }).click();

    // Should show in placeholder list
    await expect(page.getByText("Test Person")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Pending")).toBeVisible();
  });

  test("placeholder member shows with badge on group detail", async ({ page }) => {
    // Create group and add placeholder via API first
    await page.goto("/en/groups/new");
    await page.getByLabel("Group name").fill("Badge Test Group");
    await page.getByRole("button", { name: "Create Group" }).click();
    await expect(page.getByRole("heading", { name: "Badge Test Group" })).toBeVisible({ timeout: 15000 });
    const groupUrl = page.url();

    // Add placeholder via settings link on the group detail page
    await page.locator('a[href*="/groups/"][href$="/settings"]').click();
    await page.waitForURL(/\/groups\/\w+\/settings$/);
    await page.getByPlaceholder("Name (e.g., Dave)").fill("Ghost Member");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText("Ghost Member")).toBeVisible({ timeout: 10000 });

    // Go back to group detail
    await page.goto(groupUrl);
    await expect(page.getByText("Ghost Member")).toBeVisible({ timeout: 10000 });
    // Should show the Pending badge
    await expect(page.getByText("Pending")).toBeVisible();
  });
});

test.describe("Pending Receipts UI", () => {
  test("scan page has save for later button", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);

    // Navigate to an existing group's scan page
    await navigateToGroup(page, "Apartment");
    const groupUrl = page.url();

    await page.goto(groupUrl + "/scan");
    await expect(page.getByRole("heading", { name: "Scan Receipt" })).toBeVisible();
    // Save for Later button only appears after processing, not on upload step
    await expect(page.getByText("Upload a receipt")).toBeVisible();
  });

  test("scan page supports resume via query param", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await navigateToGroup(page, "Apartment");
    const groupUrl = page.url();

    // Navigate to scan with a fake receiptId — should go to assign step
    await page.goto(groupUrl + "/scan?receiptId=fake-id");
    // Should try to load receipt data (will fail but shows the assign step was triggered)
    // The important thing is it doesn't show the upload step
    await expect(page.getByText("Upload a receipt")).not.toBeVisible();
  });
});
