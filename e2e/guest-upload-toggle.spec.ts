import { resolve } from 'path';
import { test, expect, request } from '@playwright/test';
import { login, users, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError, FAKE_JPEG } from './helpers';

// Runs in the serial project: disabling guest uploads is global state that
// would break the parallel guest-split specs, so every test re-enables it.
const BASE = process.env.BASE_URL || 'http://localhost:3001';
const RECEIPT_IMAGE = resolve('e2e/test-receipt.png');

async function setGuestUploads(enabled: boolean) {
  const admin = await authedContext(users.alice.email, users.alice.password);
  const res = await trpcMutation(admin, 'admin.setGuestUploadsEnabled', { enabled });
  expect(res.ok()).toBe(true);
  await admin.dispose();
}

function guestUpload(ctx: Awaited<ReturnType<typeof request.newContext>>) {
  return ctx.post('/api/upload?guest=true', {
    multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
  });
}

test.describe('Guest receipt uploads admin toggle', () => {
  test.afterEach(async () => {
    await setGuestUploads(true);
  });

  test('admin can turn guest uploads off and back on', async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto('/en/admin');

    const toggleBtn = page.getByTestId('guest-uploads-toggle-btn');
    await expect(toggleBtn).toBeVisible({ timeout: 15000 });
    await expect(toggleBtn).toContainText('Enabled');

    await toggleBtn.click();
    await expect(toggleBtn).toContainText('Disabled');
    await page.screenshot({ path: 'docs/screenshots/guest-uploads-admin-disabled.png' });

    await toggleBtn.click();
    await expect(toggleBtn).toContainText('Enabled');
  });

  test('anonymous visitors see a sign-in notice instead of the upload buttons', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await context.newPage();
    const quickSplitLink = page.getByRole('link', { name: 'Split without an account' });

    await page.goto('/en/login');
    await expect(quickSplitLink).toBeVisible();

    await setGuestUploads(false);

    await page.goto('/en/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(quickSplitLink).toHaveCount(0);

    await page.goto('/en/split');
    await expect(page.getByTestId('guest-uploads-disabled')).toBeVisible();
    await expect(page.getByTestId('guest-snap-upload')).toHaveCount(0);
    await page.screenshot({ path: 'docs/screenshots/guest-uploads-split-disabled.png' });

    await context.close();
  });

  test('turning uploads off after the page loaded swaps in the notice on the next upload', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await context.newPage();

    await page.goto('/en/split');
    await expect(page.getByTestId('guest-snap-upload')).toBeVisible();

    await setGuestUploads(false);
    await page.getByTestId('guest-file-input').setInputFiles(RECEIPT_IMAGE);

    await expect(page.getByTestId('guest-uploads-disabled')).toBeVisible();
    await expect(page.getByTestId('guest-snap-upload')).toHaveCount(0);

    await context.close();
  });

  test('turning uploads off before the AI scan runs shows the notice, not a raw error', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await context.newPage();
    // The upload succeeds; flip the switch just before the scan request reaches the server.
    await page.route('**/api/trpc/guest.processReceipt**', async (route) => {
      await setGuestUploads(false);
      await route.continue();
    });

    await page.goto('/en/split');
    await page.getByTestId('guest-file-input').setInputFiles(RECEIPT_IMAGE);

    await expect(page.getByTestId('guest-uploads-disabled')).toBeVisible();
    await expect(page.getByText('Guest receipt uploads are disabled')).toHaveCount(0);

    await context.close();
  });

  test('signed-in users can still use Quick Split while guest uploads are off', async ({ page }) => {
    await setGuestUploads(false);
    await login(page, users.alice.email, users.alice.password);

    await page.goto('/en/split');
    await expect(page.getByTestId('guest-snap-upload')).toBeVisible();
    await expect(page.getByTestId('guest-uploads-disabled')).toHaveCount(0);
  });

  test('API: anonymous upload and scan are refused, signed-in upload still works', async () => {
    await setGuestUploads(false);

    const anon = await request.newContext({ baseURL: BASE });
    const anonUpload = await guestUpload(anon);
    expect(anonUpload.status()).toBe(403);

    const status = await trpcResult(await trpcQuery(anon, 'guest.getUploadStatus'));
    expect(status).toEqual({ allowed: false });

    const alice = await authedContext(users.alice.email, users.alice.password);
    const aliceUpload = await guestUpload(alice);
    expect(aliceUpload.status()).toBe(200);
    const { receiptId } = (await aliceUpload.json()) as { receiptId: string };

    // A guest-path receipt exists, but an anonymous caller still can't spend AI on it.
    const err = await trpcError(await trpcMutation(anon, 'guest.processReceipt', { receiptId }));
    expect(err.data.code).toBe('FORBIDDEN');

    await anon.dispose();
    await alice.dispose();
  });
});
