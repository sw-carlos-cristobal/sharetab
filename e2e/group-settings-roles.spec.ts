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
      await page.getByRole('button', { name: /Leave group/ }).click();
      await page
        .getByRole('alertdialog', { name: 'Leave this group?' })
        .getByRole('button', { name: 'Leave group' })
        .click();

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
      await page.getByRole('button', { name: /Leave group/ }).click();
      await page
        .getByRole('alertdialog', { name: 'Leave this group?' })
        .getByRole('button', { name: 'Leave group' })
        .click();

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

      await page.getByRole('button', { name: /Leave group/ }).click();
      await page
        .getByRole('alertdialog', { name: 'Leave this group?' })
        .getByRole('button', { name: 'Leave group' })
        .click();
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

// #342: nothing could make anyone an admin, so every owner-or-admin action was the owner's alone
test.describe('Group admins', () => {
  // An expense only Alice is in, so deleting it or not leaves everyone settled up
  async function addAliceExpense(ctx: Parameters<typeof trpcMutation>[0], groupId: string, aliceId: string) {
    const res = await trpcMutation(ctx, 'expenses.create', {
      groupId,
      title: 'Alice alone',
      amount: 1000,
      paidById: aliceId,
      splitMode: 'EXACT',
      shares: [{ userId: aliceId, amount: 1000 }],
    });
    return (await res.json()).result?.data?.json?.id as string;
  }

  test('the owner makes a member an admin, who can act for the group until the role is taken away', async ({
    page,
  }) => {
    const { owner, groupId, memberContexts, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Group Admins UI',
    );
    const bob = memberContexts[0]!;
    const aliceId = memberIds[users.alice.email]!;
    try {
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/settings`);
      const bobRow = page.getByRole('listitem').filter({ hasText: users.bob.name });
      await bobRow.getByRole('button', { name: 'Make admin' }).click();
      await expect(bobRow.getByText('Admin', { exact: true })).toBeVisible();
      await expect(bobRow.getByRole('button', { name: 'Remove admin' })).toBeVisible();
      // The owner's own row has no role button: ownership moves only by transferring it
      const aliceRow = page.getByRole('listitem').filter({ hasText: users.alice.name });
      await expect(aliceRow.getByText('Owner', { exact: true })).toBeVisible();
      await expect(aliceRow.getByRole('button')).toHaveCount(0);

      // Everyone in the group sees who the admins are (in the page, not the sidebar's Admin link)
      await page.goto(`/en/groups/${groupId}`);
      await expect(page.getByRole('main').getByText('Admin', { exact: true })).toBeVisible();

      // An admin can delete an expense someone else added and paid
      const first = await addAliceExpense(owner, groupId, aliceId);
      expect(await trpcError(await trpcMutation(bob, 'expenses.delete', { groupId, expenseId: first }))).toBeFalsy();

      // Taking the role away holds from Bob's next request
      await page.goto(`/en/groups/${groupId}/settings`);
      await bobRow.getByRole('button', { name: 'Remove admin' }).click();
      await expect(bobRow.getByRole('button', { name: 'Make admin' })).toBeVisible();
      await expect(bobRow.getByText('Admin', { exact: true })).toHaveCount(0);
      const second = await addAliceExpense(owner, groupId, aliceId);
      const refused = await trpcError(await trpcMutation(bob, 'expenses.delete', { groupId, expenseId: second }));
      expect(refused?.data?.code).toBe('FORBIDDEN');
    } finally {
      await dispose();
    }
  });

  test("an admin gets the admin controls in settings, but can't choose admins, hand the group over or delete it", async ({
    page,
  }) => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Group Admins Settings',
    );
    await trpcMutation(owner, 'groups.setRole', { groupId, userId: memberIds[users.bob.email], role: 'ADMIN' });
    try {
      await login(page, users.bob.email, users.bob.password);
      await page.goto(`/en/groups/${groupId}/settings`);
      await expect(page.getByLabel('Name')).toBeEnabled();
      await expect(page.getByText('Add Member', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /Archive group/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Make admin' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Transfer ownership/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Delete group/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Leave group/ })).toBeVisible();
    } finally {
      await dispose();
    }
  });

  test("an admin can't make admins, demote the owner or take the group, and a placeholder can't be an admin", async () => {
    const { owner, groupId, memberContexts, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [
        { email: users.bob.email, password: users.bob.password },
        { email: users.charlie.email, password: users.charlie.password },
      ],
      'Group Admins API',
    );
    const bob = memberContexts[0]!;
    const bobId = memberIds[users.bob.email]!;
    const dave = (await (await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Dave' })).json()).result
      ?.data?.json?.id as string;
    await trpcMutation(owner, 'groups.setRole', { groupId, userId: bobId, role: 'ADMIN' });
    try {
      const promote = await trpcError(
        await trpcMutation(bob, 'groups.setRole', { groupId, userId: memberIds[users.charlie.email], role: 'ADMIN' }),
      );
      expect(promote?.data?.code).toBe('FORBIDDEN');
      expect(promote?.message).toBe('Only the owner can make or remove admins');

      const demoteOwner = await trpcError(
        await trpcMutation(bob, 'groups.setRole', { groupId, userId: memberIds[users.alice.email], role: 'MEMBER' }),
      );
      expect(demoteOwner?.data?.code).toBe('FORBIDDEN');

      const transfer = await trpcError(
        await trpcMutation(bob, 'groups.transferOwnership', { groupId, newOwnerId: bobId }),
      );
      expect(transfer?.data?.code).toBe('FORBIDDEN');

      const placeholder = await trpcError(
        await trpcMutation(owner, 'groups.setRole', { groupId, userId: dave, role: 'ADMIN' }),
      );
      expect(placeholder?.data?.code).toBe('BAD_REQUEST');
      expect(placeholder?.message).toBe('Only a member with an account can be an admin');

      const detail = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
      const roles = Object.fromEntries(
        detail.members.map((m: { user: { id: string }; role: string }) => [m.user.id, m.role]),
      );
      expect(roles).toEqual({
        [memberIds[users.alice.email]!]: 'OWNER',
        [bobId]: 'ADMIN',
        [memberIds[users.charlie.email]!]: 'MEMBER',
        [dave]: 'MEMBER',
      });
    } finally {
      await dispose();
    }
  });
});
