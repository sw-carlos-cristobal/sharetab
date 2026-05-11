import { test, expect } from "@playwright/test";
import { users, trpcMutation, trpcError, createTestGroup } from "./helpers";

test.describe("Expense Authorization", () => {
  test("non-owner member cannot update another member's expense via API", async () => {
    const { owner, groupId, memberIds, memberContexts, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Auth Update Test"
    );

    const aliceId = memberIds[users.alice.email];
    const createRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Alice's expense",
      amount: 2000,
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [
        { userId: aliceId, amount: 1000 },
        { userId: memberIds[users.bob.email], amount: 1000 },
      ],
    });
    expect(createRes.ok()).toBe(true);
    const expense = (await createRes.json()).result?.data?.json;
    expect(expense?.id).toBeDefined();

    const bobCtx = memberContexts[0];
    const updateRes = await trpcMutation(bobCtx, "expenses.update", {
      groupId,
      expenseId: expense.id,
      title: "Bob hijacked this",
    });
    const err = await trpcError(updateRes);
    expect(err?.data?.code).toBe("FORBIDDEN");

    await dispose();
  });

  test("non-owner member cannot delete another member's expense via API", async () => {
    const { owner, groupId, memberIds, memberContexts, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Auth Delete Test"
    );

    const aliceId = memberIds[users.alice.email];
    const createRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Alice's protected expense",
      amount: 3000,
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [
        { userId: aliceId, amount: 1500 },
        { userId: memberIds[users.bob.email], amount: 1500 },
      ],
    });
    expect(createRes.ok()).toBe(true);
    const expense = (await createRes.json()).result?.data?.json;
    expect(expense?.id).toBeDefined();

    const bobCtx = memberContexts[0];
    const deleteRes = await trpcMutation(bobCtx, "expenses.delete", {
      groupId,
      expenseId: expense.id,
    });
    const err = await trpcError(deleteRes);
    expect(err?.data?.code).toBe("FORBIDDEN");

    await dispose();
  });

  test("expense creator can still update their own expense", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Auth Creator Update"
    );

    const aliceId = memberIds[users.alice.email];
    const createRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "My expense",
      amount: 5000,
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [
        { userId: aliceId, amount: 2500 },
        { userId: memberIds[users.bob.email], amount: 2500 },
      ],
    });
    expect(createRes.ok()).toBe(true);
    const expense = (await createRes.json()).result?.data?.json;
    expect(expense?.id).toBeDefined();

    const updateRes = await trpcMutation(owner, "expenses.update", {
      groupId,
      expenseId: expense.id,
      title: "Updated by creator",
    });
    const updated = (await updateRes.json()).result?.data?.json;
    expect(updated.title).toBe("Updated by creator");

    await dispose();
  });

  test("payer (non-creator MEMBER) can update their own expense", async () => {
    const { owner, groupId, memberIds, memberContexts, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Auth Payer Update"
    );

    const bobId = memberIds[users.bob.email];
    const aliceId = memberIds[users.alice.email];
    // Alice (OWNER) creates an expense where Bob is the payer
    const createRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Bob paid for lunch",
      amount: 4000,
      paidById: bobId,
      splitMode: "EQUAL",
      shares: [
        { userId: aliceId, amount: 2000 },
        { userId: bobId, amount: 2000 },
      ],
    });
    expect(createRes.ok()).toBe(true);
    const expense = (await createRes.json()).result?.data?.json;
    expect(expense?.id).toBeDefined();

    // Bob (MEMBER, payer) should be able to update
    const bobCtx = memberContexts[0];
    const updateRes = await trpcMutation(bobCtx, "expenses.update", {
      groupId,
      expenseId: expense.id,
      title: "Updated by payer Bob",
    });
    const updated = (await updateRes.json()).result?.data?.json;
    expect(updated.title).toBe("Updated by payer Bob");

    await dispose();
  });

  test("payer (non-creator MEMBER) can delete their own expense", async () => {
    const { owner, groupId, memberIds, memberContexts, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Auth Payer Delete"
    );

    const bobId = memberIds[users.bob.email];
    const aliceId = memberIds[users.alice.email];
    const createRes = await trpcMutation(owner, "expenses.create", {
      groupId,
      title: "Bob paid for dinner",
      amount: 6000,
      paidById: bobId,
      splitMode: "EQUAL",
      shares: [
        { userId: aliceId, amount: 3000 },
        { userId: bobId, amount: 3000 },
      ],
    });
    expect(createRes.ok()).toBe(true);
    const expense = (await createRes.json()).result?.data?.json;
    expect(expense?.id).toBeDefined();

    const bobCtx = memberContexts[0];
    const deleteRes = await trpcMutation(bobCtx, "expenses.delete", {
      groupId,
      expenseId: expense.id,
    });
    expect(deleteRes.ok()).toBe(true);

    await dispose();
  });
});
