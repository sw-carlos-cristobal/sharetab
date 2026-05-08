import { test, expect, request } from "@playwright/test";
import { trpcMutation, trpcQuery, trpcResult, trpcError } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

const RECEIPT_DATA = {
  merchantName: "Test Cafe",
  subtotal: 2000,
  tax: 200,
  tip: 100,
  total: 2300,
  currency: "USD",
};

const ITEMS = [
  { name: "Item 1", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
  { name: "Item 2", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
];

test.describe("Guest claiming sessions", () => {
  test("create session and join", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create a claiming session
    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: "Alice",
      paidByName: "Alice",
    });
    expect(createRes.ok()).toBe(true);
    const createBody = (await createRes.json()).result?.data?.json;
    const shareToken = createBody.shareToken;
    expect(shareToken).toBeTruthy();

    // Get session -- verify status and initial state
    const getRes = await trpcQuery(ctx, "guest.getSession", { token: shareToken });
    const session = await trpcResult(getRes);
    expect(session.status).toBe("claiming");
    expect(session.items).toHaveLength(2);
    expect(session.people).toHaveLength(1);
    expect(session.people[0].name).toBe("Alice");

    // Join session as "Bob"
    const joinRes = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Bob",
    });
    expect(joinRes.ok()).toBe(true);
    const joinBody = (await joinRes.json()).result?.data?.json;
    expect(joinBody.personIndex).toBe(1);
    expect(joinBody.personToken).toBeTruthy();

    // Verify 2 people now
    const getRes2 = await trpcQuery(ctx, "guest.getSession", { token: shareToken });
    const session2 = await trpcResult(getRes2);
    expect(session2.people).toHaveLength(2);
    expect(session2.people[1].name).toBe("Bob");

    await ctx.dispose();
  });

  test("claim items and verify assignments", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create session
    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Join as Alice (creator) to get a personToken
    const joinRes = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Alice",
    });
    const { personIndex, personToken } = (await joinRes.json()).result?.data?.json;
    expect(personIndex).toBe(0);

    // Claim items 0 and 1
    const claimRes = await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex,
      personToken,
      claimedItemIndices: [0, 1],
    });
    expect(claimRes.ok()).toBe(true);
    expect((await claimRes.json()).result?.data?.json?.success).toBe(true);

    // Verify assignments
    const getRes = await trpcQuery(ctx, "guest.getSession", { token: shareToken });
    const session = await trpcResult(getRes);
    expect(session.assignments.length).toBeGreaterThanOrEqual(1);

    // Both items should be assigned to person 0
    const item0Assignment = session.assignments.find(
      (a: { itemIndex: number }) => a.itemIndex === 0
    );
    const item1Assignment = session.assignments.find(
      (a: { itemIndex: number }) => a.itemIndex === 1
    );
    expect(item0Assignment).toBeDefined();
    expect(item0Assignment.personIndices).toContain(0);
    expect(item1Assignment).toBeDefined();
    expect(item1Assignment.personIndices).toContain(0);

    await ctx.dispose();
  });

  test("finalize session calculates totals", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create session with 2 items
    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: "Alice",
      paidByName: "Bob",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Join as Alice (person 0)
    const joinAlice = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Alice",
    });
    const aliceJoin = (await joinAlice.json()).result?.data?.json;

    // Join as Bob (person 1)
    const joinBob = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Bob",
    });
    const bobJoin = (await joinBob.json()).result?.data?.json;

    // Alice claims item 0
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex: aliceJoin.personIndex,
      personToken: aliceJoin.personToken,
      claimedItemIndices: [0],
    });

    // Bob claims item 1
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex: bobJoin.personIndex,
      personToken: bobJoin.personToken,
      claimedItemIndices: [1],
    });

    // Finalize (Alice finalizes)
    const finalizeRes = await trpcMutation(ctx, "guest.finalizeSession", {
      token: shareToken,
      personIndex: aliceJoin.personIndex,
      personToken: aliceJoin.personToken,
    });
    expect(finalizeRes.ok()).toBe(true);

    // Get session -- verify finalized status and summary
    const getRes = await trpcQuery(ctx, "guest.getSession", { token: shareToken });
    const session = await trpcResult(getRes);
    expect(session.status).toBe("finalized");
    expect(session.summary).toBeTruthy();
    expect(session.summary.length).toBeGreaterThanOrEqual(1);

    // Verify summary totals are positive
    for (const entry of session.summary) {
      expect(entry.total).toBeGreaterThan(0);
      expect(entry.name).toBeTruthy();
    }

    await ctx.dispose();
  });

  test("joining with same name returns existing index", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // First join as Alice -- gets personToken
    const join1 = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Alice",
    });
    const result1 = (await join1.json()).result?.data?.json;
    expect(result1.personIndex).toBe(0);
    const personToken = result1.personToken;

    // Join again with the same name (case-insensitive) and the same personToken
    const join2 = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "alice",
      personToken,
    });
    const result2 = (await join2.json()).result?.data?.json;
    expect(result2.personIndex).toBe(0);
    expect(result2.personToken).toBe(personToken);

    await ctx.dispose();
  });

  test("rejects claims on finalized session", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Join as Alice
    const joinRes = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Alice",
    });
    const { personIndex, personToken } = (await joinRes.json()).result?.data?.json;

    // Finalize
    await trpcMutation(ctx, "guest.finalizeSession", {
      token: shareToken,
      personIndex,
      personToken,
    });

    // Try to claim items on finalized session
    const claimRes = await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex,
      personToken,
      claimedItemIndices: [0],
    });
    const err = await trpcError(claimRes);
    expect(err?.data?.code).toBe("BAD_REQUEST");

    await ctx.dispose();
  });

  test("getSplit rejects claiming sessions", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create a claiming session (not yet finalized)
    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Try to get it via getSplit (which expects finalized splits)
    const getRes = await trpcQuery(ctx, "guest.getSplit", { token: shareToken });
    const body = await getRes.json();
    const error = body[0]?.error;
    expect(error).toBeTruthy();
    // getSplit checks status !== "finalized" and returns CONFLICT
    expect(error?.json?.data?.code).toBe("CONFLICT");

    await ctx.dispose();
  });

  test("creator and paidBy are different people when names differ", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: "Alice",
      paidByName: "Bob",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    const getRes = await trpcQuery(ctx, "guest.getSession", { token: shareToken });
    const session = await trpcResult(getRes);

    // Should have 2 people: Alice and Bob
    expect(session.people).toHaveLength(2);
    expect(session.people[0].name).toBe("Alice");
    expect(session.people[1].name).toBe("Bob");
    expect(session.paidByIndex).toBe(1);

    await ctx.dispose();
  });

  test("creator and paidBy are same person when names match", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    const getRes = await trpcQuery(ctx, "guest.getSession", { token: shareToken });
    const session = await trpcResult(getRes);

    // Should have 1 person since creator === paidBy
    expect(session.people).toHaveLength(1);
    expect(session.people[0].name).toBe("Alice");
    expect(session.paidByIndex).toBe(0);

    await ctx.dispose();
  });
});
