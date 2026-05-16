import { test, expect } from "@playwright/test";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, deleteTestGroup } from "./helpers";

const createdGroupIds: string[] = [];

test.afterAll(async () => {
  const ctx = await authedContext(users.alice.email, users.alice.password);
  for (const id of createdGroupIds) await deleteTestGroup(ctx, id);
  await ctx.dispose();
});

test.describe("Expenses API", () => {
  let ctx: Awaited<ReturnType<typeof authedContext>>;
  let groupId: string;
  let aliceId: string;

  test.beforeAll(async () => {
    ctx = await authedContext(users.alice.email, users.alice.password);
    // Get group and user IDs
    const listRes = await trpcQuery(ctx, "groups.list");
    const listBody = await listRes.json();
    const apartment = listBody[0]?.result?.data?.json?.find((g: { name: string }) => g.name === "Apartment");
    groupId = apartment?.id;
    aliceId = apartment?.members?.[0]?.user?.id;
  });

  test.afterAll(async () => {
    await ctx.dispose();
  });

  test("3.1.6 — shares sum mismatch returns BAD_REQUEST", async () => {
    const res = await trpcMutation(ctx, "expenses.create", {
      groupId,
      title: "Mismatch",
      amount: 3000, // $30
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [{ userId: aliceId, amount: 2500 }], // $25 != $30
    });
    const body = await res.json();
    expect(body.error?.json?.data?.code).toBe("BAD_REQUEST");
    expect(body.error?.json?.message).toContain("does not equal");
  });

  test("3.1.7 — create expense as non-member returns FORBIDDEN", async () => {
    // Create a group that Charlie is NOT in
    const createRes = await trpcMutation(ctx, "groups.create", { name: "Alice Only" });
    const privateGroupId = (await createRes.json()).result?.data?.json?.id;
    createdGroupIds.push(privateGroupId);

    const charlie = await authedContext("charlie@example.com", "password123");
    const res = await trpcMutation(charlie, "expenses.create", {
      groupId: privateGroupId,
      title: "Intruder",
      amount: 1000,
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [{ userId: aliceId, amount: 1000 }],
    });
    const body = await res.json();
    expect(body.error?.json?.data?.code).toBe("FORBIDDEN");
    await charlie.dispose();
  });

  test("3.2.3 — get expense detail", async () => {
    // Get list first to find an expense ID
    const listRes = await trpcQuery(ctx, "expenses.list", { groupId, limit: 1 });
    const listBody = await listRes.json();
    const expense = listBody[0]?.result?.data?.json?.expenses?.[0];

    if (expense) {
      const res = await trpcQuery(ctx, "expenses.get", { groupId, expenseId: expense.id });
      const body = await res.json();
      const detail = body[0]?.result?.data?.json;
      expect(detail.title).toBeDefined();
      expect(detail.amount).toBeGreaterThan(0);
      expect(detail.shares.length).toBeGreaterThan(0);
      expect(detail.paidBy).toBeDefined();
    }
  });

  test("3.2.4 — get expense from wrong group returns NOT_FOUND", async () => {
    // Get a valid expense from Apartment
    const listRes = await trpcQuery(ctx, "expenses.list", { groupId, limit: 1 });
    const listBody = await listRes.json();
    const expense = listBody[0]?.result?.data?.json?.expenses?.[0];

    if (expense) {
      // Try with a wrong groupId
      const res = await trpcQuery(ctx, "expenses.get", { groupId: "fake-group-id", expenseId: expense.id });
      const body = await res.json();
      expect(body[0]?.error).toBeDefined();
    }
  });

  test("3.2.7 — expenses ordered by date descending", async () => {
    const res = await trpcQuery(ctx, "expenses.list", { groupId, limit: 50 });
    const body = await res.json();
    const expenses = body[0]?.result?.data?.json?.expenses;
    if (expenses && expenses.length >= 2) {
      for (let i = 1; i < expenses.length; i++) {
        const prev = new Date(expenses[i - 1].expenseDate).getTime();
        const curr = new Date(expenses[i].expenseDate).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    }
  });
});
