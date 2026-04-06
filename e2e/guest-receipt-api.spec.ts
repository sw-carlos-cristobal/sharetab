import { test, expect, request } from "@playwright/test";
import {
  authedContext,
  users,
  trpcMutation,
  trpcQuery,
  trpcError,
  FAKE_JPEG,
} from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

/** Upload a tiny JPEG as an authenticated user and return the receiptId. */
async function uploadAuthReceipt(ctx: Awaited<ReturnType<typeof authedContext>>) {
  const res = await ctx.post("/api/upload", {
    multipart: {
      file: { name: "receipt.jpg", mimeType: "image/jpeg", buffer: FAKE_JPEG },
    },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as { receiptId: string; imagePath: string };
}

test.describe("Guest receipt API — security & validation (#43)", () => {
  // These tests verify error paths only — no AI processing required.

  test("processReceipt with non-existent receiptId returns NOT_FOUND", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await trpcMutation(ctx, "guest.processReceipt", {
      receiptId: "00000000-0000-0000-0000-000000000000",
    });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("NOT_FOUND");
    await ctx.dispose();
  });

  test("getReceiptItems with non-existent receiptId returns NOT_FOUND", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await trpcQuery(ctx, "guest.getReceiptItems", {
      receiptId: "00000000-0000-0000-0000-000000000000",
    });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("NOT_FOUND");
    await ctx.dispose();
  });

  test("processReceipt on auth-uploaded receipt (isGuest=false) returns NOT_FOUND", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const { receiptId } = await uploadAuthReceipt(alice);

    // Use a plain unauthenticated context to hit guest endpoints
    const guestCtx = await request.newContext({ baseURL: BASE });
    const res = await trpcMutation(guestCtx, "guest.processReceipt", { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    // Must be NOT_FOUND (not FORBIDDEN) to avoid leaking existence
    expect(err.data.code).toBe("NOT_FOUND");

    await alice.dispose();
    await guestCtx.dispose();
  });

  test("getReceiptItems on auth-uploaded receipt returns NOT_FOUND", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const { receiptId } = await uploadAuthReceipt(alice);

    const guestCtx = await request.newContext({ baseURL: BASE });
    const res = await trpcQuery(guestCtx, "guest.getReceiptItems", { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("NOT_FOUND");

    await alice.dispose();
    await guestCtx.dispose();
  });

  test("createSplit with empty people array returns BAD_REQUEST", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        subtotal: 1000,
        tax: 0,
        tip: 0,
        total: 1000,
        currency: "USD",
      },
      items: [{ name: "Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
      people: [],
      assignments: [{ itemIndex: 0, personIndices: [] }],
      paidByIndex: 0,
    });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("BAD_REQUEST");
    await ctx.dispose();
  });

  test("createSplit with out-of-bounds itemIndex returns BAD_REQUEST", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        subtotal: 1000,
        tax: 0,
        tip: 0,
        total: 1000,
        currency: "USD",
      },
      items: [{ name: "Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
      people: [{ name: "Alice" }],
      assignments: [{ itemIndex: 99, personIndices: [0] }],
      paidByIndex: 0,
    });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("BAD_REQUEST");
    await ctx.dispose();
  });

  test("createSplit with out-of-bounds personIndex returns BAD_REQUEST", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        subtotal: 1000,
        tax: 0,
        tip: 0,
        total: 1000,
        currency: "USD",
      },
      items: [{ name: "Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
      people: [{ name: "Alice" }],
      assignments: [{ itemIndex: 0, personIndices: [99] }],
      paidByIndex: 0,
    });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("BAD_REQUEST");
    await ctx.dispose();
  });

  test("getSplit with expired/invalid token returns NOT_FOUND", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await trpcQuery(ctx, "guest.getSplit", {
      token: "expired-token-that-does-not-exist",
    });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("NOT_FOUND");
    await ctx.dispose();
  });
});
