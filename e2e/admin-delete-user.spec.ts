import { test, expect } from "@playwright/test";
import { users, testUsers, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError } from "./helpers";

test.describe("Admin Delete User", () => {
  test("deleteUser converts user to placeholder preserving financial data", async () => {
    const admin = await authedContext(users.alice.email, users.alice.password);

    // Use the dedicated delete-test seed user (already in "Test Admin Group")
    const listRes = await trpcQuery(admin, "admin.listUsers", { search: testUsers.delete.email, limit: 1 });
    const listData = await trpcResult(listRes);
    const target = listData?.users?.[0];
    expect(target).toBeDefined();
    expect(target.email).toBe(testUsers.delete.email);
    const targetId = target.id;

    // Create a group with the target user and an expense to verify financial data preservation
    const groupRes = await trpcMutation(admin, "groups.create", { name: "Delete Test Group" });
    const groupId = (await groupRes.json()).result?.data?.json?.id;

    const invRes = await trpcMutation(admin, "groups.createInvite", { groupId });
    const token = (await invRes.json()).result?.data?.json?.token;

    const targetCtx = await authedContext(testUsers.delete.email, testUsers.delete.password);
    try {
      await trpcMutation(targetCtx, "groups.joinByInvite", { token });

      const detailRes = await trpcQuery(admin, "groups.get", { groupId });
      const detail = await trpcResult(detailRes);
      const adminId = detail.members.find(
        (m: { user: { email: string } }) => m.user.email === users.alice.email
      )?.user?.id;

      const expRes = await trpcMutation(targetCtx, "expenses.create", {
        groupId,
        title: "Temp user expense",
        amount: 2000,
        paidById: targetId,
        splitMode: "EQUAL",
        shares: [
          { userId: adminId, amount: 1000 },
          { userId: targetId, amount: 1000 },
        ],
      });
      expect(expRes.ok()).toBe(true);
    } finally {
      await targetCtx.dispose();
    }

    // Delete the user
    const deleteRes = await trpcMutation(admin, "admin.deleteUser", { userId: targetId });
    expect(deleteRes.ok()).toBe(true);

    // Verify expense still exists (financial history preserved)
    const expListRes = await trpcQuery(admin, "expenses.list", { groupId });
    const expenses = await trpcResult(expListRes);
    const found = expenses.expenses.find((e: { title: string }) => e.title === "Temp user expense");
    expect(found).toBeDefined();

    // Cleanup
    await trpcMutation(admin, "groups.delete", { groupId });
    await admin.dispose();
  });

  test("deleteUser cannot delete self", async () => {
    const admin = await authedContext(users.alice.email, users.alice.password);

    const listRes = await trpcQuery(admin, "admin.listUsers", { search: users.alice.email, limit: 1 });
    const listData = await trpcResult(listRes);
    const aliceId = listData?.users?.[0]?.id;
    expect(aliceId).toBeDefined();

    const deleteRes = await trpcMutation(admin, "admin.deleteUser", { userId: aliceId });
    const err = await trpcError(deleteRes);
    expect(err?.data?.code).toBe("BAD_REQUEST");

    await admin.dispose();
  });
});
