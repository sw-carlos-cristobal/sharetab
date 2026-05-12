import { test, expect } from "@playwright/test";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, createTestGroup } from "./helpers";

test.describe("Admin Delete User", () => {
  test("deleteUser converts user to placeholder preserving financial history", async () => {
    const { owner, groupId, memberIds, memberContexts, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Delete User Test"
    );

    const aliceId = memberIds[users.alice.email];
    const bobId = memberIds[users.bob.email];
    const bobCtx = memberContexts[0];

    // Bob creates an expense he paid for
    const expRes = await trpcMutation(bobCtx, "expenses.create", {
      groupId,
      title: "Bob's lunch",
      amount: 2000,
      paidById: bobId,
      splitMode: "EQUAL",
      shares: [
        { userId: aliceId, amount: 1000 },
        { userId: bobId, amount: 1000 },
      ],
    });
    expect(expRes.ok()).toBe(true);

    // Admin deletes Bob
    const deleteRes = await trpcMutation(owner, "admin.deleteUser", {
      userId: bobId,
    });
    expect(deleteRes.ok()).toBe(true);
    const result = (await deleteRes.json()).result?.data?.json;
    expect(result.deleted).toBe(true);

    // Verify: expense still exists with Bob as payer (financial history preserved)
    const expListRes = await trpcQuery(owner, "expenses.list", { groupId });
    const expenses = await trpcResult(expListRes);
    const bobsExpense = expenses.expenses.find(
      (e: { title: string }) => e.title === "Bob's lunch"
    );
    expect(bobsExpense).toBeDefined();
    expect(bobsExpense.paidBy.id).toBe(bobId);

    // Verify: activity feed is still accessible
    const actRes = await trpcQuery(owner, "activity.getGroupActivity", { groupId });
    const activity = await trpcResult(actRes);
    expect(activity.items.length).toBeGreaterThanOrEqual(1);

    await dispose();
  });

  test("deleteUser prevents deleted user from logging in", async () => {
    // Create a temporary user to delete
    const { owner, groupId, memberIds, memberContexts, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.charlie.email, password: users.charlie.password }],
      "Delete Login Test"
    );

    const charlieId = memberIds[users.charlie.email];

    // Admin deletes Charlie
    const deleteRes = await trpcMutation(owner, "admin.deleteUser", {
      userId: charlieId,
    });
    expect(deleteRes.ok()).toBe(true);

    // Charlie should no longer be able to authenticate
    // (email changed to deleted-xxx@placeholder.local, password cleared)
    const charlieCtx = await authedContext(users.charlie.email, users.charlie.password);
    const profileRes = await trpcQuery(charlieCtx, "auth.getProfile");
    const body = await profileRes.json();
    // Should get an auth error since the user's email no longer matches
    expect(body[0]?.error).toBeDefined();

    await charlieCtx.dispose();
    await dispose();
  });

  test("deleteUser cannot delete self", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    const groupsRes = await trpcQuery(ctx, "groups.list");
    const groups = await trpcResult(groupsRes);
    const aliceId = groups[0]?.members?.find(
      (m: { user: { email: string } }) => m.user.email === users.alice.email
    )?.user?.id;

    if (aliceId) {
      const deleteRes = await trpcMutation(ctx, "admin.deleteUser", {
        userId: aliceId,
      });
      const body = await deleteRes.json();
      expect(body.error?.json?.data?.code).toBe("BAD_REQUEST");
    }

    await ctx.dispose();
  });
});
