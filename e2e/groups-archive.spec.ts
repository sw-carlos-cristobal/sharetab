import { test, expect } from '@playwright/test';
import { login, users, authedContext, createTestGroup, trpcMutation, trpcError, FAKE_JPEG } from './helpers';

test.describe('Group Archiving', () => {
  // ── API-level tests ──────────────────────────────────────

  test.describe('API', () => {
    test('owner can archive a group', async () => {
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive API Test',
      );

      const res = await trpcMutation(owner, 'groups.archive', { groupId });
      const body = await res.json();
      expect(body.result?.data?.json?.archivedAt).toBeTruthy();

      await dispose();
    });

    test('member cannot archive a group', async () => {
      const { groupId, memberContexts, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        'Archive Forbidden Test',
      );

      const res = await trpcMutation(memberContexts[0]!, 'groups.archive', { groupId });
      const body = await res.json();
      expect(body.error).toBeDefined();

      await dispose();
    });

    test('archived group excluded from groups.list', async () => {
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive List Test',
      );

      await trpcMutation(owner, 'groups.archive', { groupId });

      const listRes = await owner.get(
        `/api/trpc/groups.list?batch=1&input=${encodeURIComponent(JSON.stringify({ '0': { json: null, meta: { values: ['undefined'], v: 1 } } }))}`,
      );
      const listBody = await listRes.json();
      const groups = listBody[0]?.result?.data?.json ?? [];
      const found = groups.find((g: { id: string }) => g.id === groupId);
      expect(found).toBeUndefined();

      await dispose();
    });

    test('archived group appears in groups.listArchived', async () => {
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive ListArchived Test',
      );

      await trpcMutation(owner, 'groups.archive', { groupId });

      const listRes = await owner.get(
        `/api/trpc/groups.listArchived?batch=1&input=${encodeURIComponent(JSON.stringify({ '0': { json: null, meta: { values: ['undefined'], v: 1 } } }))}`,
      );
      const listBody = await listRes.json();
      const groups = listBody[0]?.result?.data?.json ?? [];
      const found = groups.find((g: { id: string }) => g.id === groupId);
      expect(found).toBeDefined();
      expect(found.archivedAt).toBeTruthy();

      await dispose();
    });

    test('owner can unarchive a group', async () => {
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Unarchive API Test',
      );

      await trpcMutation(owner, 'groups.archive', { groupId });
      const res = await trpcMutation(owner, 'groups.unarchive', { groupId });
      const body = await res.json();
      expect(body.result?.data?.json?.archivedAt).toBeNull();

      await dispose();
    });

    test('member cannot unarchive a group', async () => {
      const { owner, groupId, memberContexts, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        'Unarchive Forbidden Test',
      );

      await trpcMutation(owner, 'groups.archive', { groupId });

      const res = await trpcMutation(memberContexts[0]!, 'groups.unarchive', { groupId });
      const body = await res.json();
      expect(body.error).toBeDefined();

      await dispose();
    });

    test('cannot create expense on archived group', async () => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Expense Block',
      );

      await trpcMutation(owner, 'groups.archive', { groupId });

      const res = await trpcMutation(owner, 'expenses.create', {
        groupId,
        title: 'Should Fail',
        amount: 1000,
        paidById: memberIds[users.alice.email],
        splitMode: 'EQUAL',
        shares: [{ userId: memberIds[users.alice.email], amount: 1000 }],
      });
      const error = await trpcError(res);
      expect(error?.data?.code).toBe('BAD_REQUEST');
      expect(error?.message).toContain('archived');

      await dispose();
    });

    test('cannot create settlement on archived group', async () => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        'Archive Settle Block',
      );

      await trpcMutation(owner, 'groups.archive', { groupId });

      const res = await trpcMutation(owner, 'settlements.create', {
        groupId,
        fromId: memberIds[users.alice.email],
        toId: memberIds[users.bob.email],
        amount: 500,
      });
      const error = await trpcError(res);
      expect(error?.data?.code).toBe('BAD_REQUEST');
      expect(error?.message).toContain('archived');

      await dispose();
    });

    // #275: an archived group refuses settlements and was left off the
    // dashboard, so archiving it with an open balance hid the debt.
    test('cannot archive a group until everyone is settled up', async () => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        'Archive Unsettled Block',
      );
      const aliceId = memberIds[users.alice.email];
      const bobId = memberIds[users.bob.email];
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

      const error = await trpcError(await trpcMutation(owner, 'groups.archive', { groupId }));
      expect(error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(error?.message).toBe('This group still has unsettled balances. Settle up before archiving it.');

      // Once Bob pays Alice back, the group can be archived.
      await trpcMutation(owner, 'settlements.create', { groupId, fromId: bobId, toId: aliceId, amount: 500 });
      const res = await trpcMutation(owner, 'groups.archive', { groupId });
      expect((await res.json()).result?.data?.json?.archivedAt).toBeTruthy();

      await dispose();
    });

    // Settlements need both people to be members, so "settle up" alone can't
    // clear a balance with someone who has left.
    test('archive refusal says so when someone who left still has a balance', async () => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        'Archive Departed Member',
      );
      const aliceId = memberIds[users.alice.email];
      const bobId = memberIds[users.bob.email];
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
      // Bob is removed while still owing Alice (he can't leave on his own with a balance, #279).
      await trpcMutation(owner, 'groups.removeMember', { groupId, userId: bobId });

      const error = await trpcError(await trpcMutation(owner, 'groups.archive', { groupId }));
      expect(error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(error?.message).toBe(
        "Someone who is no longer in this group still owes or is owed money, so it can't be archived. Invite them back to settle up, or edit the expenses they're in.",
      );

      await dispose();
    });

    test('cannot update expense on archived group', async () => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Edit Block',
      );

      // Create expense before archiving
      const expRes = await trpcMutation(owner, 'expenses.create', {
        groupId,
        title: 'Before Archive',
        amount: 1000,
        paidById: memberIds[users.alice.email],
        splitMode: 'EQUAL',
        shares: [{ userId: memberIds[users.alice.email], amount: 1000 }],
      });
      const expense = (await expRes.json()).result?.data?.json;

      await trpcMutation(owner, 'groups.archive', { groupId });

      const res = await trpcMutation(owner, 'expenses.update', {
        groupId,
        expenseId: expense.id,
        title: 'Should Fail',
      });
      const error = await trpcError(res);
      expect(error?.data?.code).toBe('BAD_REQUEST');
      expect(error?.message).toContain('archived');

      await dispose();
    });
  });

  // ── UI tests ─────────────────────────────────────────────

  test.describe('UI', () => {
    test('archive button appears in group settings', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive UI Settings',
      );

      await page.goto(`/en/groups/${groupId}/settings`);
      await expect(page.getByRole('button', { name: /Archive group/ })).toBeVisible();

      await dispose();
    });

    test('archiving a group redirects to groups list', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Redirect Test',
      );

      await page.goto(`/en/groups/${groupId}/settings`);
      await page.getByRole('button', { name: /Archive group/ }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Archive group' }).click();
      await page.waitForURL('**/groups', { timeout: 10000 });

      await dispose();
    });

    test('archived group not visible in active groups list', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Hidden Test',
      );

      await trpcMutation(owner, 'groups.archive', { groupId });

      await page.goto('/en/groups');
      await page.getByPlaceholder('Search groups...').fill('Archive Hidden Test');
      // Should not appear in active list
      await expect(page.getByText('Archive Hidden Test')).not.toBeVisible();

      await dispose();
    });

    test('archived group visible after clicking Archived button', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Toggle Test',
      );

      await trpcMutation(owner, 'groups.archive', { groupId });

      await page.goto('/en/groups');
      await page.getByRole('button', { name: /Archived/ }).click();
      await page.getByPlaceholder('Search groups...').fill('Archive Toggle Test');
      await expect(page.getByText('Archive Toggle Test').first()).toBeVisible();

      await dispose();
    });

    test('archived group detail shows archived banner', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Banner Test',
      );

      await trpcMutation(owner, 'groups.archive', { groupId });

      await page.goto(`/en/groups/${groupId}`);
      await expect(page.getByText('This group is archived')).toBeVisible();
      // Add Expense button should be hidden
      await expect(page.getByRole('button', { name: 'Add Expense' })).not.toBeVisible();

      await dispose();
    });

    test('unarchive from settings restores group to active list', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);

      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Unarchive UI Test',
      );

      await trpcMutation(owner, 'groups.archive', { groupId });

      // Go to settings and unarchive
      await page.goto(`/en/groups/${groupId}/settings`);
      await expect(page.getByText('This group is archived')).toBeVisible();
      await page.getByRole('button', { name: /Unarchive/ }).click();

      // Banner should disappear
      await expect(page.getByText('This group is archived')).not.toBeVisible({ timeout: 5000 });

      // Should appear back in active groups list
      await page.goto('/en/groups');
      await page.getByPlaceholder('Search groups...').fill('Unarchive UI Test');
      await expect(page.getByText('Unarchive UI Test').first()).toBeVisible();

      await dispose();
    });
  });

  // #290: an archived group refuses these actions, so its pages shouldn't offer
  // them only for the request to fail after the user acts.
  test.describe('UI: actions an archived group refuses', () => {
    async function createExpense(owner: Awaited<ReturnType<typeof authedContext>>, groupId: string, userId: string) {
      const res = await trpcMutation(owner, 'expenses.create', {
        groupId,
        title: 'Before Archive',
        amount: 1000,
        paidById: userId,
        splitMode: 'EQUAL',
        shares: [{ userId, amount: 1000 }],
      });
      return (await mutationResult(res)).id as string;
    }

    // A mutation's result, failing the test with the server's answer if it was refused
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function mutationResult(res: Awaited<ReturnType<typeof trpcMutation>>): Promise<any> {
      const body = await res.json();
      if (!body.result) throw new Error(`mutation failed (${res.status()}): ${JSON.stringify(body)}`);
      return body.result.data?.json;
    }

    test('group page lists a saved receipt without the link to finish it, and still deletes it', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Saved Receipt',
      );
      const uploadRes = await owner.post('/api/upload', {
        multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
      });
      const { receiptId } = await uploadRes.json();
      await mutationResult(await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000));
      await mutationResult(await trpcMutation(owner, 'receipts.saveForLater', { groupId, receiptId }));
      await trpcMutation(owner, 'groups.archive', { groupId });

      await page.goto(`/en/groups/${groupId}`);
      await expect(page.getByText('This group is archived')).toBeVisible();
      await expect(page.getByText('The Golden Fork')).toBeVisible();
      await expect(page.locator(`a[href*="receiptId=${receiptId}"]`)).toHaveCount(0);
      // The group has no expenses, but an archived group can't take its first one
      await expect(page.getByText('No expenses yet.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add your first expense' })).toHaveCount(0);

      await page.locator('[data-slot="card"]', { hasText: 'The Golden Fork' }).getByRole('button').click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.getByText('The Golden Fork')).toHaveCount(0);

      await dispose();
    });

    test('expense page shows no Edit or Delete in an archived group', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Expense Page',
      );
      const expenseId = await createExpense(owner, groupId, memberIds[users.alice.email]!);
      await trpcMutation(owner, 'groups.archive', { groupId });

      await page.goto(`/en/groups/${groupId}/expenses/${expenseId}`);
      await expect(page.getByRole('heading', { name: 'Before Archive' })).toBeVisible();
      await expect(page.getByText("This group is archived, so this expense can't be edited or deleted.")).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit Expense' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);

      await dispose();
    });

    test('a refused expense delete says why instead of failing silently', async ({ page }) => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        'Refused Expense Delete',
      );
      // Alice added and paid it, so Bob, a plain member, may not delete it
      const expenseId = await createExpense(owner, groupId, memberIds[users.alice.email]!);
      await login(page, users.bob.email, users.bob.password);

      await page.goto(`/en/groups/${groupId}/expenses/${expenseId}`);
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(
        page.getByText('Only the expense creator, payer, or group owner/admin can delete this expense'),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/expenses/${expenseId}$`));

      await dispose();
    });

    test('a plain member is told to ask an owner or admin to unarchive', async ({ page }) => {
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        'Archive Member View',
      );
      await trpcMutation(owner, 'groups.archive', { groupId });
      await login(page, users.bob.email, users.bob.password);

      await page.goto(`/en/groups/${groupId}`);
      await expect(page.getByText('Ask a group owner or admin to unarchive it.')).toBeVisible();
      await expect(page.getByText('Manage', { exact: true })).toHaveCount(0);

      await page.goto(`/en/groups/${groupId}/settings`);
      await expect(page.getByText('This group is archived')).toBeVisible();
      await expect(page.getByText('Ask a group owner or admin to unarchive it.')).toBeVisible();
      await expect(page.getByRole('button', { name: /Unarchive/ })).toHaveCount(0);

      await dispose();
    });

    // tRPC acts as the impersonated user while useSession() still reports the admin,
    // so the role has to come from the acting user.
    test('an admin impersonating a plain member sees what that member sees', async ({ page }) => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.charlie.email,
        users.charlie.password,
        [{ email: users.bob.email, password: users.bob.password }],
        'Archive Impersonated Member',
      );
      await trpcMutation(owner, 'groups.archive', { groupId });
      // Alice is a site admin and not in this group
      await login(page, users.alice.email, users.alice.password);
      const startRes = await page.request.post('/api/admin/impersonate', {
        data: { userId: memberIds[users.bob.email] },
      });
      expect(startRes.ok()).toBe(true);

      try {
        await page.goto(`/en/groups/${groupId}`);
        await expect(page.getByText('Ask a group owner or admin to unarchive it.')).toBeVisible();
        await expect(page.getByText('Manage', { exact: true })).toHaveCount(0);

        await page.goto(`/en/groups/${groupId}/settings`);
        await expect(page.getByText('Ask a group owner or admin to unarchive it.')).toBeVisible();
        await expect(page.getByRole('button', { name: /Unarchive/ })).toHaveCount(0);
      } finally {
        await page.request.delete('/api/admin/impersonate');
        await dispose();
      }
    });

    test('the owner still gets the Manage link on an archived group', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      const { owner, groupId, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Owner View',
      );
      await trpcMutation(owner, 'groups.archive', { groupId });

      await page.goto(`/en/groups/${groupId}`);
      await expect(page.getByText('Manage', { exact: true })).toBeVisible();
      await expect(page.getByText('Ask a group owner or admin to unarchive it.')).toHaveCount(0);

      await dispose();
    });

    test('direct links to add, edit or scan an expense say the group is archived', async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [],
        'Archive Direct Links',
      );
      const expenseId = await createExpense(owner, groupId, memberIds[users.alice.email]!);
      await trpcMutation(owner, 'groups.archive', { groupId });

      for (const path of ['expenses/new', `expenses/${expenseId}/edit`, 'scan', 'scan?receiptId=any']) {
        await page.goto(`/en/groups/${groupId}/${path}`);
        await expect(page.getByRole('heading', { name: 'This group is archived' }), path).toBeVisible();
        await expect(page.getByText('Back to group', { exact: true }), path).toBeVisible();
        await expect(page.locator('form'), path).toHaveCount(0);
        await expect(page.getByText('Upload a receipt'), path).toHaveCount(0);
      }

      await dispose();
    });
  });
});
