import { test, expect } from '@playwright/test';
import { users, login, trpcMutation, createTestGroup } from './helpers';

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
    await page.goto('/en/invite/not-a-real-token');
    await expect(page.getByText('This invite link is invalid, expired, or already used.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept Invite' })).toHaveCount(0);
    await expect(page.getByText('Go to Dashboard')).toBeVisible();
  });
});
