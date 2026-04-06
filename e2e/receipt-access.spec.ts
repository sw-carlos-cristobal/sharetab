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

/** Upload a tiny JPEG as an authenticated user and return the receiptId + imagePath. */
async function uploadReceipt(ctx: Awaited<ReturnType<typeof authedContext>>) {
  const res = await ctx.post("/api/upload", {
    multipart: {
      file: { name: "receipt.jpg", mimeType: "image/jpeg", buffer: FAKE_JPEG },
    },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as { receiptId: string; imagePath: string };
}

/** Upload a tiny JPEG as a guest and return the receiptId + imagePath. */
async function uploadGuestReceipt() {
  const ctx = await request.newContext({ baseURL: BASE });
  const res = await ctx.post("/api/upload?guest=true", {
    multipart: {
      file: { name: "guest-receipt.jpg", mimeType: "image/jpeg", buffer: FAKE_JPEG },
    },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { receiptId: string; imagePath: string };
  await ctx.dispose();
  return body;
}

test.describe("Receipt access control", () => {
  test("User B cannot getReceiptItems for User A's receipt", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const bob = await authedContext(users.bob.email, users.bob.password);

    const { receiptId } = await uploadReceipt(alice);

    const res = await trpcQuery(bob, "receipts.getReceiptItems", { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("FORBIDDEN");

    await alice.dispose();
    await bob.dispose();
  });

  test("User B cannot processReceipt for User A's receipt", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const bob = await authedContext(users.bob.email, users.bob.password);

    const { receiptId } = await uploadReceipt(alice);

    const res = await trpcMutation(bob, "receipts.processReceipt", { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("FORBIDDEN");

    await alice.dispose();
    await bob.dispose();
  });

  test("User B cannot deletePending for User A's receipt", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const bob = await authedContext(users.bob.email, users.bob.password);

    const { receiptId } = await uploadReceipt(alice);

    const res = await trpcMutation(bob, "receipts.deletePending", { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("FORBIDDEN");

    await alice.dispose();
    await bob.dispose();
  });

  test("Guest-uploaded receipt not accessible via auth endpoints", async () => {
    const { receiptId } = await uploadGuestReceipt();
    const alice = await authedContext(users.alice.email, users.alice.password);

    // uploadedById is null for guest receipts, so no authenticated user should match
    const res = await trpcQuery(alice, "receipts.getReceiptItems", { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("FORBIDDEN");

    await alice.dispose();
  });

  test("Auth-uploaded receipt not accessible via guest endpoints", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const { receiptId } = await uploadReceipt(alice);

    // Guest endpoint should reject non-guest receipts
    const guestCtx = await request.newContext({ baseURL: BASE });
    const res = await trpcQuery(guestCtx, "guest.getReceiptItems", { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe("NOT_FOUND");

    await alice.dispose();
    await guestCtx.dispose();
  });

  test("User B cannot fetch User A's receipt image", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const bob = await authedContext(users.bob.email, users.bob.password);

    const { imagePath } = await uploadReceipt(alice);

    const res = await bob.get(`/api/uploads/${imagePath}`);
    expect(res.status()).toBe(403);

    await alice.dispose();
    await bob.dispose();
  });

  test("Authenticated user can fetch guest receipt image", async () => {
    const { imagePath } = await uploadGuestReceipt();
    const alice = await authedContext(users.alice.email, users.alice.password);

    const res = await alice.get(`/api/uploads/${imagePath}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/jpeg");

    await alice.dispose();
  });

  test("Unauthenticated user can fetch guest receipt image", async () => {
    const { imagePath } = await uploadGuestReceipt();
    const ctx = await request.newContext({ baseURL: BASE });

    const res = await ctx.get(`/api/uploads/${imagePath}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/jpeg");

    await ctx.dispose();
  });

  test("Unauthenticated user cannot fetch auth-uploaded receipt image", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const { imagePath } = await uploadReceipt(alice);

    const ctx = await request.newContext({ baseURL: BASE });
    const res = await ctx.get(`/api/uploads/${imagePath}`);
    expect(res.status()).toBe(401);

    await alice.dispose();
    await ctx.dispose();
  });
});
