import { test, expect } from "@playwright/test";
import { users, trpcMutation, trpcQuery, trpcResult, createTestGroup } from "./helpers";

test.describe("Balance Calculation (4.1)", () => {
  test("4.1.2 — multiple payers balance", async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [
        { email: users.bob.email, password: users.bob.password },
        { email: users.charlie.email, password: users.charlie.password },
      ],
      "Multi Payer Test"
    );
    const a = memberIds[users.alice.email];
    const b = memberIds[users.bob.email];
    const c = memberIds[users.charlie.email];

    // Alice pays $30 split equally (each owes $10)
    await trpcMutation(owner, "expenses.create", {
      groupId, title: "Alice pays", amount: 3000, paidById: a, splitMode: "EQUAL",
      shares: [{ userId: a, amount: 1000 }, { userId: b, amount: 1000 }, { userId: c, amount: 1000 }],
    });
    // Bob pays $60 split equally (each owes $20)
    await trpcMutation(memberContexts[0], "expenses.create", {
      groupId, title: "Bob pays", amount: 6000, paidById: b, splitMode: "EQUAL",
      shares: [{ userId: a, amount: 2000 }, { userId: b, amount: 2000 }, { userId: c, amount: 2000 }],
    });

    const res = await trpcQuery(owner, "balances.getGroupBalances", { groupId });
    const balances = (await trpcResult(res)).balances;
    const aliceBal = balances.find((x: { userId: string }) => x.userId === a);
    const bobBal = balances.find((x: { userId: string }) => x.userId === b);
    const charlieBal = balances.find((x: { userId: string }) => x.userId === c);

    // Alice: paid 3000, owes 1000+2000=3000 → net 0... wait
    // Actually: Alice paid $30, owes $10+$20=$30 → net 0? No.
    // Alice paid $30 total. Alice owes $10 (to herself) + $20 (to Bob) = $30. net = 30-30 = 0?
    // Wait: paid=3000 (she paid the $30 expense), owes=1000+2000=3000 (her share of both). net=0
    // Bob: paid=6000, owes=1000+2000=3000. net=+3000
    // Charlie: paid=0, owes=1000+2000=3000. net=-3000
    // Hmm but Alice paid for Bob and Charlie's share too...
    // paid tracks total expense paid, owes tracks total share owed
    // Alice: paid=3000, owes=3000, net=0
    // Bob: paid=6000, owes=3000, net=+3000
    // Charlie: paid=0, owes=3000, net=-3000

    // Actually let me reconsider. net = paid - owes.
    // Alice paid 3000, owes 3000 → net 0. But Alice paid for others...
    // The balance system counts: paid = sum of all expenses you paid for.
    // owes = sum of all your shares across expenses.
    // So Alice: paid 3000 (the $30 expense), owes 1000+2000 = 3000. net=0.
    // That means Alice is owed $20 by Bob/Charlie for her expense, but she owes Bob $20 for his.
    // Net: 0. Makes sense.

    expect(aliceBal.net).toBe(0);
    expect(bobBal.net).toBe(3000); // Bob is owed $30
    expect(charlieBal.net).toBe(-3000); // Charlie owes $30
    await dispose();
  });

  test("4.1.3 — single member pays for self, net is zero", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "Zero Balance Test"
    );
    const a = memberIds[users.alice.email];

    await trpcMutation(owner, "expenses.create", {
      groupId, title: "Self", amount: 5000, paidById: a, splitMode: "EQUAL",
      shares: [{ userId: a, amount: 5000 }],
    });

    const res = await trpcQuery(owner, "balances.getGroupBalances", { groupId });
    const balances = (await trpcResult(res)).balances;
    const aliceBal = balances.find((x: { userId: string }) => x.userId === a);
    expect(aliceBal.net).toBe(0);
    await dispose();
  });

  test("4.1.4 — settlement affects balance", async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Settlement Balance Test"
    );
    const a = memberIds[users.alice.email];
    const b = memberIds[users.bob.email];

    // Alice pays $20 split equally
    await trpcMutation(owner, "expenses.create", {
      groupId, title: "Dinner", amount: 2000, paidById: a, splitMode: "EQUAL",
      shares: [{ userId: a, amount: 1000 }, { userId: b, amount: 1000 }],
    });

    // Before settlement: Alice net +1000, Bob net -1000
    const before = await trpcQuery(owner, "balances.getGroupBalances", { groupId });
    const balBefore = (await trpcResult(before)).balances;
    expect(balBefore.find((x: { userId: string }) => x.userId === a).net).toBe(1000);

    // Bob settles $10 to Alice
    await trpcMutation(memberContexts[0], "settlements.create", {
      groupId, toId: a, amount: 1000,
    });

    // After settlement: should be zero
    const after = await trpcQuery(owner, "balances.getGroupBalances", { groupId });
    const balAfter = (await trpcResult(after)).balances;
    const aliceAfter = balAfter.find((x: { userId: string }) => x.userId === a);
    const bobAfter = balAfter.find((x: { userId: string }) => x.userId === b);
    expect(aliceAfter.net).toBe(0);
    expect(bobAfter.net).toBe(0);
    await dispose();
  });
});

test.describe("Debt Simplification (4.2)", () => {
  test("4.2.2 — three-person chain", async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [
        { email: users.bob.email, password: users.bob.password },
        { email: users.charlie.email, password: users.charlie.password },
      ],
      "Three Person Chain"
    );
    const a = memberIds[users.alice.email];
    const b = memberIds[users.bob.email];
    const c = memberIds[users.charlie.email];

    // Alice pays $30 for all three → each owes $10
    // Alice net: +20, Bob net: -10, Charlie net: -10
    await trpcMutation(owner, "expenses.create", {
      groupId, title: "All", amount: 3000, paidById: a, splitMode: "EQUAL",
      shares: [{ userId: a, amount: 1000 }, { userId: b, amount: 1000 }, { userId: c, amount: 1000 }],
    });

    const res = await trpcQuery(owner, "balances.getSimplifiedDebts", { groupId });
    const debts = (await trpcResult(res)).debts;
    expect(debts.length).toBe(2);
    // Both Bob and Charlie owe Alice
    expect(debts.every((d: { to: string }) => d.to === a)).toBe(true);
    const total = debts.reduce((s: number, d: { amount: number }) => s + d.amount, 0);
    expect(total).toBe(2000);
    await dispose();
  });

  test("4.2.3 — circular debts cancel out", async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [
        { email: users.bob.email, password: users.bob.password },
        { email: users.charlie.email, password: users.charlie.password },
      ],
      "Circular Debts"
    );
    const a = memberIds[users.alice.email];
    const b = memberIds[users.bob.email];
    const c = memberIds[users.charlie.email];

    // Alice pays $10 for Bob
    await trpcMutation(owner, "expenses.create", {
      groupId, title: "A→B", amount: 1000, paidById: a, splitMode: "EXACT",
      shares: [{ userId: b, amount: 1000 }],
    });
    // Bob pays $10 for Charlie
    await trpcMutation(memberContexts[0], "expenses.create", {
      groupId, title: "B→C", amount: 1000, paidById: b, splitMode: "EXACT",
      shares: [{ userId: c, amount: 1000 }],
    });
    // Charlie pays $10 for Alice
    await trpcMutation(memberContexts[1], "expenses.create", {
      groupId, title: "C→A", amount: 1000, paidById: c, splitMode: "EXACT",
      shares: [{ userId: a, amount: 1000 }],
    });

    const res = await trpcQuery(owner, "balances.getSimplifiedDebts", { groupId });
    const debts = (await trpcResult(res)).debts;
    expect(debts.length).toBe(0); // All cancel out
    await dispose();
  });

  test("4.2.5 — greedy matching minimizes transactions", async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [
        { email: users.bob.email, password: users.bob.password },
        { email: users.charlie.email, password: users.charlie.password },
      ],
      "Greedy Test"
    );
    const a = memberIds[users.alice.email];
    const b = memberIds[users.bob.email];
    const c = memberIds[users.charlie.email];

    // Create complex debts: A pays $50 for all, B pays $20 for all
    await trpcMutation(owner, "expenses.create", {
      groupId, title: "Big", amount: 5100, paidById: a, splitMode: "EQUAL",
      shares: [{ userId: a, amount: 1700 }, { userId: b, amount: 1700 }, { userId: c, amount: 1700 }],
    });
    await trpcMutation(memberContexts[0], "expenses.create", {
      groupId, title: "Small", amount: 2100, paidById: b, splitMode: "EQUAL",
      shares: [{ userId: a, amount: 700 }, { userId: b, amount: 700 }, { userId: c, amount: 700 }],
    });

    const res = await trpcQuery(owner, "balances.getSimplifiedDebts", { groupId });
    const debts = (await trpcResult(res)).debts;
    // Should produce minimal transactions (≤ 2 for 3 people)
    expect(debts.length).toBeLessThanOrEqual(2);
    await dispose();
  });
});

test.describe("Dashboard (4.3)", () => {
  test("4.3.2 — per-group breakdown", async () => {
    const alice = await (await import("./helpers")).authedContext(users.alice.email, users.alice.password);
    const res = await trpcQuery(alice, "balances.getDashboard");
    const data = await trpcResult(res);
    expect(data.perGroup.length).toBeGreaterThanOrEqual(2);
    for (const g of data.perGroup) {
      expect(g.groupId).toBeDefined();
      expect(g.groupName).toBeDefined();
      expect(typeof g.balance).toBe("number");
    }
    await alice.dispose();
  });
});

test.describe("Settlements (4.4)", () => {
  test("4.4.2 — settlement updates balance", async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Settle Update Test"
    );
    const a = memberIds[users.alice.email];
    const b = memberIds[users.bob.email];

    await trpcMutation(owner, "expenses.create", {
      groupId, title: "Meal", amount: 4000, paidById: a, splitMode: "EQUAL",
      shares: [{ userId: a, amount: 2000 }, { userId: b, amount: 2000 }],
    });

    // Bob settles $20
    await trpcMutation(memberContexts[0], "settlements.create", {
      groupId, toId: a, amount: 2000,
    });

    const debts = await trpcQuery(owner, "balances.getSimplifiedDebts", { groupId });
    expect((await trpcResult(debts)).debts.length).toBe(0);
    await dispose();
  });

  test("4.4.4 — partial settlement", async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Partial Settle Test"
    );
    const a = memberIds[users.alice.email];
    const b = memberIds[users.bob.email];

    await trpcMutation(owner, "expenses.create", {
      groupId, title: "Dinner", amount: 4000, paidById: a, splitMode: "EQUAL",
      shares: [{ userId: a, amount: 2000 }, { userId: b, amount: 2000 }],
    });

    // Bob settles only $10 of the $20 owed
    await trpcMutation(memberContexts[0], "settlements.create", {
      groupId, toId: a, amount: 1000,
    });

    const debts = await trpcQuery(owner, "balances.getSimplifiedDebts", { groupId });
    const debtList = (await trpcResult(debts)).debts;
    expect(debtList.length).toBe(1);
    expect(debtList[0].amount).toBe(1000); // $10 remaining
    await dispose();
  });
});
