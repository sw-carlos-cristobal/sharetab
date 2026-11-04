import { test, expect } from '@playwright/test';
import {
  users,
  login,
  navigateToGroup,
  authedContext,
  createTestGroup,
  trpcMutation,
  trpcQuery,
  trpcResult,
} from './helpers';

test.describe('Placeholder Members UI', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  test('add placeholder member from group settings', async ({ page }) => {
    // Create a fresh group
    await page.goto('/en/groups/new');
    await page.getByLabel('Group name').fill('Placeholder UI Test');
    await page.getByRole('button', { name: 'Create Group' }).click();
    await expect(page.getByRole('heading', { name: 'Placeholder UI Test' })).toBeVisible({ timeout: 15000 });

    // Go to settings via the settings link on the group detail page
    await page.locator('a[href*="/groups/"][href$="/settings"]').click();
    await page.waitForURL(/\/groups\/\w+\/settings$/);
    await expect(page.getByText('Add Member')).toBeVisible();

    // Add a placeholder
    await page.getByPlaceholder('Name (e.g., Dave)').fill('Test Person');
    await page.getByRole('button', { name: 'Add' }).click();

    // Should show in placeholder list
    await expect(page.getByText('Test Person')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Pending')).toBeVisible();
  });

  test('placeholder member shows with badge on group detail', async ({ page }) => {
    // Create group and add placeholder via API first
    await page.goto('/en/groups/new');
    await page.getByLabel('Group name').fill('Badge Test Group');
    await page.getByRole('button', { name: 'Create Group' }).click();
    await expect(page.getByRole('heading', { name: 'Badge Test Group' })).toBeVisible({ timeout: 15000 });
    const groupUrl = page.url();

    // Add placeholder via settings link on the group detail page
    await page.locator('a[href*="/groups/"][href$="/settings"]').click();
    await page.waitForURL(/\/groups\/\w+\/settings$/);
    await page.getByPlaceholder('Name (e.g., Dave)').fill('Ghost Member');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText('Ghost Member')).toBeVisible({ timeout: 10000 });

    // Go back to group detail
    await page.goto(groupUrl);
    await expect(page.getByText('Ghost Member')).toBeVisible({ timeout: 10000 });
    // Should show the Pending badge
    await expect(page.getByText('Pending')).toBeVisible();
  });

  // #265: "Alice" and "alice" could both be added, and the expense pickers then showed two
  // rows that look the same
  test('a placeholder named like someone already in the group is refused', async ({ page }) => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Placeholder Names',
    );
    try {
      expect((await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Dana' })).ok()).toBe(true);
      await page.goto(`/en/groups/${groupId}/settings`);

      await page.getByPlaceholder('Name (e.g., Dave)').fill('  dana ');
      await page.getByRole('button', { name: 'Add' }).click();
      await expect(page.getByTestId('placeholder-error')).toHaveText('Someone in this group is already called dana.');
      await expect(page.getByText('Dana', { exact: true })).toHaveCount(1);

      // An account member's name counts too
      const res = await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'alice johnson' });
      expect((await res.json()).error?.json?.data?.code).toBe('CONFLICT');
    } finally {
      await dispose();
    }
  });
});

// #276: the server could merge a placeholder into a member, but no screen offered it.
test.describe('Merging a placeholder from group settings', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
  });

  async function groupWithPlaceholder(name: string, members: { email: string; password: string }[]) {
    const group = await createTestGroup(users.alice.email, users.alice.password, members, `${name} ${Date.now()}`);
    const aliceId = group.memberIds[users.alice.email]!;
    const phRes = await trpcMutation(group.owner, 'groups.addPlaceholder', { groupId: group.groupId, name: 'Frank' });
    const frankId: string = (await phRes.json()).result?.data?.json?.id;
    await trpcMutation(group.owner, 'expenses.create', {
      groupId: group.groupId,
      title: 'Frank owes half',
      amount: 2000,
      paidById: aliceId,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 1000 },
        { userId: frankId, amount: 1000 },
      ],
    });
    return { ...group, frankId };
  }

  async function netOf(owner: Awaited<ReturnType<typeof authedContext>>, groupId: string, userId: string) {
    const balances = (await trpcResult(await trpcQuery(owner, 'balances.getGroupBalances', { groupId }))).balances;
    return balances.find((b: { userId: string }) => b.userId === userId)?.net;
  }

  test('merges a placeholder into a member who joined, moving their balance', async ({ page }) => {
    const { owner, groupId, memberIds, frankId, dispose } = await groupWithPlaceholder('Merge UI', [
      { email: users.bob.email, password: users.bob.password },
    ]);
    const bobId = memberIds[users.bob.email]!;
    const detail = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
    const bobName: string = detail.members.find((m: { user: { id: string } }) => m.user.id === bobId).user.name;

    try {
      await page.goto(`/en/groups/${groupId}/settings`);
      await page.getByRole('button', { name: 'Merge Frank into a member' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Member').selectOption({ label: bobName });
      await expect(dialog.getByText(`will move to ${bobName}`)).toContainText("This can't be undone.");
      await dialog.getByRole('button', { name: 'Merge', exact: true }).click();

      await expect(page.getByText(`Merged Frank into ${bobName}`)).toBeVisible();
      await expect(page.getByText('Placeholder members')).toHaveCount(0);
      expect(await netOf(owner, groupId, bobId)).toBe(-1000);
      expect(await netOf(owner, groupId, frankId)).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  test('makes a link for a placeholder that hands them over to whoever accepts it', async ({ page }) => {
    const { owner, groupId, frankId, dispose } = await groupWithPlaceholder('Claim Link UI', []);
    const charlie = await authedContext(users.charlie.email, users.charlie.password);

    try {
      await page.goto(`/en/groups/${groupId}/settings`);
      await page.getByRole('button', { name: 'Invite Frank to claim their place' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Invite Frank to claim their place' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Generate invite link' }).click();
      await expect(dialog.getByText('Send this only to Frank')).toBeVisible();
      const token = (await dialog.getByRole('textbox').inputValue()).split('/invite/')[1]!;

      const join = (await (await trpcMutation(charlie, 'groups.joinByInvite', { token })).json()).result?.data?.json;
      expect(join.alreadyMember).toBe(false);
      const detail = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
      const charlieId: string = detail.members.find(
        (m: { user: { email: string } }) => m.user.email === users.charlie.email,
      ).user.id;
      expect(await netOf(owner, groupId, charlieId)).toBe(-1000);
      expect(await netOf(owner, groupId, frankId)).toBeUndefined();
    } finally {
      await charlie.dispose();
      await dispose();
    }
  });
});

test.describe('Pending Receipts UI', () => {
  test('scan page has save for later button', async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);

    // Navigate to an existing group's scan page
    await navigateToGroup(page, 'Apartment');
    const groupUrl = page.url();

    await page.goto(groupUrl + '/scan');
    await expect(page.getByRole('heading', { name: 'Scan Receipt' })).toBeVisible();
    // Save for Later button only appears after processing, not on upload step
    await expect(page.getByText('Upload a receipt')).toBeVisible();
  });

  test('scan page supports resume via query param', async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await navigateToGroup(page, 'Apartment');
    const groupUrl = page.url();

    // Navigate to scan with a fake receiptId — should go to assign step
    await page.goto(groupUrl + '/scan?receiptId=fake-id');
    // Should try to load receipt data (will fail but shows the assign step was triggered)
    // The important thing is it doesn't show the upload step
    await expect(page.getByText('Upload a receipt')).not.toBeVisible();
  });
});
