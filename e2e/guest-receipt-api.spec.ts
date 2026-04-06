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

test.describe("Guest split — blank-name remapping (#53, #56)", () => {
  // Regression: createSplit with blank names should filter them and remap indices correctly.

  test("blank names are filtered and paidByIndex remaps correctly", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // people[0]="Alice", people[1]="" (blank), people[2]="Bob"
    // After filtering: ["Alice", "Bob"] — Alice=0, Bob=1
    // paidByIndex=2 (Bob) should remap to 1
    const createRes = await ctx.post("/api/trpc/guest.createSplit", {
      data: {
        json: {
          receiptData: {
            merchantName: "Remap Test",
            subtotal: 2000,
            tax: 0,
            tip: 0,
            total: 2000,
            currency: "USD",
          },
          items: [
            { name: "Item A", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
            { name: "Item B", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
          ],
          // Alice (0), blank (1), Bob (2)
          people: [{ name: "Alice" }, { name: "" }, { name: "Bob" }],
          assignments: [
            { itemIndex: 0, personIndices: [0] },       // Alice
            { itemIndex: 1, personIndices: [2] },       // Bob (original index 2)
          ],
          paidByIndex: 2, // Bob paid — should remap to 1 after filtering
        },
      },
    });

    expect(createRes.ok()).toBe(true);
    const createBody = await createRes.json();
    const shareToken = createBody.result?.data?.json?.shareToken;
    expect(shareToken).toBeTruthy();

    // Retrieve and verify remapping
    const getRes = await ctx.get(
      `/api/trpc/guest.getSplit?batch=1&input=${encodeURIComponent(
        JSON.stringify({ "0": { json: { token: shareToken } } })
      )}`
    );
    const getBody = await getRes.json();
    const split = getBody[0]?.result?.data?.json;

    // Only 2 people after filtering blank
    expect(split.people).toHaveLength(2);
    expect(split.people[0].name).toBe("Alice");
    expect(split.people[1].name).toBe("Bob");

    // paidByIndex remapped from 2 → 1
    expect(split.paidByIndex).toBe(1);

    // Summary should only have Alice and Bob
    expect(split.summary).toHaveLength(2);
    const names = split.summary.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(["Alice", "Bob"]);

    await ctx.dispose();
  });

  test("assignments targeting blank-name people are dropped", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // people[0]="Alice", people[1]="" (blank)
    // Assignment to person 1 (blank) should be dropped
    const createRes = await ctx.post("/api/trpc/guest.createSplit", {
      data: {
        json: {
          receiptData: {
            merchantName: "Drop Test",
            subtotal: 1000,
            tax: 0,
            tip: 0,
            total: 1000,
            currency: "USD",
          },
          items: [
            { name: "Shared Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
          ],
          people: [{ name: "Alice" }, { name: "  " }], // second person is whitespace-only
          assignments: [
            { itemIndex: 0, personIndices: [0, 1] }, // assigned to Alice + blank
          ],
          paidByIndex: 0,
        },
      },
    });

    expect(createRes.ok()).toBe(true);
    const createBody = await createRes.json();
    const shareToken = createBody.result?.data?.json?.shareToken;

    const getRes = await ctx.get(
      `/api/trpc/guest.getSplit?batch=1&input=${encodeURIComponent(
        JSON.stringify({ "0": { json: { token: shareToken } } })
      )}`
    );
    const getBody = await getRes.json();
    const split = getBody[0]?.result?.data?.json;

    // Only Alice after filtering
    expect(split.people).toHaveLength(1);
    expect(split.people[0].name).toBe("Alice");

    // Summary should only have Alice with the full amount
    expect(split.summary).toHaveLength(1);
    expect(split.summary[0].name).toBe("Alice");
    expect(split.summary[0].total).toBe(1000);

    await ctx.dispose();
  });

  test("paidByIndex targeting blank person falls back to first valid person", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await ctx.post("/api/trpc/guest.createSplit", {
      data: {
        json: {
          receiptData: {
            merchantName: "Fallback Payer Test",
            subtotal: 500,
            tax: 0,
            tip: 0,
            total: 500,
            currency: "USD",
          },
          items: [
            { name: "Coffee", quantity: 1, unitPrice: 500, totalPrice: 500 },
          ],
          // paidByIndex=0 targets blank person — should fall back to 0 (Alice after filtering)
          people: [{ name: "" }, { name: "Alice" }],
          assignments: [
            { itemIndex: 0, personIndices: [1] }, // Alice
          ],
          paidByIndex: 0, // targets blank → falls back to 0
        },
      },
    });

    expect(createRes.ok()).toBe(true);
    const createBody = await createRes.json();
    const shareToken = createBody.result?.data?.json?.shareToken;

    const getRes = await ctx.get(
      `/api/trpc/guest.getSplit?batch=1&input=${encodeURIComponent(
        JSON.stringify({ "0": { json: { token: shareToken } } })
      )}`
    );
    const getBody = await getRes.json();
    const split = getBody[0]?.result?.data?.json;

    expect(split.people).toHaveLength(1);
    expect(split.people[0].name).toBe("Alice");
    // Payer falls back to index 0 (Alice is the only person)
    expect(split.paidByIndex).toBe(0);

    await ctx.dispose();
  });
});
