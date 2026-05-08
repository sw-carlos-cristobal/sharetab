import { test, expect } from "@playwright/test";
import { resolve } from "path";

const RECEIPT_PATH = resolve("e2e/receipts/coffee-shop.png");

test.describe("Guest Claiming Session UI", () => {
  test.setTimeout(120_000);
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS)
      testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });

  test("Share for Claiming button creates session and navigates to claim page", async ({ page }) => {
    await page.goto("/en/split");
    await expect(page.getByText("Split a bill")).toBeVisible();

    // Upload receipt via gallery input
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByTestId("guest-gallery-upload").click(),
    ]);
    await fileChooser.setFiles(RECEIPT_PATH);

    // Wait for processing -> people step
    await expect(page.getByTestId("guest-people-step")).toBeVisible({ timeout: 90000 });

    // Add people
    const firstInput = page.getByTestId("person-input-0");
    await firstInput.fill("Alice");
    await page.getByTestId("add-person-btn").click();
    // Fill second person
    const inputs = page.locator('[data-testid^="person-input-"]');
    await inputs.last().fill("Bob");

    // Proceed to assign step
    await page.getByTestId("next-assign-btn").click();
    await expect(page.getByTestId("guest-assign-step")).toBeVisible({ timeout: 10000 });

    // The "Share for Claiming" button should be visible
    const claimBtn = page.getByTestId("share-for-claiming-btn");
    await claimBtn.scrollIntoViewIfNeeded();
    await expect(claimBtn).toBeVisible();
    await expect(claimBtn).toContainText("Let Everyone Claim");

    // Click it
    await claimBtn.click();

    // Should navigate to the claim page /en/split/{token}/claim
    await page.waitForURL(/\/en\/split\/[a-zA-Z0-9_-]+\/claim$/, { timeout: 30000 });

    // The claim page should show the join form
    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("claim-name-input")).toBeVisible();
    await expect(page.getByTestId("claim-join-btn")).toBeVisible();
  });
});
