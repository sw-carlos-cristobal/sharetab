import { test, expect, type Page } from "@playwright/test";
import { resolve } from "path";
import { users, login } from "./helpers";

const RECEIPT_PATH = resolve("e2e/receipts/coffee-shop.png");

async function goToAdminAndWaitForProviderSection(page: Page, testInfo: { skip: (condition: boolean, reason: string) => void }) {
  await login(page, users.alice.email, users.alice.password);
  await page.goto("/en/admin");
  await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15000 });
  const section = page.getByTestId("ai-provider-test-section");
  const visible = await section.isVisible().catch(() => false);
  testInfo.skip(!visible, "No non-OAuth AI providers configured — section not rendered");
  await expect(section).toBeVisible();
  return section;
}

test.describe("AI Provider Test UI", () => {
  test("section renders with upload button and disabled provider buttons", async ({
    page,
  }, testInfo) => {
    await goToAdminAndWaitForProviderSection(page, testInfo);

    await expect(page.getByTestId("ai-test-upload-btn")).toBeVisible();
    await expect(page.getByTestId("ai-test-upload-hint")).toBeVisible();

    // Provider buttons should exist but be disabled
    const buttonContainer = page.getByTestId("ai-test-provider-buttons");
    const testButtons = buttonContainer.locator("button");
    const count = await testButtons.count();
    expect(count).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < count; i++) {
      await expect(testButtons.nth(i)).toBeDisabled();
    }
  });

  test("uploading a receipt image shows filename and enables provider buttons", async ({
    page,
  }, testInfo) => {
    await goToAdminAndWaitForProviderSection(page, testInfo);

    await page.getByTestId("ai-test-file-input").setInputFiles(RECEIPT_PATH);

    // File info should appear
    const fileInfo = page.getByTestId("ai-test-file-info");
    await expect(fileInfo).toBeVisible();
    await expect(fileInfo).toContainText("coffee-shop.png");

    // Provider buttons should now be enabled
    const buttonContainer = page.getByTestId("ai-test-provider-buttons");
    const testButtons = buttonContainer.locator("button");
    const count = await testButtons.count();
    expect(count).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < count; i++) {
      await expect(testButtons.nth(i)).toBeEnabled();
    }
  });

  test("clearing uploaded file resets state", async ({ page }, testInfo) => {
    await goToAdminAndWaitForProviderSection(page, testInfo);

    // Upload first
    await page.getByTestId("ai-test-file-input").setInputFiles(RECEIPT_PATH);
    await expect(page.getByTestId("ai-test-file-info")).toBeVisible();

    // Clear
    await page.getByTestId("ai-test-clear-btn").click();

    // File info should be gone, hint should be back
    await expect(page.getByTestId("ai-test-file-info")).not.toBeVisible();
    await expect(page.getByTestId("ai-test-upload-hint")).toBeVisible();

    // Provider buttons should be disabled again
    const buttonContainer = page.getByTestId("ai-test-provider-buttons");
    const testButtons = buttonContainer.locator("button");
    const count = await testButtons.count();
    for (let i = 0; i < count; i++) {
      await expect(testButtons.nth(i)).toBeDisabled();
    }
  });

  test("uploading an invalid file type does not enable provider buttons", async ({
    page,
  }, testInfo) => {
    await goToAdminAndWaitForProviderSection(page, testInfo);

    // Try uploading a non-image file
    const invalidFile = resolve("e2e/helpers.ts");
    await page.getByTestId("ai-test-file-input").setInputFiles(invalidFile);

    // File info should NOT appear (invalid type rejected)
    await expect(page.getByTestId("ai-test-file-info")).not.toBeVisible();

    // Provider buttons should remain disabled
    const buttonContainer = page.getByTestId("ai-test-provider-buttons");
    const testButtons = buttonContainer.locator("button");
    const count = await testButtons.count();
    for (let i = 0; i < count; i++) {
      await expect(testButtons.nth(i)).toBeDisabled();
    }
  });

  test("changing image replaces the previous file", async ({ page }, testInfo) => {
    await goToAdminAndWaitForProviderSection(page, testInfo);

    // Upload first image
    await page.getByTestId("ai-test-file-input").setInputFiles(RECEIPT_PATH);
    await expect(page.getByTestId("ai-test-file-info")).toContainText("coffee-shop.png");

    // Upload second image (re-use same file with different path reference)
    const secondReceipt = resolve("e2e/receipts/golden-fork.jpg");
    await page.getByTestId("ai-test-file-input").setInputFiles(secondReceipt);
    await expect(page.getByTestId("ai-test-file-info")).toContainText("golden-fork.jpg");
  });
});

test.describe("AI Provider Test — OCR via UI", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS)
      testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });

  test("clicking Test ocr shows success result with JSON", async ({
    page,
  }, testInfo) => {
    const section = await goToAdminAndWaitForProviderSection(page, testInfo);

    await page.getByTestId("ai-test-file-input").setInputFiles(RECEIPT_PATH);
    await expect(page.getByTestId("ai-test-file-info")).toBeVisible();

    // Find and click the ocr test button
    const ocrBtn = page.getByTestId("ai-test-btn-ocr");
    const ocrExists = await ocrBtn.isVisible().catch(() => false);
    testInfo.skip(!ocrExists, "OCR provider not available");

    await ocrBtn.click();

    // Should show success message
    await expect(page.getByTestId("ai-test-success")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("ai-test-success-msg")).toContainText("responded in");

    // Should show JSON result
    const jsonPre = page.getByTestId("ai-test-result-json");
    await expect(jsonPre).toBeVisible();
    const jsonText = await jsonPre.textContent();
    const parsed = JSON.parse(jsonText!);
    expect(parsed).toBeDefined();
    expect(parsed.items).toBeDefined();
    expect(parsed.items.length).toBeGreaterThanOrEqual(1);
  });

  test("result JSON contains expected receipt fields", async ({
    page,
  }, testInfo) => {
    const section = await goToAdminAndWaitForProviderSection(page, testInfo);

    await page.getByTestId("ai-test-file-input").setInputFiles(RECEIPT_PATH);

    const ocrBtn = page.getByTestId("ai-test-btn-ocr");
    const ocrExists = await ocrBtn.isVisible().catch(() => false);
    testInfo.skip(!ocrExists, "OCR provider not available");

    await ocrBtn.click();
    await expect(page.getByTestId("ai-test-success")).toBeVisible({ timeout: 30000 });

    const jsonPre = page.getByTestId("ai-test-result-json");
    const jsonText = await jsonPre.textContent();
    const parsed = JSON.parse(jsonText!);

    expect(parsed.total).toBeGreaterThan(0);
    for (const item of parsed.items) {
      expect(item.description).toBeTruthy();
      expect(typeof item.amount).toBe("number");
    }
  });
});
