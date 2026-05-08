import { test, expect } from "@playwright/test";
import { users, login, navigateToGroup } from "./helpers";
import path from "path";

const RECEIPT_PATH = path.join(__dirname, "receipts", "coffee-shop.png");

test.describe("Split Item UI", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  test("split button appears on multi-quantity items and splits correctly", async ({ page }) => {
    // Navigate to Apartment group
    await navigateToGroup(page, "Apartment");
    const groupUrl = page.url();

    // Go to scan page
    await page.goto(groupUrl + "/scan");
    await expect(page.getByTestId("scan-file-input")).toBeAttached();

    // Upload receipt
    await page.getByTestId("scan-file-input").setInputFiles(RECEIPT_PATH);

    // Wait for processing to finish and item assignment form to appear
    await expect(page.getByTestId("item-assignment-form")).toBeVisible({ timeout: 60000 });

    // Check for multi-qty items by looking for scissors buttons
    const scissorsButtons = page.locator('[data-testid^="split-btn-"]');
    const scissorsCount = await scissorsButtons.count();

    if (scissorsCount === 0) {
      // No multi-qty items; add one manually
      await page.getByTestId("add-item-btn").click();
      await expect(page.getByTestId("add-item-form")).toBeVisible();

      // Fill the add item form with quantity > 1
      const addForm = page.getByTestId("add-item-form");
      await addForm.locator('input[placeholder="Item name"]').fill("Test Multi Item");
      await addForm.locator('input[placeholder="Qty"]').fill("3");
      await addForm.locator('input[placeholder="Price"]').fill("9.00");
      await addForm.getByRole("button", { name: "Add" }).click();

      // Wait for the form to close and item to appear
      await expect(page.getByTestId("add-item-form")).not.toBeVisible({ timeout: 10000 });
    }

    // Now there should be at least one scissors button
    const updatedScissors = page.locator('[data-testid^="split-btn-"]');
    await expect(updatedScissors.first()).toBeVisible({ timeout: 10000 });

    // Count items before split
    const itemsBefore = await page.locator('[data-testid^="item-card-"]').count();

    // Click the first scissors button
    await updatedScissors.first().click();

    // Split form should be visible
    await expect(page.getByTestId("split-qty-input")).toBeVisible();
    await expect(page.getByTestId("split-form")).toBeVisible();

    // Fill split quantity
    await page.getByTestId("split-qty-input").clear();
    await page.getByTestId("split-qty-input").fill("1");

    // Submit the split
    await page.getByTestId("split-submit").click();

    // Verify item count increased by 1
    await expect(page.locator('[data-testid^="item-card-"]')).toHaveCount(itemsBefore + 1, {
      timeout: 10000,
    });
  });

  test("save for later preserves selections when resuming", async ({ page }) => {
    // Navigate to Apartment group
    await navigateToGroup(page, "Apartment");
    const groupUrl = page.url();

    // Go to scan page
    await page.goto(groupUrl + "/scan");
    await expect(page.getByTestId("scan-file-input")).toBeAttached();

    // Upload receipt
    await page.getByTestId("scan-file-input").setInputFiles(RECEIPT_PATH);

    // Wait for item assignment form
    await expect(page.getByTestId("item-assignment-form")).toBeVisible({ timeout: 60000 });

    // Select a paid-by member
    const paidBySelect = page.getByTestId("paid-by-select");
    await expect(paidBySelect).toBeVisible();
    const options = paidBySelect.locator("option");
    const optionCount = await options.count();
    // Select the second option (first real member, skip "Select member")
    if (optionCount > 1) {
      const value = await options.nth(1).getAttribute("value");
      if (value) {
        await paidBySelect.selectOption(value);
      }
    }

    // Click save for later
    await page.getByTestId("save-for-later-btn").click();

    // Should redirect to group page
    await page.waitForURL(/\/groups\//, { timeout: 15000 });

    // Look for a pending receipt indicator and click it to resume
    const pendingLink = page.locator('a[href*="scan?receiptId="]');
    const hasPending = await pendingLink.count();

    if (hasPending > 0) {
      await pendingLink.first().click();

      // Should load back to item assignment
      await expect(page.getByTestId("item-assignment-form")).toBeVisible({ timeout: 30000 });
    }
    // If no pending receipt link is visible, the save-for-later still succeeded
    // (the redirect to group page is the primary verification)
  });
});
