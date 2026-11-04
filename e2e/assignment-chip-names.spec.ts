import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'path';
import { login, users, createTestGroup, trpcMutation, FAKE_JPEG } from './helpers';

const RECEIPT_IMAGE = resolve('e2e/test-receipt.png');
const LONG_NAMES = [
  'Christopher Alexander Montgomery-Whitfield Smith',
  'Christopher Alexander Montgomery-Whitfield Jones',
];

// The label of each person chip in the first item card (the chip also holds the
// avatar's initials, so read the label alone)
const chipLabels = (card: ReturnType<Page['locator']>) => card.getByTestId('chip-label');

// #277: both receipt-assignment screens cut each name at its first space, so
// "Bob" and "Bob Smith" both read "Bob" and an item could go to the wrong one
test.describe('Receipt assignment chips tell people with one first name apart', () => {
  test('group receipt: a placeholder Bob and Bob Smith get distinct chips', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Chip Names',
    );
    const placeholder = (await (await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Bob' })).json())
      .result?.data?.json;
    const uploadRes = await owner.post('/api/upload', {
      multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
    });
    const { receiptId } = await uploadRes.json();
    const processed = await (
      await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000)
    ).json();
    expect(processed.result, JSON.stringify(processed)).toBeDefined();

    try {
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
      const chip = (userId: string) => page.getByTestId(`member-toggle-${userId}`).first().getByTestId('chip-label');

      await expect(chip(memberIds[users.alice.email]!)).toHaveText('Alice');
      await expect(chip(memberIds[users.bob.email]!)).toHaveText('Bob Smith');
      await expect(chip(placeholder.id)).toHaveText('Bob');
      // The full name is a hover away even when the chip shows less
      await expect(chip(memberIds[users.alice.email]!)).toHaveAttribute('title', 'Alice Johnson');
    } finally {
      await dispose();
    }
  });

  test('Quick Split: people who share a first name get distinct chips, shown in full', async ({ page }) => {
    // A real extraction when the server under test uses a live AI provider (see quick-split-scan-again.spec.ts)
    test.setTimeout(180_000);
    await page.goto('/en/split');
    await page.getByTestId('guest-file-input').setInputFiles(RECEIPT_IMAGE);
    await expect(page.getByTestId('guest-people-step')).toBeVisible({ timeout: 150_000 });
    await page.getByTestId('person-input-0').fill('Bob');
    await page.getByTestId('add-person-btn').click();
    await page.getByTestId('person-input-1').fill('Bob Real');
    await page.getByTestId('add-person-btn').click();
    await page.getByTestId('person-input-2').fill('Ann Lee');
    // Long enough that cutting the chip to a fixed width would leave both the same
    for (const [i, name] of LONG_NAMES.entries()) {
      await page.getByTestId('add-person-btn').click();
      await page.getByTestId(`person-input-${3 + i}`).fill(name);
    }
    await page.getByTestId('next-assign-btn').click();
    await expect(page.getByTestId('guest-assign-step')).toBeVisible();

    const firstCard = page.locator('[data-testid^="guest-item-card-"]').first();
    await expect(chipLabels(firstCard)).toHaveText(['Bob', 'Bob Real', 'Ann', ...LONG_NAMES], { timeout: 15_000 });
    await expect(chipLabels(firstCard).nth(2)).toHaveAttribute('title', 'Ann Lee');
    // Hovering for the title doesn't work on a phone, so no label may be cut off,
    // and at phone width a long one wraps inside its chip instead of overflowing the card
    const overflowing = () =>
      firstCard.evaluate((card) => {
        const right = card.getBoundingClientRect().right;
        return [...card.querySelectorAll<HTMLElement>('[data-testid="chip-label"]')]
          .filter((l) => l.scrollWidth > l.clientWidth || l.getBoundingClientRect().right > right)
          .map((l) => l.textContent);
      });
    expect(await overflowing()).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    expect(await overflowing()).toEqual([]);
  });
});
