import { test, expect, request } from "@playwright/test";
import { resolve } from "path";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const RECEIPT_PATH = resolve("e2e/receipts/coffee-shop.png");

test.describe("Guest Split Flow & Claim UI", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS) testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });
  test.setTimeout(120_000);

  test("guest split flow: upload, add people, assign items, create split, view result", async ({ page }) => {
    // Navigate to guest split page (no login needed)
    await page.goto("/en/split");
    await expect(page.getByText("Split a bill")).toBeVisible();

    // Upload receipt via the "Choose from Gallery" input (no capture attr)
    const fileInput = page.locator('input[type="file"]:not([capture])');
    await fileInput.setInputFiles(RECEIPT_PATH);

    // Wait for AI processing to complete — guest flow advances to "Who's splitting?"
    await expect(page.getByText("Who's splitting?")).toBeVisible({ timeout: 90_000 });

    // In the "people" step, fill the first person name (there's already one empty input)
    const personInputs = page.locator('input[placeholder*="Person"]');
    await personInputs.first().fill("Alice");

    // Add another person
    await page.getByRole("button", { name: "Add person" }).click();
    // Fill the new person's name
    const allPersonInputs = page.locator('input[placeholder*="Person"]');
    await allPersonInputs.last().fill("Bob");

    // Click "Next: Assign Items" to proceed to assignment step
    await page.getByRole("button", { name: /Next.*Assign Items/ }).click();

    // Should be on the assignment step now
    await expect(page.getByText("Assign items")).toBeVisible({ timeout: 10_000 });

    // Use "Split all equally" to quickly assign all items to everyone
    await page.getByRole("button", { name: "Split all equally" }).click();

    // Wait for assignment count to show all assigned
    // The button should now say "Create Split & Get Link" (not "Assign all items")
    const createButton = page.getByRole("button", { name: /Create Split.*Get Link/ });
    await expect(createButton).toBeEnabled({ timeout: 10_000 });

    // Click to create the split
    await createButton.click();

    // Should redirect to the shareable result page /en/split/{token}
    await page.waitForURL(/\/en\/split\/[a-zA-Z0-9_-]+$/, { timeout: 30_000 });

    // Verify the result page shows per-person totals
    await expect(page.getByText("Each person owes")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Alice")).toBeVisible();
    await expect(page.getByText("Bob")).toBeVisible();

    // Verify the share/copy buttons are visible
    await expect(page.getByRole("button", { name: /Copy Link/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Share/ })).toBeVisible();

    // Verify receipt details section
    await expect(page.getByText("Receipt details")).toBeVisible();

    // Take screenshot for visual confirmation
    await page.screenshot({ path: "tmp-screenshots/guest-split-result.png", fullPage: true });
  });

  test("shared split result page loads with valid token and shows breakdown", async ({ page }) => {
    // Create a split via the API, then verify it renders correctly in the browser.
    const ctx = await request.newContext({ baseURL: BASE });

    // Create a split via tRPC
    const createRes = await ctx.post("/api/trpc/guest.createSplit", {
      data: {
        json: {
          receiptData: {
            merchantName: "E2E Test Cafe",
            subtotal: 3000,
            tax: 240,
            tip: 500,
            total: 3740,
            currency: "USD",
          },
          items: [
            { name: "Latte", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
            { name: "Croissant", quantity: 2, unitPrice: 750, totalPrice: 1500 },
          ],
          people: [{ name: "Alice" }, { name: "Bob" }],
          assignments: [
            { itemIndex: 0, personIndices: [0] },       // Alice gets the Latte
            { itemIndex: 1, personIndices: [0, 1] },    // Both share the Croissants
          ],
          paidByIndex: 0,
        },
      },
    });

    expect(createRes.ok()).toBe(true);
    const createBody = await createRes.json();
    const shareToken = createBody.result?.data?.json?.shareToken;
    expect(shareToken).toBeTruthy();

    await ctx.dispose();

    // Navigate to the split result page in the browser
    await page.goto(`/en/split/${shareToken}`);

    // Verify the page loads with correct data
    await expect(page.getByText("E2E Test Cafe")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Each person owes")).toBeVisible();
    await expect(page.getByText("Alice")).toBeVisible();
    await expect(page.getByText("Bob")).toBeVisible();

    // Verify receipt details
    await expect(page.getByText("Receipt details")).toBeVisible();

    // Verify Copy Link and Share buttons
    await expect(page.getByRole("button", { name: /Copy Link/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Share/ })).toBeVisible();

    // Verify expiry notice
    await expect(page.getByText(/expires on/)).toBeVisible();

    // Verify "Split your own bill" CTA
    await expect(page.getByText("Split your own bill")).toBeVisible();

    // Take screenshot
    await page.screenshot({ path: "tmp-screenshots/shared-split-result.png", fullPage: true });
  });

  test("invalid split token shows not-found error", async ({ page }) => {
    // Navigate to a non-existent split token
    await page.goto("/en/split/invalid-token-that-does-not-exist");

    // Verify the error state renders
    await expect(page.getByText("Split not found")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/invalid or has been removed/)).toBeVisible();

    // Verify CTA to create own split
    await expect(page.getByText("Split your own bill")).toBeVisible();
  });
});
