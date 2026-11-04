import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'path';

const RECEIPT_PATH = resolve('e2e/receipts/coffee-shop.png');

// The cards of the items named exactly `name`. Scope item assertions to these:
// the receipt's own items can share words, quantities, and prices with the
// items a test adds (the mock provider returns "Fish Tacos", two x3 items, and
// four x2 items).
function itemCards(page: Page, name: string) {
  return page.locator('[data-testid^="guest-item-card-"]').filter({ has: page.getByText(name, { exact: true }) });
}

test.describe('Guest split — item split UI', () => {
  test.setTimeout(120_000);
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS) testInfo.skip(true, 'Set RUN_AI_TESTS=1 to enable');
  });

  test('split a multi-quantity item into two rows on the guest split page', async ({ page }) => {
    // === Step 1: Upload receipt ===
    await page.goto('/en/split');

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('guest-gallery-upload').click(),
    ]);
    await fileChooser.setFiles(RECEIPT_PATH);

    // Wait for processing → people step
    await expect(page.getByTestId('guest-people-step')).toBeVisible({ timeout: 120000 });

    // === Step 2: Add people ===
    await page.getByTestId('person-input-0').fill('Alice');
    await page.getByTestId('next-assign-btn').click();
    await expect(page.getByTestId('guest-assign-step')).toBeVisible({ timeout: 10000 });

    // === Step 3: Add a multi-quantity item ===
    await page.getByTestId('guest-add-item-btn').click();

    // Fill in item: 4x Beer at $5 each = $20
    await page.getByPlaceholder(/item name/i).fill('Beer');
    await page.getByPlaceholder(/qty/i).fill('4');
    await page.getByPlaceholder(/price/i).fill('20');
    await page.getByTestId('guest-add-item-submit').click();

    const beerRows = itemCards(page, 'Beer');
    await expect(beerRows).toHaveCount(1, { timeout: 5000 });
    await expect(beerRows.getByText('x4', { exact: true })).toBeVisible();

    // === Step 4: Click the Beer item's split button ===
    await beerRows.locator('[data-testid^="guest-split-btn-"]').click();

    // === Step 5: Split off 2 of the 4 ===
    await beerRows.locator('[data-testid^="guest-split-qty-"]').fill('2');
    await beerRows.locator('[data-testid^="guest-split-submit-"]').click();

    // === Step 6: Two Beer rows, each x2 at $10.00 (20/2) ===
    await expect(beerRows).toHaveCount(2);
    for (const row of await beerRows.all()) {
      await expect(row.getByText('x2', { exact: true })).toBeVisible();
      await expect(row.getByText('$10.00', { exact: true })).toBeVisible();
    }
  });

  test('split button only appears on items with quantity > 1', async ({ page }) => {
    await page.goto('/en/split');

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('guest-gallery-upload').click(),
    ]);
    await fileChooser.setFiles(RECEIPT_PATH);

    await expect(page.getByTestId('guest-people-step')).toBeVisible({ timeout: 120000 });
    await page.getByTestId('person-input-0').fill('Alice');
    await page.getByTestId('next-assign-btn').click();
    await expect(page.getByTestId('guest-assign-step')).toBeVisible({ timeout: 10000 });

    // Add a single-quantity item
    await page.getByTestId('guest-add-item-btn').click();
    await page.getByPlaceholder(/item name/i).fill('Soda');
    await page.getByPlaceholder(/qty/i).fill('1');
    await page.getByPlaceholder(/price/i).fill('3');
    await page.getByTestId('guest-add-item-submit').click();

    const sodaRows = itemCards(page, 'Soda');
    await expect(sodaRows).toHaveCount(1, { timeout: 5000 });

    // Add a multi-quantity item
    await page.getByTestId('guest-add-item-btn').click();
    await page.getByPlaceholder(/item name/i).fill('Taco');
    await page.getByPlaceholder(/qty/i).fill('3');
    await page.getByPlaceholder(/price/i).fill('15');
    await page.getByTestId('guest-add-item-submit').click();

    const tacoRows = itemCards(page, 'Taco');
    await expect(tacoRows).toHaveCount(1, { timeout: 5000 });
    await expect(tacoRows.getByText('x3', { exact: true })).toBeVisible();

    // A split button on Taco (qty 3), none on Soda (qty 1)
    await expect(tacoRows.locator('[data-testid^="guest-split-btn-"]')).toHaveCount(1);
    await expect(sodaRows.locator('[data-testid^="guest-split-btn-"]')).toHaveCount(0);
  });
});
