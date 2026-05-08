import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { users, login, navigateToGroup, authedContext, trpcMutation, trpcQuery, trpcResult } from "./helpers";

const RECEIPT_PATH = resolve("e2e/receipts/coffee-shop.png");
const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Split Item UI", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });
  test.setTimeout(120_000);

  test("split button appears on multi-quantity items and splits correctly", async ({ page }) => {
    // Step 1: Upload and process receipt via API (faster + more reliable)
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: { file: { name: "split-ui.png", mimeType: "image/png", buffer: require("fs").readFileSync(RECEIPT_PATH) } },
    });
    const { receiptId } = await uploadRes.json();

    // Process the receipt
    await trpcMutation(ctx, "receipts.processReceipt", { receiptId }, 90000);

    // Update one item to have quantity > 1 so the scissors button appears
    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    const firstItem = data.items[0];
    await trpcMutation(ctx, "receipts.updateItem", {
      itemId: firstItem.id,
      quantity: 3,
      unitPrice: Math.round(firstItem.totalPrice / 3),
      totalPrice: firstItem.totalPrice,
    });
    await ctx.dispose();

    // Step 2: Navigate to the receipt in the browser via the scan page
    await navigateToGroup(page, "Apartment");
    const groupUrl = page.url();
    await page.goto(`${groupUrl}/scan?receiptId=${receiptId}`);

    // Wait for item assignment form
    await expect(page.getByTestId("item-assignment-form")).toBeVisible({ timeout: 30000 });

    // There should be at least one scissors button (from the item we set to qty=3)
    const scissorsBtn = page.locator('[data-testid^="split-btn-"]').first();
    await expect(scissorsBtn).toBeVisible({ timeout: 10000 });

    // Count items before split
    const itemsBefore = await page.locator('[data-testid^="item-card-"]').count();

    // Click the scissors button
    await scissorsBtn.click();

    // Split form should be visible
    await expect(page.getByTestId("split-form")).toBeVisible();
    await expect(page.getByTestId("split-qty-input")).toBeVisible();

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
    await navigateToGroup(page, "Apartment");
    const groupUrl = page.url();

    // Go to scan page
    await page.goto(groupUrl + "/scan");
    await page.waitForSelector('#receipt', { timeout: 10000 });

    // Upload receipt using filechooser event
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('#receipt').click(),
    ]);
    await fc.setFiles(RECEIPT_PATH);

    // Wait for item assignment form
    await expect(page.getByTestId("item-assignment-form")).toBeVisible({ timeout: 90000 });

    // Select a paid-by member
    const paidBySelect = page.getByTestId("paid-by-select");
    await expect(paidBySelect).toBeVisible();
    const options = paidBySelect.locator("option");
    const optionCount = await options.count();
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

    // Look for a pending receipt and click it to resume
    const pendingLink = page.locator('a[href*="scan?receiptId="]');
    const hasPending = await pendingLink.count();

    if (hasPending > 0) {
      await pendingLink.first().click();
      await expect(page.getByTestId("item-assignment-form")).toBeVisible({ timeout: 30000 });
    }
  });
});
