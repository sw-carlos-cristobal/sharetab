import { test, expect, request } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:3001";

async function authedContext(email: string, password: string) {
  const ctx = await request.newContext({ baseURL: BASE });
  const csrfRes = await ctx.get("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  await ctx.post("/api/auth/callback/credentials", {
    form: { email, password, csrfToken },
    maxRedirects: 0,
  });
  return ctx;
}

async function trpcMutation(ctx: Awaited<ReturnType<typeof request.newContext>>, proc: string, input: unknown) {
  return ctx.post(`/api/trpc/${proc}`, { data: { json: input } });
}

async function trpcQuery(ctx: Awaited<ReturnType<typeof request.newContext>>, proc: string, input?: unknown) {
  const inputStr = input
    ? encodeURIComponent(JSON.stringify({ "0": { json: input } }))
    : encodeURIComponent(JSON.stringify({ "0": { json: null, meta: { values: ["undefined"], v: 1 } } }));
  return ctx.get(`/api/trpc/${proc}?batch=1&input=${inputStr}`);
}

test.describe("Balances & Settlements API", () => {
  test.describe("Balance Calculation", () => {
    test("4.1.1 — single expense balance", async () => {
      const ctx = await authedContext("alice@example.com", "password123");

      // Create isolated group
      const groupRes = await trpcMutation(ctx, "groups.create", { name: "Balance Test 4.1.1" });
      const groupId = (await groupRes.json()).result?.data?.json?.id;

      // Invite Bob
      const bob = await authedContext("bob@example.com", "password123");
      const invRes = await trpcMutation(ctx, "groups.createInvite", { groupId });
      const token = (await invRes.json()).result?.data?.json?.token;
      await trpcMutation(bob, "groups.joinByInvite", { token });

      // Get member IDs
      const groupDetail = await trpcQuery(ctx, "groups.get", { groupId });
      const groupData = (await groupDetail.json())[0]?.result?.data?.json;
      const aliceId = groupData.members.find((m: { user: { email: string } }) => m.user.email === "alice@example.com")?.user.id;
      const bobId = groupData.members.find((m: { user: { email: string } }) => m.user.email === "bob@example.com")?.user.id;

      // Alice pays $30, split equally between Alice and Bob
      await trpcMutation(ctx, "expenses.create", {
        groupId,
        title: "Test Expense",
        amount: 3000,
        paidById: aliceId,
        splitMode: "EQUAL",
        shares: [
          { userId: aliceId, amount: 1500 },
          { userId: bobId, amount: 1500 },
        ],
      });

      // Check balances
      const balRes = await trpcQuery(ctx, "balances.getGroupBalances", { groupId });
      const balances = (await balRes.json())[0]?.result?.data?.json?.balances;

      const aliceBal = balances.find((b: { userId: string }) => b.userId === aliceId);
      const bobBal = balances.find((b: { userId: string }) => b.userId === bobId);

      expect(aliceBal.net).toBe(1500); // Alice is owed $15
      expect(bobBal.net).toBe(-1500); // Bob owes $15

      await ctx.dispose();
      await bob.dispose();
    });

    test("4.1.5 — empty group has zero balances", async () => {
      const ctx = await authedContext("alice@example.com", "password123");
      const groupRes = await trpcMutation(ctx, "groups.create", { name: "Empty Group 4.1.5" });
      const groupId = (await groupRes.json()).result?.data?.json?.id;

      const balRes = await trpcQuery(ctx, "balances.getGroupBalances", { groupId });
      const balances = (await balRes.json())[0]?.result?.data?.json?.balances;
      expect(balances.length).toBe(0);

      await ctx.dispose();
    });
  });

  test.describe("Debt Simplification", () => {
    test("4.2.1 — simple two-person debt", async () => {
      const ctx = await authedContext("alice@example.com", "password123");

      const groupRes = await trpcMutation(ctx, "groups.create", { name: "Debt Test 4.2.1" });
      const groupId = (await groupRes.json()).result?.data?.json?.id;

      const bob = await authedContext("bob@example.com", "password123");
      const invRes = await trpcMutation(ctx, "groups.createInvite", { groupId });
      const token = (await invRes.json()).result?.data?.json?.token;
      await trpcMutation(bob, "groups.joinByInvite", { token });

      const groupDetail = await trpcQuery(ctx, "groups.get", { groupId });
      const groupData = (await groupDetail.json())[0]?.result?.data?.json;
      const aliceId = groupData.members.find((m: { user: { email: string } }) => m.user.email === "alice@example.com")?.user.id;
      const bobId = groupData.members.find((m: { user: { email: string } }) => m.user.email === "bob@example.com")?.user.id;

      // Alice pays $20 for both
      await trpcMutation(ctx, "expenses.create", {
        groupId,
        title: "Lunch",
        amount: 2000,
        paidById: aliceId,
        splitMode: "EQUAL",
        shares: [
          { userId: aliceId, amount: 1000 },
          { userId: bobId, amount: 1000 },
        ],
      });

      const debtsRes = await trpcQuery(ctx, "balances.getSimplifiedDebts", { groupId });
      const debts = (await debtsRes.json())[0]?.result?.data?.json?.debts;

      expect(debts.length).toBe(1);
      expect(debts[0].from).toBe(bobId);
      expect(debts[0].to).toBe(aliceId);
      expect(debts[0].amount).toBe(1000);

      await ctx.dispose();
      await bob.dispose();
    });

    test("4.2.4 — already settled returns empty debts", async () => {
      const ctx = await authedContext("alice@example.com", "password123");
      const groupRes = await trpcMutation(ctx, "groups.create", { name: "Settled 4.2.4" });
      const groupId = (await groupRes.json()).result?.data?.json?.id;

      const debtsRes = await trpcQuery(ctx, "balances.getSimplifiedDebts", { groupId });
      const debts = (await debtsRes.json())[0]?.result?.data?.json?.debts;
      expect(debts.length).toBe(0);

      await ctx.dispose();
    });
  });

  test.describe("Dashboard", () => {
    test("4.3.1 — cross-group totals", async () => {
      const ctx = await authedContext("alice@example.com", "password123");
      const res = await trpcQuery(ctx, "balances.getDashboard");
      const data = (await res.json())[0]?.result?.data?.json;

      expect(data.totalOwed).toBeGreaterThanOrEqual(0);
      expect(data.totalOwing).toBeGreaterThanOrEqual(0);
      expect(data.perGroup.length).toBeGreaterThanOrEqual(2);
      await ctx.dispose();
    });
  });

  test.describe("Settlements", () => {
    test("4.4.1 — record settlement", async () => {
      const ctx = await authedContext("alice@example.com", "password123");

      // Create group with Bob
      const groupRes = await trpcMutation(ctx, "groups.create", { name: "Settle Test 4.4.1" });
      const groupId = (await groupRes.json()).result?.data?.json?.id;

      const bob = await authedContext("bob@example.com", "password123");
      const invRes = await trpcMutation(ctx, "groups.createInvite", { groupId });
      const token = (await invRes.json()).result?.data?.json?.token;
      await trpcMutation(bob, "groups.joinByInvite", { token });

      const groupDetail = await trpcQuery(ctx, "groups.get", { groupId });
      const members = (await groupDetail.json())[0]?.result?.data?.json?.members;
      const aliceId = members.find((m: { user: { email: string } }) => m.user.email === "alice@example.com")?.user.id;
      const bobId = members.find((m: { user: { email: string } }) => m.user.email === "bob@example.com")?.user.id;

      // Alice pays $50, Bob pays half
      await trpcMutation(ctx, "expenses.create", {
        groupId,
        title: "Dinner",
        amount: 5000,
        paidById: aliceId,
        splitMode: "EQUAL",
        shares: [
          { userId: aliceId, amount: 2500 },
          { userId: bobId, amount: 2500 },
        ],
      });

      // Bob settles $25 to Alice
      const settleRes = await trpcMutation(bob, "settlements.create", {
        groupId,
        toId: aliceId,
        amount: 2500,
        note: "Venmo",
      });
      const settle = await settleRes.json();
      expect(settle.result?.data?.json?.amount).toBe(2500);

      // 4.4.3 — full settlement means debts are zero
      const debtsRes = await trpcQuery(ctx, "balances.getSimplifiedDebts", { groupId });
      const debts = (await debtsRes.json())[0]?.result?.data?.json?.debts;
      expect(debts.length).toBe(0);

      await ctx.dispose();
      await bob.dispose();
    });
  });
});
