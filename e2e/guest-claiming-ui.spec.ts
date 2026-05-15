import { test, expect } from "@playwright/test";
import { resolve } from "path";

const RECEIPT_PATH = resolve("e2e/receipts/coffee-shop.png");

test.describe("Guest Claiming Session UI", () => {
  test.setTimeout(120_000);
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS)
      testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });

  test("full claiming flow: create session, share link, join, claim items, save", async ({
    page,
    context,
  }) => {
    // === Step 1: Creator uploads receipt and creates claiming session ===
    await page.goto("/en/split");
    await expect(page.getByText("Split a bill")).toBeVisible();

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByTestId("guest-gallery-upload").click(),
    ]);
    await fileChooser.setFiles(RECEIPT_PATH);

    // Wait for processing → people step
    await expect(page.getByTestId("guest-people-step")).toBeVisible({ timeout: 120000 });

    // Add creator name
    await page.getByTestId("person-input-0").fill("Alice");

    // Proceed to assign step
    await page.getByTestId("next-assign-btn").click();
    await expect(page.getByTestId("guest-assign-step")).toBeVisible({ timeout: 10000 });

    // Click "Share for Claiming"
    const claimBtn = page.getByTestId("share-for-claiming-btn");
    await claimBtn.scrollIntoViewIfNeeded();
    await claimBtn.click();

    // Should navigate to claim page
    await page.waitForURL(/\/en\/split\/[a-zA-Z0-9_-]+\/claim$/, { timeout: 30000 });
    const claimUrl = page.url();

    // Creator should see the join form — creator's name should be pre-filled or they join
    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 10000 });

    // Creator joins with their name
    await page.getByTestId("claim-name-input").fill("Alice");
    await page.getByTestId("claim-join-btn").click();

    // Should see the items to claim
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 10000 });

    // Claim the first two items
    await page.getByTestId("claim-item-0").click();
    await page.getByTestId("claim-item-1").click();

    // Both items should show as claimed (ring-2 ring-primary class)
    await expect(page.getByTestId("claim-item-0")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("claim-item-1")).toHaveAttribute("aria-pressed", "true");

    // Save claims
    const saveBtn = page.getByTestId("save-claims-btn");
    await saveBtn.scrollIntoViewIfNeeded();
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Button should change to "Claims saved"
    await expect(saveBtn).toContainText("Claims saved", { timeout: 10000 });

    // === Step 2: Second user opens the same link in a new tab ===
    const page2 = await context.newPage();
    await page2.goto(claimUrl);

    // Should see the join form
    await expect(page2.getByTestId("claim-join-form")).toBeVisible({ timeout: 10000 });

    // Bob joins — wait for button to be enabled after form renders
    await page2.getByTestId("claim-name-input").fill("Bob");
    await expect(page2.getByTestId("claim-join-btn")).toBeEnabled();
    await page2.getByTestId("claim-join-btn").click();

    // Should see items
    await expect(page2.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 10000 });

    // Items 0 and 1 should show "Also claimed by: Alice" (creator already claimed them)
    const item0 = page2.getByTestId("claim-item-0");
    await expect(item0.getByText("Also claimed by")).toBeVisible({ timeout: 5000 });
    await expect(item0.getByText("Alice")).toBeVisible();

    // Bob claims item 2 (a different item)
    await page2.getByTestId("claim-item-2").click();
    await expect(page2.getByTestId("claim-item-2")).toHaveAttribute("aria-pressed", "true");

    // Save Bob's claims
    const saveBtn2 = page2.getByTestId("save-claims-btn");
    await saveBtn2.scrollIntoViewIfNeeded();
    await saveBtn2.click();
    await expect(saveBtn2).toContainText("Claims saved", { timeout: 10000 });

    // === Step 3: Verify Alice's page shows Bob joined (via polling) ===
    // Wait for polling to pick up Bob in the people section
    await expect(page.getByText("People in this session (2)")).toBeVisible({ timeout: 10000 });

    // Alice's claimed items should still be claimed
    await expect(page.getByTestId("claim-item-0")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("claim-item-1")).toHaveAttribute("aria-pressed", "true");

    await page2.close();
  });
});
