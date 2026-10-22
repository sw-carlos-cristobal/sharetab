import { test, expect, request, type Page } from '@playwright/test';
import {
  users,
  login,
  createTestGroup,
  trpcMutation,
  trpcQuery,
  trpcResult,
  authedContext,
  joinGuestSession,
  FAKE_JPEG,
} from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// #267: destructive actions asked with the browser's own confirm box, which shows the page's
// address as its title, can't be translated or styled, and can't say what the action will do.
// They now ask in an in-page dialog. The browser box must never show.
function recordBrowserDialogs(page: Page) {
  const seen: string[] = [];
  page.on('dialog', (dialog) => {
    seen.push(dialog.message());
    void dialog.dismiss();
  });
  return seen;
}

async function uploadReceipt(owner: Awaited<ReturnType<typeof authedContext>>, groupId: string): Promise<string> {
  const uploadRes = await owner.post('/api/upload', {
    multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
  });
  const { receiptId } = await uploadRes.json();
  const processed = await (await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000)).json();
  expect(processed.result, JSON.stringify(processed)).toBeDefined();
  return receiptId;
}

test.describe('Confirmation dialogs', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  test('removing a placeholder asks in the page and names them; the icon buttons have names', async ({ page }) => {
    const browserDialogs = recordBrowserDialogs(page);
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Confirm Placeholder',
    );
    try {
      expect((await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Dana' })).ok()).toBe(true);
      await page.goto(`/en/groups/${groupId}/settings`);

      // Rename's buttons
      await page.getByRole('button', { name: 'Rename Dana' }).click();
      await expect(page.getByRole('button', { name: 'Save name' })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel renaming' }).click();

      const remove = page.getByRole('button', { name: 'Remove Dana' });
      await remove.click();
      const dialog = page.getByRole('alertdialog', { name: 'Remove Dana?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("can't be removed until they've settled up");

      // Cancel leaves Dana, and puts focus back on the button that opened it
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(remove).toBeFocused();
      await expect(page.getByText('Dana', { exact: true })).toBeVisible();

      await remove.click();
      await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(page.getByText('Dana', { exact: true })).toHaveCount(0);
      expect(browserDialogs).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test('archiving and deleting a group ask in the page first', async ({ page }) => {
    const browserDialogs = recordBrowserDialogs(page);
    const { groupId, dispose } = await createTestGroup(users.alice.email, users.alice.password, [], 'Confirm Group');
    try {
      await page.goto(`/en/groups/${groupId}/settings`);

      await page.getByRole('button', { name: 'Archive group' }).click();
      const archive = page.getByRole('alertdialog', { name: 'Archive this group?' });
      await expect(archive).toContainText('Everyone must be settled up first');
      await archive.getByRole('button', { name: 'Cancel' }).click();
      await expect(archive).toBeHidden();

      // Escape cancels too
      await page.getByRole('button', { name: 'Delete group' }).click();
      const del = page.getByRole('alertdialog', { name: 'Delete this group?' });
      await expect(del).toContainText("This can't be undone");
      await page.keyboard.press('Escape');
      await expect(del).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/groups/${groupId}/settings$`));

      await page.getByRole('button', { name: 'Delete group' }).click();
      await del.getByRole('button', { name: 'Delete group' }).click();
      await page.waitForURL(/\/en\/groups$/, { timeout: 10_000 });
      expect(browserDialogs).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test('deleting an expense asks in the page and names it', async ({ page }) => {
    const browserDialogs = recordBrowserDialogs(page);
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Confirm Expense',
    );
    try {
      const aliceId = memberIds[users.alice.email]!;
      const res = await trpcMutation(owner, 'expenses.create', {
        groupId,
        title: 'Ferry tickets',
        amount: 1200,
        currency: 'USD',
        paidById: aliceId,
        splitMode: 'EQUAL',
        shares: [{ userId: aliceId, amount: 1200 }],
      });
      expect(res.ok(), await res.text()).toBe(true);
      const created: { id: string } = (await res.json()).result.data.json;
      await page.goto(`/en/groups/${groupId}/expenses/${created.id}`);

      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Delete this expense?' });
      await expect(dialog).toContainText('Ferry tickets');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/expenses/${created.id}$`));

      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.waitForURL(new RegExp(`/groups/${groupId}$`), { timeout: 10_000 });
      await expect(page.getByText('Ferry tickets')).toHaveCount(0);
      expect(browserDialogs).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test('deleting a pending receipt asks in the page; the settings and delete buttons have names', async ({ page }) => {
    const browserDialogs = recordBrowserDialogs(page);
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Confirm Receipt',
    );
    try {
      const receiptId = await uploadReceipt(owner, groupId);
      expect((await trpcMutation(owner, 'receipts.saveForLater', { groupId, receiptId })).ok()).toBe(true);
      await page.goto(`/en/groups/${groupId}`);

      // Base UI gives a Button drawn as a link the button role
      await expect(page.getByRole('button', { name: 'Group Settings' })).toHaveAttribute(
        'href',
        `/en/groups/${groupId}/settings`,
      );

      await page.getByRole('button', { name: 'Delete receipt' }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Delete this receipt?' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByText('The Golden Fork')).toBeVisible();

      await page.getByRole('button', { name: 'Delete receipt' }).click();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.getByText('The Golden Fork')).toHaveCount(0);
      expect(browserDialogs).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test("removing a receipt's item asks in the page and names it", async ({ page }) => {
    const browserDialogs = recordBrowserDialogs(page);
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Confirm Receipt Item',
    );
    try {
      const receiptId = await uploadReceipt(owner, groupId);
      await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);

      await page.getByRole('button', { name: 'Edit Caesar Salad' }).click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();

      const remove = page.getByRole('button', { name: 'Remove Caesar Salad' });
      await remove.click();
      const dialog = page.getByRole('alertdialog', { name: 'Remove Caesar Salad?' });
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByText('Caesar Salad', { exact: true })).toBeVisible();

      await remove.click();
      await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(page.getByText('Caesar Salad', { exact: true })).toHaveCount(0);
      expect(browserDialogs).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test('deleting a split from My Splits asks in the page', async ({ page }) => {
    const browserDialogs = recordBrowserDialogs(page);
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const merchantName = `Confirm Split ${Date.now()}`;
    const created = await trpcMutation(ctx, 'guest.createSplit', {
      receiptData: { merchantName, subtotal: 1000, tax: 0, tip: 0, total: 1000, currency: 'USD' },
      items: [{ name: 'Pasta', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
      people: [{ name: 'Alice' }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
      paidByIndex: 0,
    });
    expect(created.ok(), await created.text()).toBe(true);
    await ctx.dispose();

    await page.goto('/en/splits');
    const card = page.locator('[data-slot="card"]', { hasText: merchantName });
    await card.getByRole('button', { name: 'Delete split' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Delete this split?' });
    await expect(dialog).toContainText('link stops working');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: 'Delete split' }).click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(card).toHaveCount(0);
    expect(browserDialogs).toEqual([]);
  });
});

test.describe('Confirmation dialogs on the claim page', () => {
  test('removing a person asks in the page and names them; the name editor buttons have names', async ({ page }) => {
    const browserDialogs = recordBrowserDialogs(page);
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Confirm Claim Cafe', subtotal: 1000, tax: 0, tip: 0, total: 1000, currency: 'USD' },
      items: [{ name: 'Tea', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
      creatorName: 'Ann',
      paidByName: 'Ann',
    });
    expect(createRes.ok(), await createRes.text()).toBe(true);
    const shareToken: string = (await createRes.json()).result.data.json.shareToken;
    await joinGuestSession(ctx, { token: shareToken, name: 'Bob' });

    await page.goto(`/en/split/${shareToken}/claim`);
    await page.getByTestId('claim-name-input').fill('Cat');
    await page.getByTestId('claim-join-btn').click();
    await expect(page.getByText('Cat (you)').first()).toBeVisible({ timeout: 15000 });

    await page.getByTestId('edit-person-0').click();
    await expect(page.getByRole('button', { name: 'Save name' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Ann made the session, so she is listed first, then Bob, then Cat
    await page.getByTestId('remove-person-1').click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove Bob?' });
    await expect(dialog).toContainText('go back to unclaimed');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await page.getByTestId('remove-person-1').click();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText('Person removed').first()).toBeVisible({ timeout: 15000 });
    const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
    expect((session.people as { name: string }[]).map((p) => p.name)).toEqual(['Ann', 'Cat']);
    expect(browserDialogs).toEqual([]);
    await ctx.dispose();
  });
});
