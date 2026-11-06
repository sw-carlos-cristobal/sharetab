import { test, expect } from '@playwright/test';
import {
  users,
  uniqueEmail,
  authedContext,
  login,
  trpcMutation,
  trpcQuery,
  trpcResult,
  trpcError,
  deleteTestGroup,
} from './helpers';

// #323: someone with an account who leaves a group or is removed from it keeps their
// membership row while the group's expenses or payments name them, marked removed as a removed
// placeholder's is (#284). Their name still shows in the balances, a balance with them can be
// settled (a payment may only settle it), they lose access to the group, and joining again by
// invite brings the same membership back.
test.describe('Someone removed from a group (#323)', () => {
  test('keeps their name in the balances, can be settled with, and comes back by invite', async ({ page }) => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    // An account in no other group with Alice, so her dashboard's row for them comes from this group only
    const formerEmail = uniqueEmail('former');
    const formerName = `Former Member ${Date.now()}`;
    let former: Awaited<ReturnType<typeof authedContext>> | undefined;
    let formerId: string | undefined;
    let groupId: string | undefined;
    const ok = async (res: Awaited<ReturnType<typeof trpcMutation>>) => {
      expect(res.ok(), await res.text()).toBe(true);
      return (await res.json()).result?.data?.json;
    };

    try {
      await ok(
        await trpcMutation(alice, 'auth.register', { name: formerName, email: formerEmail, password: 'password123' }),
      );
      former = await authedContext(formerEmail, 'password123');
      groupId = (await ok(await trpcMutation(alice, 'groups.create', { name: 'Former Member Balances' }))).id;
      const join = async () => {
        const { token } = await ok(await trpcMutation(alice, 'groups.createInvite', { groupId }));
        return ok(await trpcMutation(former!, 'groups.joinByInvite', { token }));
      };
      await join();

      const before = await trpcResult(await trpcQuery(alice, 'groups.get', { groupId }));
      const memberRow = (id: string | undefined) =>
        before.members.find((m: { user: { id: string } }) => m.user.id === id) as { id: string; user: { id: string } };
      const aliceId = before.members.find((m: { user: { email: string } }) => m.user.email === users.alice.email).user
        .id;
      formerId = before.members.find((m: { user: { email: string } }) => m.user.email === formerEmail).user.id;
      const membershipId = memberRow(formerId).id;

      // Alice paid $10.00 split with them: they owe her $5.00. The owner can remove someone
      // who owes (#279); they couldn't leave on their own.
      await ok(
        await trpcMutation(alice, 'expenses.create', {
          groupId,
          title: 'Dinner before they left',
          amount: 1000,
          paidById: aliceId,
          splitMode: 'EQUAL',
          shares: [
            { userId: aliceId, amount: 500 },
            { userId: formerId, amount: 500 },
          ],
        }),
      );
      await ok(await trpcMutation(alice, 'groups.removeMember', { groupId, userId: formerId }));

      const group = await trpcResult(await trpcQuery(alice, 'groups.get', { groupId }));
      expect(group.members.map((m: { user: { id: string } }) => m.user.id)).not.toContain(formerId);
      expect(group.removedMembers.map((m: { user: { id: string; name: string } }) => [m.user.id, m.user.name])).toEqual(
        [[formerId, formerName]],
      );

      // The dashboard names them
      const overall = await trpcResult(await trpcQuery(alice, 'balances.getOverallDebts'));
      expect(overall.owedToYou).toContainEqual({
        userId: formerId,
        userName: formerName,
        venmoUsername: null,
        amount: 500,
      });

      // So does the group page's balances, rather than "Unknown"
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}`);
      await expect(page.getByRole('button', { name: new RegExp(`${formerName}.*\\$5\\.00`) })).toBeVisible();

      // They lose access to the group: its pages, its expenses, and its place on their
      // dashboard and in their recent activity
      expect((await trpcError(await trpcQuery(former, 'groups.get', { groupId })))?.data?.code).toBe('FORBIDDEN');
      expect((await trpcError(await trpcQuery(former, 'expenses.list', { groupId })))?.data?.code).toBe('FORBIDDEN');
      const theirGroups = await trpcResult(await trpcQuery(former, 'groups.list'));
      expect(theirGroups.map((g: { id: string }) => g.id)).not.toContain(groupId);
      const theirDashboard = await trpcResult(await trpcQuery(former, 'balances.getDashboard'));
      expect(theirDashboard.perGroup.map((g: { groupId: string }) => g.groupId)).not.toContain(groupId);
      const theirActivity = await trpcResult(await trpcQuery(former, 'activity.getRecentActivity', { limit: 50 }));
      expect(theirActivity.map((a: { groupId: string }) => a.groupId)).not.toContain(groupId);

      // Nobody's history can be handed to them while they're out of the group
      const probe = await ok(await trpcMutation(alice, 'groups.addPlaceholder', { groupId, name: 'Merge Probe' }));
      const merged = await trpcError(
        await trpcMutation(alice, 'groups.mergePlaceholder', {
          groupId,
          placeholderUserId: probe.id,
          realUserId: formerId,
        }),
      );
      expect(merged?.data?.code).toBe('BAD_REQUEST');
      expect(merged?.message).toBe('Target user is not a member of this group');

      // A payment with them may only settle what they owe
      const overpaid = await trpcError(
        await trpcMutation(alice, 'settlements.create', { groupId, fromId: formerId, toId: aliceId, amount: 600 }),
      );
      expect(overpaid?.message).toBe(
        'A payment with someone removed from this group can only settle what they still owe or are owed.',
      );
      await ok(
        await trpcMutation(alice, 'settlements.create', { groupId, fromId: formerId, toId: aliceId, amount: 500 }),
      );
      const { balances } = await trpcResult(await trpcQuery(alice, 'balances.getGroupBalances', { groupId }));
      expect(balances.every((b: { net: number }) => b.net === 0)).toBe(true);

      // An invite brings them back with the same membership
      expect((await join()).alreadyMember).toBe(false);
      const after = await trpcResult(await trpcQuery(former, 'groups.get', { groupId }));
      const back = after.members.find((m: { user: { id: string } }) => m.user.id === formerId);
      expect(back?.id).toBe(membershipId);
      expect(back?.role).toBe('MEMBER');
      expect(after.removedMembers).toEqual([]);
    } finally {
      if (groupId) await deleteTestGroup(alice, groupId);
      if (formerId) await trpcMutation(alice, 'admin.deleteUser', { userId: formerId }).catch(() => {});
      await former?.dispose();
      await alice.dispose();
    }
  });
});
