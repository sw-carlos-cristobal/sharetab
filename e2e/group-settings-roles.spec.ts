import { test, expect } from '@playwright/test';
import { login, users, createTestGroup, trpcMutation, trpcError } from './helpers';

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
      expect(err?.message).toBe("The group's owner can't leave it. Delete the group instead if nobody needs it.");
    } finally {
      await dispose();
    }
  });
});
