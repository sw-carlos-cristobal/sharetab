import { test, expect } from '@playwright/test';
import { login, users, createTestGroup, trpcMutation, trpcQuery, trpcError } from './helpers';

type TestGroup = Awaited<ReturnType<typeof createTestGroup>>;

// Alice paid $10.00 split with Bob, so Bob owes Alice $5.00
async function bobOwesAliceHalf({ owner, groupId, memberIds }: TestGroup) {
  const aliceId = memberIds[users.alice.email]!;
  const bobId = memberIds[users.bob.email]!;
  const res = await trpcMutation(owner, 'expenses.create', {
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
  expect(res.ok(), await res.text()).toBe(true);
  return { aliceId, bobId };
}

// #390: deleting a group took everyone's open balances with it, on the owner's one click,
// with no way back. It's refused until everyone is settled up, as archiving is (#275).
test.describe('Deleting a group with open balances', () => {
  test('is refused until everyone is settled up', async () => {
    const group = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      `Delete Unsettled ${Date.now()}`,
    );
    const { owner, groupId } = group;
    try {
      const { aliceId, bobId } = await bobOwesAliceHalf(group);

      const error = await trpcError(await trpcMutation(owner, 'groups.delete', { groupId }));
      expect(error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(error?.message).toBe('This group still has unsettled balances. Settle up before deleting it.');
      // Still there, expense and all
      expect((await trpcQuery(owner, 'groups.get', { groupId })).ok()).toBe(true);
      const debts = (await (await trpcQuery(owner, 'balances.getSimplifiedDebts', { groupId })).json())[0]?.result?.data
        ?.json?.debts;
      expect(debts).toEqual([expect.objectContaining({ from: bobId, to: aliceId, amount: 500 })]);

      // Once Bob pays Alice back, the owner can delete it
      const paid = await trpcMutation(owner, 'settlements.create', {
        groupId,
        fromId: bobId,
        toId: aliceId,
        amount: 500,
      });
      expect(paid.ok(), await paid.text()).toBe(true);
      const deleted = await trpcMutation(owner, 'groups.delete', { groupId });
      expect(deleted.ok(), await deleted.text()).toBe(true);
      expect((await trpcError(await trpcQuery(owner, 'groups.get', { groupId })))?.data?.code).toBeTruthy();
    } finally {
      await group.dispose();
    }
  });

  test('the settings page says why, and keeps the group', async ({ page }) => {
    const group = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      `Delete Unsettled UI ${Date.now()}`,
    );
    const { owner, groupId } = group;
    try {
      await bobOwesAliceHalf(group);
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/settings`);

      await expect(page.getByText('Everyone must be settled up first.').first()).toBeVisible();
      await page.getByRole('button', { name: 'Delete group' }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Delete this group?' });
      await expect(dialog).toContainText('Everyone must be settled up first');
      await dialog.getByRole('button', { name: 'Delete group' }).click();

      await expect(page.locator('[data-sonner-toast]').last()).toContainText(
        'This group still has unsettled balances. Settle up before deleting it.',
      );
      await expect(page).toHaveURL(new RegExp(`/groups/${groupId}/settings$`));
      expect((await trpcQuery(owner, 'groups.get', { groupId })).ok()).toBe(true);
    } finally {
      await group.dispose();
    }
  });
});
