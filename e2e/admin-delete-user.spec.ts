import { test, expect } from "@playwright/test";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError, uniqueEmail, register } from "./helpers";
import { request } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:3001";

async function createTempUser(name: string) {
  const email = uniqueEmail("deltest");
  const password = "password123";
  const ctx = await request.newContext({ baseURL: BASE });

  // Register via tRPC
  const adminCtx = await authedContext(users.alice.email, users.alice.password);
  const regRes = await trpcMutation(adminCtx, "auth.register", { name, email, password });
  const regBody = await regRes.json();

  // Get the user's ID by listing users
  const listRes = await trpcQuery(adminCtx, "admin.listUsers", { search: email, limit: 1 });
  const listData = await trpcResult(listRes);
  const userId = listData?.users?.[0]?.id;

  await adminCtx.dispose();
  await ctx.dispose();
  return { email, password, userId };
}

test.describe("Admin Delete User", () => {
  test("deleteUser converts user to placeholder preserving financial data", async () => {
    const admin = await authedContext(users.alice.email, users.alice.password);

    // Create a temp user and add to a group with expenses
    const temp = await createTempUser("TempUser Delete");
    expect(temp.userId).toBeDefined();

    // Create a group, invite temp user, add an expense
    const groupRes = await trpcMutation(admin, "groups.create", { name: "Delete Test Group" });
    const groupId = (await groupRes.json()).result?.data?.json?.id;

    const invRes = await trpcMutation(admin, "groups.createInvite", { groupId });
    const token = (await invRes.json()).result?.data?.json?.token;

    const tempCtx = await authedContext(temp.email, temp.password);
    await trpcMutation(tempCtx, "groups.joinByInvite", { token });

    // Get member IDs
    const detailRes = await trpcQuery(admin, "groups.get", { groupId });
    const detail = await trpcResult(detailRes);
    const adminId = detail.members.find((m: { user: { email: string } }) => m.user.email === users.alice.email)?.user?.id;
    const tempId = temp.userId;

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

    // Verify expense still exists
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
    const profileRes = await trpcQuery(admin, "auth.getProfile");
    const profile = await trpcResult(profileRes);

    // Get alice's ID
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
