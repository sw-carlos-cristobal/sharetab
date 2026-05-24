import { test, expect } from "@playwright/test";
import { users, uniqueEmail, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError } from "./helpers";

test.describe("Admin Delete User", () => {
  test("deleteUser converts user to placeholder preserving financial data", async () => {
    const admin = await authedContext(users.alice.email, users.alice.password);
    let tempCtx: Awaited<ReturnType<typeof authedContext>> | undefined;
    let groupId: string | undefined;

    try {
      // Register a temp user via the API
      const tempEmail = uniqueEmail("deltest");
      const regRes = await trpcMutation(admin, "auth.register", {
        name: "TempUser Delete",
        email: tempEmail,
        password: "password123",
      });
      expect(regRes.ok()).toBe(true);

      // Get the temp user's ID
      const listRes = await trpcQuery(admin, "admin.listUsers", { search: tempEmail, limit: 1 });
      const listData = await trpcResult(listRes);
      const tempId = listData?.users?.[0]?.id;
      expect(tempId).toBeDefined();

      // Create a group, invite temp user, add an expense
      const groupRes = await trpcMutation(admin, "groups.create", { name: "Delete Test Group" });
      groupId = (await groupRes.json()).result?.data?.json?.id;
      expect(groupId).toBeDefined();

      const invRes = await trpcMutation(admin, "groups.createInvite", { groupId });
      const token = (await invRes.json()).result?.data?.json?.token;
      expect(token).toBeDefined();

      tempCtx = await authedContext(tempEmail, "password123");
      await trpcMutation(tempCtx, "groups.joinByInvite", { token });

      // Get admin's member ID
      const detailRes = await trpcQuery(admin, "groups.get", { groupId });
      const detail = await trpcResult(detailRes);
      const adminId = detail.members.find(
        (m: { user: { email: string } }) => m.user.email === users.alice.email
      )?.user?.id;
      expect(adminId).toBeDefined();

      // Create expense paid by temp user
      const expRes = await trpcMutation(tempCtx, "expenses.create", {
        groupId,
        title: "Temp user expense",
        amount: 2000,
        paidById: tempId,
        splitMode: "EQUAL",
        shares: [
          { userId: adminId, amount: 1000 },
          { userId: tempId, amount: 1000 },
        ],
      });
      expect(expRes.ok()).toBe(true);

      // Delete the temp user
      const deleteRes = await trpcMutation(admin, "admin.deleteUser", { userId: tempId });
      expect(deleteRes.ok()).toBe(true);

      // Verify expense still exists (financial history preserved)
      const expListRes = await trpcQuery(admin, "expenses.list", { groupId });
      const expenses = await trpcResult(expListRes);
      const found = expenses.expenses.find((e: { title: string }) => e.title === "Temp user expense");
      expect(found).toBeDefined();
    } finally {
      if (groupId) await trpcMutation(admin, "groups.delete", { groupId }).catch(() => {});
      await tempCtx?.dispose();
      await admin.dispose();
    }
  });

  test("deleteUser cannot delete self", async () => {
    const admin = await authedContext(users.alice.email, users.alice.password);
    try {
      const listRes = await trpcQuery(admin, "admin.listUsers", { search: users.alice.email, limit: 1 });
      const listData = await trpcResult(listRes);
      const aliceId = listData?.users?.[0]?.id;
      expect(aliceId).toBeDefined();

      const deleteRes = await trpcMutation(admin, "admin.deleteUser", { userId: aliceId });
      const err = await trpcError(deleteRes);
      expect(err?.data?.code).toBe("BAD_REQUEST");
    } finally {
      await admin.dispose();
    }
  });
});
