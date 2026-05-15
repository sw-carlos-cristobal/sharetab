import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { users, login, navigateToGroup, authedContext, trpcMutation, trpcQuery, trpcResult } from "./helpers";

const RECEIPT_PATH = resolve("e2e/receipts/coffee-shop.png");
const BASE = process.env.BASE_URL || "http://localhost:3001";

async function getApartmentGroupId(ctx: Awaited<ReturnType<typeof authedContext>>) {
  const res = await trpcQuery(ctx, "groups.list");
  const groups = await trpcResult(res);
  const apartment = groups.find((g: { name: string }) => g.name === "Apartment");
  return apartment?.id ?? groups[0]?.id;
}

test.describe("Split Item UI", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    if (!process.env.RUN_AI_TESTS)
      testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
    await login(page, users.alice.email, users.alice.password);
  });
  test.setTimeout(120_000);

  test("split button appears on multi-quantity items and splits correctly", async ({ page }) => {
    // Step 1: Upload and process receipt via API (faster + more reliable)
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const groupId = await getApartmentGroupId(ctx);
    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: { file: { name: "split-ui.png", mimeType: "image/png", buffer: require("fs").readFileSync(RECEIPT_PATH) } },
    });
    const { receiptId } = await uploadRes.json();

    // Process the receipt
    await trpcMutation(ctx, "receipts.processReceipt", { receiptId, groupId }, 120000);

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

  test("save for later preserves paid-by and assignments when resuming", async ({ page }) => {
    // Step 1: Set up receipt with items via API
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const groupId = await getApartmentGroupId(ctx);
    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: { file: { name: "sfl-ui.png", mimeType: "image/png", buffer: require("fs").readFileSync(RECEIPT_PATH) } },
    });
    const { receiptId } = await uploadRes.json();
    await trpcMutation(ctx, "receipts.processReceipt", { receiptId, groupId }, 120000);

    // Get the items and member IDs
    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    expect(data.items.length).toBeGreaterThanOrEqual(2);

    await ctx.dispose();

    // Step 2: Navigate to the receipt in the browser
    await navigateToGroup(page, "Apartment");
    const groupUrl = page.url();
    await page.goto(`${groupUrl}/scan?receiptId=${receiptId}`);
    await expect(page.getByTestId("item-assignment-form")).toBeVisible({ timeout: 30000 });

    // Step 3: Select a paid-by member and record which one
    const paidBySelect = page.getByTestId("paid-by-select");
    await expect(paidBySelect).toBeVisible();
    const options = paidBySelect.locator("option");
    const secondOption = options.nth(1);
    const selectedValue = await secondOption.getAttribute("value");
    const selectedText = await secondOption.textContent();
    expect(selectedValue).toBeTruthy();
    await paidBySelect.selectOption(selectedValue!);

    // Step 4: Assign first member to first item — click the member toggle
    const firstItemCard = page.locator('[data-testid^="item-card-"]').first();
    const firstMemberToggle = firstItemCard.locator('[data-testid^="member-toggle-"]').first();
    await firstMemberToggle.click();
    // Verify it's now active (has primary bg class)
    await expect(firstMemberToggle).toHaveClass(/bg-primary/);
    const toggledMemberTestId = await firstMemberToggle.getAttribute("data-testid");

    // Step 5: Save via API (reliable — sends paidById + assignments)
    const saveCtx = await authedContext(users.alice.email, users.alice.password);
    const memberToggleTestId = await toggledMemberTestId;
    const memberId = memberToggleTestId?.replace("member-toggle-", "");
    const itemsForSave = await trpcQuery(saveCtx, "receipts.getReceiptItems", { receiptId });
    const itemsData = await trpcResult(itemsForSave);
    const firstItemId = itemsData.items[0]?.id;

    await trpcMutation(saveCtx, "receipts.saveForLater", {
      groupId,
      receiptId,
      paidById: selectedValue,
      assignments: firstItemId && memberId ? [{ receiptItemId: firstItemId, userIds: [memberId] }] : [],
    });
    await saveCtx.dispose();

    // Navigate back to group page
    await page.goto(page.url().replace(/\/scan.*/, ""));
    await page.waitForURL(/\/groups\/[^/]+$/, { timeout: 15000 });

    // Step 6: Resume the pending receipt
    const pendingLink = page.locator('a[href*="scan?receiptId="]').first();
    await expect(pendingLink).toBeVisible({ timeout: 10000 });
    await pendingLink.click();
    await expect(page.getByTestId("item-assignment-form")).toBeVisible({ timeout: 30000 });

    // Step 7: Verify paid-by is restored
    const restoredSelect = page.getByTestId("paid-by-select");
    await expect(restoredSelect).toHaveValue(selectedValue!);

    // Step 8: Verify the member assignment is restored (toggle should be active)
    const restoredItemCard = page.locator('[data-testid^="item-card-"]').first();
    const restoredToggle = restoredItemCard.locator(`[data-testid="${toggledMemberTestId}"]`);
    await expect(restoredToggle).toHaveClass(/bg-primary/);
  });

  test("save for later rehydrates selections without page refresh", async ({ page }) => {
    // API: upload, process, save with paidById + assignments
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const groupId = await getApartmentGroupId(ctx);

    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: { file: { name: "rehydrate-test.png", mimeType: "image/png", buffer: require("fs").readFileSync(RECEIPT_PATH) } },
    });
    const { receiptId } = await uploadRes.json();
    await trpcMutation(ctx, "receipts.processReceipt", { receiptId, groupId }, 120000);

    // Get items + alice's ID
    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    const groupRes = await trpcQuery(ctx, "groups.get", { groupId });
    const groupData = await trpcResult(groupRes);
    const aliceId = groupData.members.find((m: { user: { email: string } }) => m.user.email === "alice@example.com").user.id;
    const firstItemId = data.items[0]?.id;

    // Save via API with paidById + assignment
    await trpcMutation(ctx, "receipts.saveForLater", {
      groupId,
      receiptId,
      paidById: aliceId,
      assignments: firstItemId ? [{ receiptItemId: firstItemId, userIds: [aliceId] }] : [],
    });
    await ctx.dispose();

    // Browser: navigate directly to the resume page — NO refresh, NO prior visit
    await navigateToGroup(page, "Apartment");
    const pendingLink = page.locator('a[href*="scan?receiptId="]').first();
    await expect(pendingLink).toBeVisible({ timeout: 10000 });
    await pendingLink.click();
    await expect(page.getByTestId("item-assignment-form")).toBeVisible({ timeout: 30000 });

    // Immediately verify — no refresh needed
    await expect(page.getByTestId("paid-by-select")).toHaveValue(aliceId);

    // At least one member toggle should be active
    const activeToggles = page.locator('[data-testid^="member-toggle-"].bg-primary, [data-testid^="member-toggle-"][class*="bg-primary"]');
    await expect(activeToggles.first()).toBeVisible({ timeout: 5000 });
  });
});
