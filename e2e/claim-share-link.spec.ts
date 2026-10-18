import { test, expect } from '@playwright/test';
import { resolve } from 'path';
import { login, users, createTestGroup } from './helpers';

const RECEIPT_IMAGE = resolve('e2e/test-receipt.png');

// #263: Share Link started the claim session with only the payer in it, and the creator's device
// wasn't anyone in it, so whoever opened the link first could join as the payer.
test('Share Link lists everyone typed and joins the creator as the payer', async ({ page, browser }) => {
  // The scan is a real extraction when the server under test uses a live AI provider (see
  // guest-upload-toggle.spec.ts for the timings behind this budget)
  test.setTimeout(180_000);

  await page.goto('/en/split');
  await page.getByTestId('guest-file-input').setInputFiles(RECEIPT_IMAGE);
  await expect(page.getByTestId('guest-people-step')).toBeVisible({ timeout: 150_000 });

  await page.getByTestId('person-input-0').fill('Dana');
  await page.getByTestId('add-person-btn').click();
  await page.getByTestId('person-input-1').fill('Pat');
  await page.getByLabel('Who paid the bill?').selectOption({ label: 'Pat' });
  await page.getByTestId('next-assign-btn').click();
  const share = page.getByTestId('share-for-claiming-btn');
  await share.scrollIntoViewIfNeeded();
  await share.click();
  await page.waitForURL(/\/en\/split\/[^/]+\/claim$/);

  // The creator's device already is Pat, the payer: no join form
  await expect(page.getByText('People in this session (2)')).toBeVisible();
  await expect(page.getByTestId('switch-person-1')).toContainText('Pat (you)');
  await expect(page.getByTestId('claim-join-form')).toHaveCount(0);

  // Someone else opening the link can join as Dana, but not as Pat
  const visitorContext = await browser.newContext();
  try {
    const visitor = await visitorContext.newPage();
    await visitor.goto(page.url());
    await expect(visitor.getByTestId('claim-join-form')).toBeVisible();
    await expect(visitor.getByTestId('rejoin-person-0')).toContainText('Dana');
    await expect(visitor.getByTestId('rejoin-person-1')).toHaveCount(0);
  } finally {
    await visitorContext.close();
  }
});

// A creator whose browser can't store their identity isn't joined at creation: they'd be locked
// out of the payer, unable to resume them or join under that name. They join by hand, as before.
test('without storage, Share Link leaves the payer free for the creator to join as', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });

  await page.goto('/en/split');
  await page.getByTestId('guest-file-input').setInputFiles(RECEIPT_IMAGE);
  await expect(page.getByTestId('guest-people-step')).toBeVisible({ timeout: 150_000 });
  await page.getByTestId('person-input-0').fill('Pat');
  await page.getByTestId('add-person-btn').click();
  await page.getByTestId('person-input-1').fill('Dana');
  await page.getByTestId('next-assign-btn').click();
  const share = page.getByTestId('share-for-claiming-btn');
  await share.scrollIntoViewIfNeeded();
  await share.click();
  await page.waitForURL(/\/en\/split\/[^/]+\/claim$/);

  await expect(page.getByText('People in this session (2)')).toBeVisible();
  const joinAsPat = page.getByTestId('rejoin-person-0');
  await expect(joinAsPat).toContainText('Pat');
  await joinAsPat.click();
  await expect(page.getByTestId('switch-person-0')).toContainText('Pat (you)');
});

// The group scan page's Share Link had the same gap: the signed-in member who shared it
// landed on the join form, as any visitor would
test("a group scan's Share Link joins the member who shared it", async ({ page }) => {
  test.setTimeout(180_000);
  const { groupId, dispose } = await createTestGroup(users.alice.email, users.alice.password, [], 'Share Link Scan');

  await login(page, users.alice.email, users.alice.password);
  await page.goto(`/en/groups/${groupId}/scan`);
  await page.getByTestId('scan-file-input').setInputFiles(RECEIPT_IMAGE);
  const share = page.getByTestId('group-share-claiming-btn');
  await expect(share).toBeEnabled({ timeout: 150_000 });
  await share.click();
  await page.waitForURL(/\/en\/split\/[^/]+\/claim$/);

  await expect(page.getByTestId('switch-person-0')).toContainText(`${users.alice.name} (you)`);
  await expect(page.getByTestId('claim-join-form')).toHaveCount(0);

  await dispose();
});
