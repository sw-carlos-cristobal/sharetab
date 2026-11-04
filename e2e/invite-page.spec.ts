import { test, expect } from '@playwright/test';
import { users, login, authedContext, trpcMutation, trpcQuery, trpcResult, createTestGroup } from './helpers';

test.describe('Invite page (2.4)', () => {
  test('2.4.9 — shows the group, inviter and member count, then joins', async ({ page }) => {
    const groupName = `Invite Page ${Date.now()}`;
    const { owner, groupId, dispose } = await createTestGroup(users.alice.email, users.alice.password, [], groupName);
    const invRes = await trpcMutation(owner, 'groups.createInvite', { groupId });
    const token = (await invRes.json()).result?.data?.json?.token;

    try {
      await login(page, users.charlie.email, users.charlie.password);
      await page.goto(`/en/invite/${token}`);
      await expect(page.locator('p', { hasText: 'invited you to join' })).toHaveText(
        `${users.alice.name} invited you to join ${groupName} (1 member)`,
      );
      await page.getByRole('button', { name: 'Accept Invite' }).click();
      await page.waitForURL(new RegExp(`/groups/${groupId}$`), { timeout: 15000 });
    } finally {
      await dispose();
    }
  });

  test('2.4.10 — an invalid invite shows a message instead of the Accept button', async ({ page }) => {
    await login(page, users.charlie.email, users.charlie.password);
    // An unknown token, and one too long to be a token at all
    for (const token of ['not-a-real-token', 'x'.repeat(65)]) {
      await page.goto(`/en/invite/${token}`);
      await expect(page.getByText('This invite link is invalid, expired, or already used.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Accept Invite' })).toHaveCount(0);
      await expect(page.getByText('Go to Dashboard')).toBeVisible();
    }
  });

  test('2.4.11 — an invite used by someone else after the page loaded shows the invalid message', async ({ page }) => {
    const groupName = `Invite Used ${Date.now()}`;
    const { owner, groupId, dispose } = await createTestGroup(users.alice.email, users.alice.password, [], groupName);
    const invRes = await trpcMutation(owner, 'groups.createInvite', { groupId });
    const token = (await invRes.json()).result?.data?.json?.token;
    const bob = await authedContext(users.bob.email, users.bob.password);

    try {
      await login(page, users.charlie.email, users.charlie.password);
      await page.goto(`/en/invite/${token}`);
      await expect(page.locator('p', { hasText: 'invited you to join' })).toBeVisible();

      const bobJoin = await trpcMutation(bob, 'groups.joinByInvite', { token });
      expect((await bobJoin.json()).result?.data?.json?.alreadyMember).toBe(false);
      await page.getByRole('button', { name: 'Accept Invite' }).click();

      await expect(page.getByText('This invite link is invalid, expired, or already used.')).toBeVisible();
      await expect(page.getByText('Invalid or expired invite', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Accept Invite' })).toHaveCount(0);
    } finally {
      await bob.dispose();
      await dispose();
    }
  });

  // #276: accepting a link made for a placeholder takes over their expenses and payments.
  test('2.4.12 — a link made for a placeholder says whose expenses the person takes over', async ({ page }) => {
    const groupName = `Invite Claim ${Date.now()}`;
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      groupName,
    );
    const aliceId = memberIds[users.alice.email]!;
    const phRes = await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Gus' });
    const gusId = (await phRes.json()).result?.data?.json?.id;
    await trpcMutation(owner, 'expenses.create', {
      groupId,
      title: 'Gus owes half',
      amount: 2000,
      paidById: aliceId,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 1000 },
        { userId: gusId, amount: 1000 },
      ],
    });
    const invRes = await trpcMutation(owner, 'groups.createInvite', { groupId, placeholderUserId: gusId });
    const token = (await invRes.json()).result?.data?.json?.token;

    try {
      await login(page, users.charlie.email, users.charlie.password);
      await page.goto(`/en/invite/${token}`);
      await expect(page.locator('p', { hasText: 'Accepting makes' })).toHaveText(
        "Accepting makes Gus's expenses and payments in this group yours.",
      );
      await page.getByRole('button', { name: 'Accept Invite' }).click();
      await page.waitForURL(new RegExp(`/groups/${groupId}$`), { timeout: 15000 });

      const balances = (await trpcResult(await trpcQuery(owner, 'balances.getGroupBalances', { groupId }))).balances;
      expect(balances.map((b: { userId: string; net: number }) => b.net).sort()).toEqual([-1000, 1000]);
      expect(balances.find((b: { userId: string }) => b.userId === gusId)).toBeUndefined();
    } finally {
      await dispose();
    }
  });
});
