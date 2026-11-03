import { test, expect } from '@playwright/test';
import { users, uniqueEmail, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError } from './helpers';

test.describe('Admin Delete User', () => {
  test('deleteUser converts user to placeholder preserving financial data', async () => {
    const admin = await authedContext(users.alice.email, users.alice.password);
    let tempCtx: Awaited<ReturnType<typeof authedContext>> | undefined;
    let groupId: string | undefined;
    const tempEmail = uniqueEmail('deltest');
    let tempId: string | undefined;

    try {
      // Register a temp user via the API
      const regRes = await trpcMutation(admin, 'auth.register', {
        name: 'TempUser Delete',
        email: tempEmail,
        password: 'password123',
      });
      expect(regRes.ok()).toBe(true);

      // Get the temp user's ID
      const listRes = await trpcQuery(admin, 'admin.listUsers', { search: tempEmail, limit: 1 });
      const listData = await trpcResult(listRes);
      tempId = listData?.users?.[0]?.id;
      expect(tempId).toBeDefined();

      // Create a group, invite temp user, add an expense
      const groupRes = await trpcMutation(admin, 'groups.create', { name: 'Delete Test Group' });
      groupId = (await groupRes.json()).result?.data?.json?.id;
      expect(groupId).toBeDefined();

      const invRes = await trpcMutation(admin, 'groups.createInvite', { groupId });
      const token = (await invRes.json()).result?.data?.json?.token;
      expect(token).toBeDefined();

      tempCtx = await authedContext(tempEmail, 'password123');
      await trpcMutation(tempCtx, 'groups.joinByInvite', { token });

      // Get Alice's user ID from the group membership
      const detailRes = await trpcQuery(admin, 'groups.get', { groupId });
      const detail = await trpcResult(detailRes);
      const adminId = detail.members.find((m: { user: { email: string } }) => m.user.email === users.alice.email)?.user
        ?.id;
      expect(adminId).toBeDefined();

      // Create expense paid by temp user
      const expRes = await trpcMutation(tempCtx, 'expenses.create', {
        groupId,
        title: 'Temp user expense',
        amount: 2000,
        paidById: tempId,
        splitMode: 'EQUAL',
        shares: [
          { userId: adminId, amount: 1000 },
          { userId: tempId, amount: 1000 },
        ],
      });
      expect(expRes.ok()).toBe(true);

      // Delete the temp user
      const deleteRes = await trpcMutation(admin, 'admin.deleteUser', { userId: tempId });
      expect(deleteRes.ok()).toBe(true);

      // Verify expense still exists (financial history preserved)
      const expListRes = await trpcQuery(admin, 'expenses.list', { groupId });
      const expenses = await trpcResult(expListRes);
      const found = expenses.expenses.find((e: { title: string }) => e.title === 'Temp user expense');
      expect(found).toBeDefined();

      // #390: the owner (Alice) can't delete the group while it still holds a balance with
      // the deleted account, which no payment can settle; she's told to change what it's in
      const refused = await trpcError(await trpcMutation(admin, 'groups.delete', { groupId }));
      expect(refused?.data?.code).toBe('PRECONDITION_FAILED');
      expect(refused?.message).toBe(
        "Someone who is no longer in this group still owes or is owed money, so it can't be deleted. Invite them back to settle up, or edit or delete the expenses and payments they're in.",
      );
      // Doing so clears the balance, and the group can go
      const removed = await trpcMutation(admin, 'expenses.delete', { groupId, expenseId: found.id });
      expect(removed.ok(), await removed.text()).toBe(true);
      const deleted = await trpcMutation(admin, 'groups.delete', { groupId });
      expect(deleted.ok(), await deleted.text()).toBe(true);
      groupId = undefined;
    } finally {
      // The admin's delete, if the test stopped first: the temp user's expense leaves a
      // balance, which refuses the owner's (#390)
      if (groupId) await trpcMutation(admin, 'admin.deleteGroup', { groupId }).catch(() => {});
      if (tempId) await trpcMutation(admin, 'admin.deleteUser', { userId: tempId }).catch(() => {});
      await tempCtx?.dispose();
      await admin.dispose();
    }
  });

  test('deleteUser cannot delete self', async () => {
    const admin = await authedContext(users.alice.email, users.alice.password);
    try {
      const listRes = await trpcQuery(admin, 'admin.listUsers', { search: users.alice.email, limit: 1 });
      const listData = await trpcResult(listRes);
      const aliceId = listData?.users?.[0]?.id;
      expect(aliceId).toBeDefined();

      const deleteRes = await trpcMutation(admin, 'admin.deleteUser', { userId: aliceId });
      const err = await trpcError(deleteRes);
      expect(err?.data?.code).toBe('BAD_REQUEST');
    } finally {
      await admin.dispose();
    }
  });
});
