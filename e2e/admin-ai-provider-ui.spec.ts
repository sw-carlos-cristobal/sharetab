import { test, expect, type Page } from "@playwright/test";
import { resolve } from "path";
import { users, login } from "./helpers";

const RECEIPT_PATH = resolve("e2e/receipts/coffee-shop.png");

async function goToAdminAndWaitForProviderSection(page: Page) {
  await login(page, users.alice.email, users.alice.password);
  await page.goto("/admin");
  const section = page.getByTestId("ai-provider-test-section");
  await expect(section).toBeVisible({ timeout: 15000 });
  return section;
}

test.describe("AI Provider Test UI", () => {
  test("section renders with upload button and disabled provider buttons", async ({
    page,
  }) => {
    const section = await goToAdminAndWaitForProviderSection(page);

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
  }) => {
    const section = await goToAdminAndWaitForProviderSection(page);

    await page.getByTestId("ai-test-file-input").setInputFiles(RECEIPT_PATH);

    // File info should appear
    const fileInfo = page.getByTestId("ai-test-file-info");
    await expect(fileInfo).toBeVisible();
    await expect(fileInfo).toContainText("coffee-shop.png");

    // Hint text should be gone
    await expect(page.getByTestId("ai-test-upload-hint")).not.toBeVisible();

    // Upload button label should change
    await expect(page.getByTestId("ai-test-upload-btn")).toContainText("Change Image");

    // Provider buttons should now be enabled
    const buttonContainer = page.getByTestId("ai-test-provider-buttons");
    const testButtons = buttonContainer.locator("button");
    const count = await testButtons.count();
    expect(count).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < count; i++) {
      await expect(testButtons.nth(i)).toBeEnabled();
    }
  });

  test("clearing uploaded file resets state", async ({ page }) => {
    const section = await goToAdminAndWaitForProviderSection(page);

    await page.getByTestId("ai-test-file-input").setInputFiles(RECEIPT_PATH);
    await expect(page.getByTestId("ai-test-file-info")).toBeVisible();

    // Click the clear button
    await page.getByTestId("ai-test-clear-btn").click();

    // File info should be gone
    await expect(page.getByTestId("ai-test-file-info")).not.toBeVisible();

    // Upload button should show original label
    await expect(page.getByTestId("ai-test-upload-btn")).toContainText("Upload Receipt Image");

    // Hint should reappear
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
  }) => {
    await goToAdminAndWaitForProviderSection(page);

    // Upload a .txt file (not an accepted image type)
    const txtPath = resolve("e2e/receipts/cafe.txt");
    await page.getByTestId("ai-test-file-input").setInputFiles(txtPath);

    // Hint text should still be visible (file was rejected client-side)
    await expect(page.getByTestId("ai-test-upload-hint")).toBeVisible();

    // Provider buttons should remain disabled
    const buttonContainer = page.getByTestId("ai-test-provider-buttons");
    const testButtons = buttonContainer.locator("button");
    const count = await testButtons.count();
    for (let i = 0; i < count; i++) {
      await expect(testButtons.nth(i)).toBeDisabled();
    }
  });

  test("changing image replaces the previous file", async ({ page }) => {
    await goToAdminAndWaitForProviderSection(page);

    await page.getByTestId("ai-test-file-input").setInputFiles(RECEIPT_PATH);
    await expect(page.getByTestId("ai-test-file-info")).toContainText("coffee-shop.png");

    // Upload a different file
    const secondPath = resolve("e2e/receipts/fast-food.png");
    await page.getByTestId("ai-test-file-input").setInputFiles(secondPath);
    await expect(page.getByTestId("ai-test-file-info")).toContainText("fast-food.png");
  });
});

test.describe("AI Provider Test — OCR via UI", () => {
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS)
      testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });
  test.setTimeout(150_000);

  test("clicking Test ocr shows success result with JSON", async ({
    page,
  }) => {
    await goToAdminAndWaitForProviderSection(page);

    await page.getByTestId("ai-test-file-input").setInputFiles(RECEIPT_PATH);
    const ocrButton = page.getByTestId("ai-test-btn-ocr");
    await expect(ocrButton).toBeEnabled();
    await ocrButton.click();

    // Wait for success result
    const successMsg = page.getByTestId("ai-test-success-msg");
    await expect(successMsg).toBeVisible({ timeout: 120_000 });
    await expect(successMsg).toContainText("ocr responded in");

    // JSON result should render
    const pre = page.getByTestId("ai-test-result-json");
    await expect(pre).toBeVisible();
    const jsonText = await pre.textContent();
    expect(jsonText).toBeTruthy();
    const parsed = JSON.parse(jsonText!);
    expect(parsed.items).toBeDefined();
    expect(parsed.total).toBeGreaterThan(0);
  });

  test("result JSON contains expected receipt fields", async ({ page }) => {
    await goToAdminAndWaitForProviderSection(page);

    await page.getByTestId("ai-test-file-input").setInputFiles(RECEIPT_PATH);
    await expect(page.getByTestId("ai-test-file-info")).toBeVisible();

    const ocrButton = page.getByTestId("ai-test-btn-ocr");
    await expect(ocrButton).toBeEnabled();
    await ocrButton.click();

    const pre = page.getByTestId("ai-test-result-json");
    await expect(pre).toBeVisible({ timeout: 120_000 });

    const parsed = JSON.parse((await pre.textContent())!);
    expect(parsed.items.length).toBeGreaterThanOrEqual(1);
    expect(typeof parsed.total).toBe("number");
    expect(parsed.total).toBeGreaterThan(0);
    for (const item of parsed.items) {
      expect(item.description).toBeTruthy();
      expect(typeof item.amount).toBe("number");
    }
  });
});
