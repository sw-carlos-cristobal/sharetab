import { test, expect } from "@playwright/test";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError, createTestGroup } from "./helpers";

test.describe("Expense Creation API (3.1)", () => {
  test("3.1.1 — create equal split (3 members, $30)", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [
        { email: users.bob.email, password: users.bob.password },
        { email: users.charlie.email, password: users.charlie.password },
      ],
      "Equal Split Test"
    );

    const res = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Lunch",
      amount: 3000,
      paidById: memberIds[users.alice.email],
      splitMode: "EQUAL",
      shares: [
        { userId: memberIds[users.alice.email], amount: 1000 },
        { userId: memberIds[users.bob.email], amount: 1000 },
        { userId: memberIds[users.charlie.email], amount: 1000 },
      ],
    });
    const expense = (await res.json()).result?.data?.json;
    expect(expense.amount).toBe(3000);
    expect(expense.shares.length).toBe(3);
    expect(expense.shares.every((s: { amount: number }) => s.amount === 1000)).toBe(true);
    await dispose();
  });

  test("3.1.2 — equal split with remainder (3 members, $10.00 = 1000 cents)", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [
        { email: users.bob.email, password: users.bob.password },
        { email: users.charlie.email, password: users.charlie.password },
      ],
      "Remainder Test"
    );

    // 1000 / 3 = 333 remainder 1
    const res = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Remainder",
      amount: 1000,
      paidById: memberIds[users.alice.email],
      splitMode: "EQUAL",
      shares: [
        { userId: memberIds[users.alice.email], amount: 334 },
        { userId: memberIds[users.bob.email], amount: 333 },
        { userId: memberIds[users.charlie.email], amount: 333 },
      ],
    });
    const expense = (await res.json()).result?.data?.json;
    expect(expense.amount).toBe(1000);
    const shareSum = expense.shares.reduce((s: number, sh: { amount: number }) => s + sh.amount, 0);
    expect(shareSum).toBe(1000);
    await dispose();
  });

  test("3.1.3 — create exact split", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Exact Split Test"
    );

    const res = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Exact",
      amount: 3000,
      paidById: memberIds[users.alice.email],
      splitMode: "EXACT",
      shares: [
        { userId: memberIds[users.alice.email], amount: 2000 },
        { userId: memberIds[users.bob.email], amount: 1000 },
      ],
    });
    const expense = (await res.json()).result?.data?.json;
    const aliceShare = expense.shares.find((s: { userId: string }) => s.userId === memberIds[users.alice.email]);
    const bobShare = expense.shares.find((s: { userId: string }) => s.userId === memberIds[users.bob.email]);
    expect(aliceShare.amount).toBe(2000);
    expect(bobShare.amount).toBe(1000);
    await dispose();
  });

  test("3.1.4 — create percentage split", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Percentage Split Test"
    );

    // Alice 60%, Bob 40% of $100 = $60 + $40
    const res = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Percentage",
      amount: 10000,
      paidById: memberIds[users.alice.email],
      splitMode: "PERCENTAGE",
      shares: [
        { userId: memberIds[users.alice.email], amount: 6000, percentage: 6000 },
        { userId: memberIds[users.bob.email], amount: 4000, percentage: 4000 },
      ],
    });
    const expense = (await res.json()).result?.data?.json;
    expect(expense.splitMode).toBe("PERCENTAGE");
    await dispose();
  });

  test("3.1.5 — create shares split", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Shares Split Test"
    );

    // Alice 2 shares, Bob 1 share of $90 = $60 + $30
    const res = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Shares",
      amount: 9000,
      paidById: memberIds[users.alice.email],
      splitMode: "SHARES",
      shares: [
        { userId: memberIds[users.alice.email], amount: 6000, shares: 2 },
        { userId: memberIds[users.bob.email], amount: 3000, shares: 1 },
      ],
    });
    const expense = (await res.json()).result?.data?.json;
    expect(expense.splitMode).toBe("SHARES");
    const aliceShare = expense.shares.find((s: { userId: string }) => s.userId === memberIds[users.alice.email]);
    expect(aliceShare.amount).toBe(6000);
    await dispose();
  });

  test("3.1.8 — activity log created on expense", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "Activity Log Test"
    );

    await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Logged Expense",
      amount: 500,
      paidById: memberIds[users.alice.email],
      splitMode: "EQUAL",
      shares: [{ userId: memberIds[users.alice.email], amount: 500 }],
    });

    const actRes = await trpcQuery(owner, "activity.getGroupActivity", { groupId });
    const activity = await trpcResult(actRes);
    expect(activity.items.length).toBeGreaterThanOrEqual(1);
    const expenseLog = activity.items.find((a: { type: string }) => a.type === "EXPENSE_CREATED");
    expect(expenseLog).toBeDefined();
    await dispose();
  });
});

test.describe("Expense CRUD API (3.2)", () => {
  test("3.2.1 — list expenses paginated", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "Pagination Test"
    );

    // Create 5 expenses
    for (let i = 0; i < 5; i++) {
      await trpcMutation(owner, "expenses.create", {
        groupId,
        title: `Expense ${i}`,
        amount: 100 * (i + 1),
        paidById: memberIds[users.alice.email],
        splitMode: "EQUAL",
        shares: [{ userId: memberIds[users.alice.email], amount: 100 * (i + 1) }],
      });
    }

    // List with limit 3
    const res = await trpcQuery(owner, "expenses.list", { groupId, limit: 3 });
    const data = await trpcResult(res);
    expect(data.expenses.length).toBe(3);
    expect(data.nextCursor).toBeDefined();
    await dispose();
  });

  test("3.2.2 — list with cursor returns next page", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "Cursor Test"
    );

    for (let i = 0; i < 5; i++) {
      await trpcMutation(owner, "expenses.create", {
        groupId,
        title: `Cursor Exp ${i}`,
        amount: 100,
        paidById: memberIds[users.alice.email],
        splitMode: "EQUAL",
        shares: [{ userId: memberIds[users.alice.email], amount: 100 }],
      });
    }

    const page1 = await trpcQuery(owner, "expenses.list", { groupId, limit: 2 });
    const data1 = await trpcResult(page1);
    expect(data1.expenses.length).toBe(2);

    const page2 = await trpcQuery(owner, "expenses.list", { groupId, limit: 2, cursor: data1.nextCursor });
    const data2 = await trpcResult(page2);
    expect(data2.expenses.length).toBe(2);

    // Pages should have different expenses
    const ids1 = data1.expenses.map((e: { id: string }) => e.id);
    const ids2 = data2.expenses.map((e: { id: string }) => e.id);
    expect(ids1.every((id: string) => !ids2.includes(id))).toBe(true);
    await dispose();
  });

  test("3.2.5 — update expense", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "Update Test"
    );

    const createRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Original",
      amount: 1000,
      paidById: memberIds[users.alice.email],
      splitMode: "EQUAL",
      shares: [{ userId: memberIds[users.alice.email], amount: 1000 }],
    });
    const expenseId = (await createRes.json()).result?.data?.json?.id;

    const updateRes = await trpcMutation(owner, "expenses.update", {
      groupId,
      expenseId,
      title: "Updated Title",
    });
    const updated = (await updateRes.json()).result?.data?.json;
    expect(updated.title).toBe("Updated Title");
    await dispose();
  });
});
