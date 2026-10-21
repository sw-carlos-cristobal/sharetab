import { test, expect } from '@playwright/test';
import { login, users, authedContext, trpcMutation, trpcQuery, trpcResult, createTestGroup } from './helpers';

test.use({ viewport: { width: 430, height: 932 } });

test.describe('Venmo settle from group balances', () => {
  test.beforeAll(async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(ctx, 'admin.setVenmoEnabled', { enabled: true });
    await trpcMutation(ctx, 'auth.updateProfile', { venmoUsername: 'alice-venmo' });
    await ctx.dispose();
  });

  test.afterAll(async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(ctx, 'admin.setVenmoEnabled', { enabled: false });
    await trpcMutation(ctx, 'auth.updateProfile', { venmoUsername: '' });
    await ctx.dispose();
  });

  test('venmo pay button on group debt row + auto-settle confirmation', async ({ page }) => {
    test.setTimeout(60_000);

    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Venmo Settle Group',
    );

    try {
      const aliceId = memberIds[users.alice.email];
      const bobId = memberIds[users.bob.email];

      // Create expense: Alice paid $20, split equally (Bob owes Alice $10)
      await trpcMutation(owner, 'expenses.create', {
        groupId,
        title: 'Lunch',
        amount: 2000,
        currency: 'USD',
        paidById: aliceId,
        splitMode: 'EQUAL',
        shares: [
          { userId: aliceId, amount: 1000 },
          { userId: bobId, amount: 1000 },
        ],
      });

      // Login as Bob (who owes Alice)
      await login(page, users.bob.email, users.bob.password);
      await page.goto(`/en/groups/${groupId}`);

      // Wait for the debt to show
      await expect(page.getByTestId('balances-title')).toBeVisible({ timeout: 15000 });
      // Venmo button should appear
      const venmoBtn = page.locator('[data-testid^="venmo-settle-"]').first();
      await expect(venmoBtn).toBeVisible({ timeout: 5000 });

      // Screenshot: Venmo pay button on group debt row
      await page.screenshot({ path: 'docs/screenshots/venmo-settle-group.png' });
    } finally {
      await dispose();
    }
  });

  // #267: the question used to be the browser's own confirm box
  test('asks in the page whether the Venmo payment went through, and records it', async ({ page }) => {
    test.setTimeout(60_000);

    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Venmo Confirm Group',
    );

    try {
      const aliceId = memberIds[users.alice.email];
      const bobId = memberIds[users.bob.email];
      await trpcMutation(owner, 'expenses.create', {
        groupId,
        title: 'Lunch',
        amount: 2000,
        currency: 'USD',
        paidById: aliceId,
        splitMode: 'EQUAL',
        shares: [
          { userId: aliceId, amount: 1000 },
          { userId: bobId, amount: 1000 },
        ],
      });

      const browserDialogs: string[] = [];
      page.on('dialog', (dialog) => {
        browserDialogs.push(dialog.message());
        void dialog.dismiss();
      });
      // The Venmo app or site isn't part of the test
      await page.addInitScript(() => {
        window.open = () => null;
      });
      await login(page, users.bob.email, users.bob.password);
      await page.goto(`/en/groups/${groupId}`);
      await page.locator('[data-testid^="venmo-settle-"]').first().click();

      // Asked once Bob is back from Venmo
      const dialog = page.getByRole('alertdialog', { name: 'Did you pay on Venmo?' });
      await expect(dialog).toContainText('$10.00', { timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Not yet' }).click();
      await expect(dialog).toBeHidden();
      const none = await trpcResult(await trpcQuery(owner, 'settlements.list', { groupId, limit: 10 }));
      expect(none.items).toHaveLength(0);

      await page.locator('[data-testid^="venmo-settle-"]').first().click();
      await dialog.getByRole('button', { name: 'Record payment' }).click({ timeout: 10_000 });
      await expect(page.locator('[data-testid^="venmo-settle-"]')).toHaveCount(0, { timeout: 10_000 });
      const recorded = await trpcResult(await trpcQuery(owner, 'settlements.list', { groupId, limit: 10 }));
      expect(recorded.items).toHaveLength(1);
      expect(recorded.items[0]).toMatchObject({ fromId: bobId, toId: aliceId, amount: 1000 });
      expect(browserDialogs).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test('venmo button hidden when payee has no venmo handle', async ({ page }) => {
    test.setTimeout(60_000);

    // Temporarily clear Alice's venmo handle
    const adminCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(adminCtx, 'auth.updateProfile', { venmoUsername: '' });

    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'No Venmo Group',
    );

    try {
      const aliceId = memberIds[users.alice.email];
      const bobId = memberIds[users.bob.email];

      await trpcMutation(owner, 'expenses.create', {
        groupId,
        title: 'Dinner',
        amount: 3000,
        currency: 'USD',
        paidById: aliceId,
        splitMode: 'EQUAL',
        shares: [
          { userId: aliceId, amount: 1500 },
          { userId: bobId, amount: 1500 },
        ],
      });

      await login(page, users.bob.email, users.bob.password);
      await page.goto(`/en/groups/${groupId}`);

      await expect(page.getByTestId('balances-title')).toBeVisible({ timeout: 15000 });

      // No venmo button (Alice has no handle)
      await expect(page.locator('[data-testid^="venmo-settle-"]')).not.toBeVisible();
    } finally {
      // Restore Alice's handle
      await trpcMutation(adminCtx, 'auth.updateProfile', { venmoUsername: 'alice-venmo' });
      await adminCtx.dispose();
      await dispose();
    }
  });
});
