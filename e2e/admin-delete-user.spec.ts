import { test, expect } from "@playwright/test";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError, uniqueEmail } from "./helpers";

test.describe("Admin Delete User", () => {
  test("deleteUser converts user to placeholder preserving financial data", async () => {
    const admin = await authedContext(users.alice.email, users.alice.password);

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
    const groupId = (await groupRes.json()).result?.data?.json?.id;

    const invRes = await trpcMutation(admin, "groups.createInvite", { groupId });
    const token = (await invRes.json()).result?.data?.json?.token;

    const tempCtx = await authedContext(tempEmail, "password123");
    await trpcMutation(tempCtx, "groups.joinByInvite", { token });

    // Get admin's member ID
    const detailRes = await trpcQuery(admin, "groups.get", { groupId });
    const detail = await trpcResult(detailRes);
    const adminId = detail.members.find(
      (m: { user: { email: string } }) => m.user.email === users.alice.email
    )?.user?.id;

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

    // Cleanup
    await trpcMutation(admin, "groups.delete", { groupId });
    await tempCtx.dispose();
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
