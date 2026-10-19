import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'path';

const RECEIPT_IMAGE = resolve('e2e/test-receipt.png');

const itemCards = (page: Page) => page.locator('[data-testid^="guest-item-card-"]');

// The scan is a real extraction when the server under test uses a live AI provider (see
// guest-upload-toggle.spec.ts for the timings behind this budget), so these tests count the
// items they find rather than expecting the mock provider's list
async function scanToAssignStep(page: Page) {
  await page.getByTestId('guest-file-input').setInputFiles(RECEIPT_IMAGE);
  await expect(page.getByTestId('guest-people-step')).toBeVisible({ timeout: 150_000 });
  await page.getByTestId('person-input-0').fill('Pat');
  await page.getByTestId('next-assign-btn').click();
  await expect(page.getByTestId('guest-assign-step')).toBeVisible();
  await expect(itemCards(page).first()).toBeVisible({ timeout: 15_000 });
}

async function addItem(page: Page, name: string) {
  await page.getByTestId('guest-add-item-btn').click();
  await page.getByPlaceholder('Item name').fill(name);
  await page.getByPlaceholder('Price').fill('1.00');
  await page.getByTestId('guest-add-item-submit').click();
  await expect(page.getByText(name)).toBeVisible();
}

// #294: Quick Split loaded a scan's items only while its item list was empty, so going back and
// scanning another receipt kept the first receipt's items (and their assignments)
test('scanning another receipt after going back shows its items, not the first scan', async ({ page }) => {
  test.setTimeout(330_000);
  await page.goto('/en/split');
  await scanToAssignStep(page);
  const scanned = await itemCards(page).count();
  expect(scanned).toBeGreaterThan(0);

  await page.getByTestId('guest-split-all-btn').click();
  await addItem(page, 'Hand-added item');
  await expect(itemCards(page)).toHaveCount(scanned + 1);

  // Back to the people step, back to upload, and scan again
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByTestId('guest-people-step')).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await scanToAssignStep(page);

  await expect(page.getByText('Hand-added item')).toHaveCount(0);
  const rescanned = await itemCards(page).count();
  expect(rescanned).toBeGreaterThan(0);
  await expect(page.getByText(`Tap people to assign (0/${rescanned})`)).toBeVisible();
});

test('a rescan with corrections replaces the items with the new scan', async ({ page }) => {
  test.setTimeout(330_000);
  await page.goto('/en/split');
  await scanToAssignStep(page);
  await page.getByTestId('guest-split-all-btn').click();
  await addItem(page, 'Hand-added item');

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Rescan with corrections' }).click();
  await page.getByPlaceholder(/The total should be/).fill('There is one more item at $1.00');
  await page.getByRole('button', { name: 'Rescan', exact: true }).click();
  await expect(page.getByTestId('guest-people-step')).toBeVisible({ timeout: 150_000 });
  await page.getByTestId('next-assign-btn').click();

  await expect(page.getByTestId('guest-assign-step')).toBeVisible();
  await expect(itemCards(page).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Hand-added item')).toHaveCount(0);
  const rescanned = await itemCards(page).count();
  expect(rescanned).toBeGreaterThan(0);
  await expect(page.getByText(`Tap people to assign (0/${rescanned})`)).toBeVisible();
});
