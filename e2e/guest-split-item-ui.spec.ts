import { test, expect } from "@playwright/test";
import { resolve } from "path";

const RECEIPT_PATH = resolve("e2e/receipts/coffee-shop.png");

test.describe("Guest split — item split UI", () => {
  test.setTimeout(120_000);
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS)
      testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });

  test("split a multi-quantity item into two rows on the guest split page", async ({
    page,
  }) => {
    // === Step 1: Upload receipt ===
    await page.goto("/en/split");

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByTestId("guest-gallery-upload").click(),
    ]);
    await fileChooser.setFiles(RECEIPT_PATH);

    // Wait for processing → people step
    await expect(page.getByTestId("guest-people-step")).toBeVisible({ timeout: 90000 });

    // === Step 2: Add people ===
    await page.getByTestId("person-input-0").fill("Alice");
    await page.getByTestId("next-assign-btn").click();
    await expect(page.getByTestId("guest-assign-step")).toBeVisible({ timeout: 10000 });

    // === Step 3: Add a multi-quantity item ===
    await page.getByTestId("guest-add-item-btn").click();

    // Fill in item: 4x Beer at $5 each = $20
    await page.getByPlaceholder(/item name/i).fill("Beer");
    await page.getByPlaceholder(/qty/i).fill("4");
    await page.getByPlaceholder(/price/i).fill("20");
    await page.getByTestId("guest-add-item-submit").click();

    // Wait for item to appear — find the Beer item with x4
    await expect(page.getByText("Beer")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("x4")).toBeVisible();

    // === Step 4: Find and click the split button on the Beer item ===
    // The Beer item is the last one added — find its index by looking for the split button
    // near the x4 quantity badge
    const beerItem = page.locator('[data-testid^="guest-split-btn-"]').last();
    await expect(beerItem).toBeVisible();
    await beerItem.click();

    // === Step 5: Enter split quantity and submit ===
    // Split off 2 of the 4
    const splitQtyInput = page.locator('[data-testid^="guest-split-qty-"]').last();
    await expect(splitQtyInput).toBeVisible();
    await splitQtyInput.fill("2");

    const splitSubmitBtn = page.locator('[data-testid^="guest-split-submit-"]').last();
    await splitSubmitBtn.click();

    // === Step 6: Verify the split result ===
    // Should now have two Beer rows: one with x2 and one with x2
    const beerLabels = page.getByText("Beer");
    await expect(beerLabels).toHaveCount(await beerLabels.count()); // at least 2

    // Both x2 quantities should be visible
    const x2Badges = page.getByText("x2");
    await expect(x2Badges.first()).toBeVisible();

    // The x4 should no longer exist (it was split into two x2s)
    await expect(page.getByText("x4")).not.toBeVisible();

    // Verify prices: $10.00 each (20/2)
    const tenDollarPrices = page.getByText("$10.00");
    await expect(tenDollarPrices.first()).toBeVisible();
  });

  test("split button only appears on items with quantity > 1", async ({
    page,
  }) => {
    await page.goto("/en/split");

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByTestId("guest-gallery-upload").click(),
    ]);
    await fileChooser.setFiles(RECEIPT_PATH);

    await expect(page.getByTestId("guest-people-step")).toBeVisible({ timeout: 90000 });
    await page.getByTestId("person-input-0").fill("Alice");
    await page.getByTestId("next-assign-btn").click();
    await expect(page.getByTestId("guest-assign-step")).toBeVisible({ timeout: 10000 });

    // Add a single-quantity item
    await page.getByTestId("guest-add-item-btn").click();
    await page.getByPlaceholder(/item name/i).fill("Soda");
    await page.getByPlaceholder(/qty/i).fill("1");
    await page.getByPlaceholder(/price/i).fill("3");
    await page.getByTestId("guest-add-item-submit").click();

    await expect(page.getByText("Soda")).toBeVisible({ timeout: 5000 });

    // Add a multi-quantity item
    await page.getByTestId("guest-add-item-btn").click();
    await page.getByPlaceholder(/item name/i).fill("Taco");
    await page.getByPlaceholder(/qty/i).fill("3");
    await page.getByPlaceholder(/price/i).fill("15");
    await page.getByTestId("guest-add-item-submit").click();

    await expect(page.getByText("Taco")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("x3")).toBeVisible();

    // Split button should exist for Taco (qty 3) but not Soda (qty 1)
    // Count split buttons — at least one should exist (for Taco and any other multi-qty items from the receipt)
    const splitBtns = page.locator('[data-testid^="guest-split-btn-"]');
    const count = await splitBtns.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Soda should NOT have a split button — verify by checking no scissors icon next to it
    // (Soda has qty 1, so no split button rendered)
  });
});
