import { test, expect } from '@playwright/test';
import { login, users, createTestGroup, trpcMutation, trpcQuery, trpcResult, trpcError } from './helpers';

// #279: plain members saw owner/admin controls in group settings that the server
// refuses, and had no way to leave a group
test.describe('Group settings by role', () => {
  test('a plain member sees the details read-only, no owner controls, and Leave group', async ({ page }) => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Settings Member View',
    );
    await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Dave' });
    try {
      await login(page, users.bob.email, users.bob.password);
      await page.goto(`/en/groups/${groupId}/settings`);

      await expect(page.getByLabel('Name')).toHaveValue('Settings Member View');
      await expect(page.getByLabel('Name')).toBeDisabled();
      await expect(page.getByLabel('Currency')).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
      // Adding, renaming and removing placeholders
      await expect(page.getByText('Add Member', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Dave')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Archive group/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Delete group/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Leave group/ })).toBeVisible();
    } finally {
      await dispose();
    }
  });

  test('the owner keeps every control and has no Leave group', async ({ page }) => {
    const { groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Settings Owner View',
    );
    try {
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/settings`);

      await expect(page.getByLabel('Name')).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
      await expect(page.getByText('Add Member', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /Archive group/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Delete group/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Leave group/ })).toHaveCount(0);
    } finally {
      await dispose();
    }
  });

  test('a settled-up member leaves the group and it drops off their list', async ({ page }) => {
    const { groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Settings Leave Test',
    );
    try {
      await login(page, users.bob.email, users.bob.password);
      await page.goto(`/en/groups/${groupId}/settings`);
      page.on('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: /Leave group/ }).click();

      await page.waitForURL(/\/en\/groups$/, { timeout: 10_000 });
      await page.getByPlaceholder('Search groups...').fill('Settings Leave Test');
      await expect(page.getByText('Settings Leave Test')).toHaveCount(0);
    } finally {
      await dispose();
    }
  });

  test('a member who owes money is told to settle up first, and stays', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Settings Leave Owing',
    );
    const aliceId = memberIds[users.alice.email]!;
    const bobId = memberIds[users.bob.email]!;
    await trpcMutation(owner, 'expenses.create', {
      groupId,
      title: 'Bob owes half',
      amount: 1000,
      paidById: aliceId,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 500 },
        { userId: bobId, amount: 500 },
      ],
    });
    try {
      await login(page, users.bob.email, users.bob.password);
      await page.goto(`/en/groups/${groupId}/settings`);
      page.on('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: /Leave group/ }).click();

      await expect(
        page.getByText('You still owe or are owed money in this group. Settle up before you leave.'),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/groups/${groupId}/settings$`));
    } finally {
      await dispose();
    }
  });

  test("the owner can't leave through the API either", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Settings Owner Leave API',
    );
    try {
      const err = await trpcError(
        await trpcMutation(owner, 'groups.removeMember', { groupId, userId: memberIds[users.alice.email] }),
      );
      expect(err?.data?.code).toBe('FORBIDDEN');
      expect(err?.message).toBe(
        "The group's owner can't leave it. Transfer ownership to another member first, or delete the group if nobody needs it.",
      );
    } finally {
      await dispose();
    }
  });
});

// #309: an owner had no way to hand a group over, so they couldn't leave one other
// people still use
test.describe('Transferring ownership', () => {
  test('the owner hands the group to a member, then can leave it', async ({ page }) => {
    const { groupId, memberContexts, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Transfer Ownership UI',
    );
    const bob = memberContexts[0]!;
    try {
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/settings`);
      await page.getByRole('button', { name: /Transfer ownership/ }).click();
      await page.getByLabel('Hand over to').selectOption({ label: users.bob.name });
      await expect(
        page.getByText(`${users.bob.name} will own this group, and you'll become a regular member.`),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Transfer', exact: true }).click();

      await expect(page.getByText(`${users.bob.name} now owns this group`)).toBeVisible();
      // Alice now sees the page as a plain member does
      await expect(page.getByRole('button', { name: /Delete group/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Transfer ownership/ })).toHaveCount(0);
      await expect(page.getByLabel('Name')).toBeDisabled();
      const detail = await trpcResult(await trpcQuery(bob, 'groups.get', { groupId }));
      const roles = Object.fromEntries(
        detail.members.map((m: { user: { id: string }; role: string }) => [m.user.id, m.role]),
      );
      expect(roles).toEqual({ [memberIds[users.alice.email]!]: 'MEMBER', [memberIds[users.bob.email]!]: 'OWNER' });

      page.on('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: /Leave group/ }).click();
      await page.waitForURL(/\/en\/groups$/, { timeout: 10_000 });
    } finally {
      // Only Bob can delete it now
      await trpcMutation(bob, 'groups.delete', { groupId });
      await dispose();
    }
  });

  test('offers only the other members with an account', async ({ page }) => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Transfer Ownership Candidates',
    );
    await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Dave' });
    try {
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/settings`);
      await page.getByRole('button', { name: /Transfer ownership/ }).click();
      await expect(page.getByLabel('Hand over to').locator('option')).toHaveText(['Choose a member', users.bob.name]);
    } finally {
      await dispose();
    }
  });

  test('is unavailable while nobody else in the group has an account', async ({ page }) => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Transfer Ownership Nobody',
    );
    await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Dave' });
    try {
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/settings`);
      await expect(
        page.getByText("Nobody else in this group has an account yet, so there's nobody to hand it to.", {
          exact: false,
        }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /Transfer ownership/ })).toBeDisabled();
    } finally {
      await dispose();
    }
  });

  test("a member can't take ownership, and a placeholder can't be given it", async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Transfer Ownership API',
    );
    const dave = (await (await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Dave' })).json()).result
      ?.data?.json?.id as string;
    try {
      const byMember = await trpcError(
        await trpcMutation(memberContexts[0]!, 'groups.transferOwnership', {
          groupId,
          newOwnerId: memberIds[users.bob.email],
        }),
      );
      expect(byMember?.data?.code).toBe('FORBIDDEN');
      expect(byMember?.message).toBe('Only the owner can transfer ownership');

      const toPlaceholder = await trpcError(
        await trpcMutation(owner, 'groups.transferOwnership', { groupId, newOwnerId: dave }),
      );
      expect(toPlaceholder?.data?.code).toBe('BAD_REQUEST');
      expect(toPlaceholder?.message).toBe('Only a member with an account can own a group');
    } finally {
      await dispose();
    }
  });
});
