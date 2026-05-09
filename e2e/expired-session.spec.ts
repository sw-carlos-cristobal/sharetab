import { test, expect, request } from "@playwright/test";
import { trpcMutation, trpcError, authedContext, users } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

async function createSessionWithToken() {
  const authed = await authedContext(users.alice.email, users.alice.password);

  const createRes = await trpcMutation(authed, "guest.createClaimSession", {
    receiptData: {
      merchantName: "Guard Test",
      subtotal: 1000,
      tax: 100,
      tip: 0,
      total: 1100,
      currency: "USD",
    },
    items: [{ name: "Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
    creatorName: "Alice",
    paidByName: "Bob",
  });
  const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

  const ctx = await request.newContext({ baseURL: BASE });
  const joinRes = await trpcMutation(ctx, "guest.joinSession", {
    token: shareToken,
    name: "Alice",
  });
  const { personToken } = (await joinRes.json()).result?.data?.json;

  return { ctx, authed, shareToken, personToken };
}

test.describe("Session mutation guards — finalized", () => {
  test("editPersonName rejects finalized sessions", async () => {
    const { ctx, authed, shareToken, personToken } = await createSessionWithToken();

    await trpcMutation(ctx, "guest.finalizeSession", {
      token: shareToken, personIndex: 0, personToken,
    });

    const res = await trpcMutation(ctx, "guest.editPersonName", {
      token: shareToken, personToken, targetIndex: 0, newName: "Carol",
    });
    expect((await trpcError(res))?.data?.code).toBe("BAD_REQUEST");
    await authed.dispose();
    await ctx.dispose();
  });

  test("removePerson rejects finalized sessions", async () => {
    const { ctx, authed, shareToken, personToken } = await createSessionWithToken();

    await trpcMutation(ctx, "guest.finalizeSession", {
      token: shareToken, personIndex: 0, personToken,
    });

    const res = await trpcMutation(ctx, "guest.removePerson", {
      token: shareToken, personToken, targetIndex: 1,
    });
    expect((await trpcError(res))?.data?.code).toBe("BAD_REQUEST");
    await authed.dispose();
    await ctx.dispose();
  });

  test("splitClaimItem rejects finalized sessions", async () => {
    const { ctx, authed, shareToken, personToken } = await createSessionWithToken();

    await trpcMutation(ctx, "guest.finalizeSession", {
      token: shareToken, personIndex: 0, personToken,
    });

    const res = await trpcMutation(ctx, "guest.splitClaimItem", {
      token: shareToken, personToken, itemIndex: 0, splitQuantity: 1,
    });
    expect((await trpcError(res))?.data?.code).toBe("BAD_REQUEST");
    await authed.dispose();
    await ctx.dispose();
  });
});

test.describe("Session mutation guards — expired", () => {
  test("editPersonName rejects expired sessions", async () => {
    const { ctx, authed, shareToken, personToken } = await createSessionWithToken();

    await trpcMutation(authed, "guest.expireSession", { token: shareToken });

    const res = await trpcMutation(ctx, "guest.editPersonName", {
      token: shareToken, personToken, targetIndex: 0, newName: "Carol",
    });
    const err = await trpcError(res);
    expect(err?.data?.code).toBe("NOT_FOUND");
    await authed.dispose();
    await ctx.dispose();
  });

  test("removePerson rejects expired sessions", async () => {
    const { ctx, authed, shareToken, personToken } = await createSessionWithToken();

    await trpcMutation(authed, "guest.expireSession", { token: shareToken });

    const res = await trpcMutation(ctx, "guest.removePerson", {
      token: shareToken, personToken, targetIndex: 1,
    });
    const err = await trpcError(res);
    expect(err?.data?.code).toBe("NOT_FOUND");
    await authed.dispose();
    await ctx.dispose();
  });

  test("splitClaimItem rejects expired sessions", async () => {
    const { ctx, authed, shareToken, personToken } = await createSessionWithToken();

    await trpcMutation(authed, "guest.expireSession", { token: shareToken });

    const res = await trpcMutation(ctx, "guest.splitClaimItem", {
      token: shareToken, personToken, itemIndex: 0, splitQuantity: 1,
    });
    const err = await trpcError(res);
    expect(err?.data?.code).toBe("NOT_FOUND");
    await authed.dispose();
    await ctx.dispose();
  });

  test("joinSession rejects expired sessions", async () => {
    const { ctx, authed, shareToken } = await createSessionWithToken();

    await trpcMutation(authed, "guest.expireSession", { token: shareToken });

    const res = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Carol",
    });
    const err = await trpcError(res);
    expect(err?.data?.code).toBe("NOT_FOUND");
    await authed.dispose();
    await ctx.dispose();
  });

  test("claimItems rejects expired sessions", async () => {
    const { ctx, authed, shareToken, personToken } = await createSessionWithToken();

    await trpcMutation(authed, "guest.expireSession", { token: shareToken });

    const res = await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken, personIndex: 0, personToken, claimedItemIndices: [0],
    });
    const err = await trpcError(res);
    expect(err?.data?.code).toBe("NOT_FOUND");
    await authed.dispose();
    await ctx.dispose();
  });

  test("finalizeSession rejects expired sessions", async () => {
    const { ctx, authed, shareToken, personToken } = await createSessionWithToken();

    await trpcMutation(authed, "guest.expireSession", { token: shareToken });

    const res = await trpcMutation(ctx, "guest.finalizeSession", {
      token: shareToken, personIndex: 0, personToken,
    });
    const err = await trpcError(res);
    expect(err?.data?.code).toBe("NOT_FOUND");
    await authed.dispose();
    await ctx.dispose();
  });

  test("getSession rejects expired sessions", async () => {
    const { ctx, authed, shareToken } = await createSessionWithToken();

    await trpcMutation(authed, "guest.expireSession", { token: shareToken });

    const res = await request.newContext({ baseURL: BASE });
    const getRes = await res.get(
      `/api/trpc/guest.getSession?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: { token: shareToken } } }))}`
    );
    const body = await getRes.json();
    const error = body[0]?.error;
    expect(error?.json?.data?.code).toBe("NOT_FOUND");
    await authed.dispose();
    await ctx.dispose();
    await res.dispose();
  });
});
