import { test, expect } from "@playwright/test";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError, FAKE_PNG } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Split line item", () => {
  test("splits a multi-quantity item into two rows", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Upload a fake receipt image
    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "split-test.png", mimeType: "image/png", buffer: FAKE_PNG },
      },
    });
    expect(uploadRes.status()).toBe(200);
    const { receiptId } = await uploadRes.json();

    // Add an item: "Beer", quantity 7, unitPrice 500, totalPrice 3500
    const addRes = await trpcMutation(ctx, "receipts.addItem", {
      receiptId,
      name: "Beer",
      quantity: 7,
      unitPrice: 500,
      totalPrice: 3500,
    });
    const item = (await addRes.json()).result?.data?.json;
    expect(item.name).toBe("Beer");
    const originalSortOrder = item.sortOrder;

    // Split with splitQuantity: 3
    const splitRes = await trpcMutation(ctx, "receipts.splitItem", {
      itemId: item.id,
      splitQuantity: 3,
    });
    expect(splitRes.ok()).toBe(true);

    // Fetch all items
    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    expect(data.items).toHaveLength(2);

    // Find original and new items by quantity
    const original = data.items.find((i: { quantity: number }) => i.quantity === 4);
    const split = data.items.find((i: { quantity: number }) => i.quantity === 3);
    expect(original).toBeDefined();
    expect(split).toBeDefined();

    // Original: qty 4, totalPrice = 3500 - min(500*3, 3499) = 3500 - 1500 = 2000
    expect(original.quantity).toBe(4);
    expect(original.totalPrice).toBe(2000);

    // New: qty 3, totalPrice = min(500*3, 3499) = 1500
    expect(split.quantity).toBe(3);
    expect(split.totalPrice).toBe(1500);

    // Both items share the same name
    expect(original.name).toBe("Beer");
    expect(split.name).toBe("Beer");

    // New item's sortOrder is original's sortOrder + 1
    expect(split.sortOrder).toBe(originalSortOrder + 1);

    await ctx.dispose();
  });

  test("rejects split quantity >= item quantity", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "split-reject.png", mimeType: "image/png", buffer: FAKE_PNG },
      },
    });
    const { receiptId } = await uploadRes.json();

    const addRes = await trpcMutation(ctx, "receipts.addItem", {
      receiptId,
      name: "Soda",
      quantity: 3,
      unitPrice: 200,
      totalPrice: 600,
    });
    const item = (await addRes.json()).result?.data?.json;

    // Try to split with splitQuantity equal to item quantity (3)
    const splitRes = await trpcMutation(ctx, "receipts.splitItem", {
      itemId: item.id,
      splitQuantity: 3,
    });
    const err = await trpcError(splitRes);
    expect(err?.data?.code).toBe("BAD_REQUEST");

    await ctx.dispose();
  });

  test("rejects split quantity of 0", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "split-zero.png", mimeType: "image/png", buffer: FAKE_PNG },
      },
    });
    const { receiptId } = await uploadRes.json();

    const addRes = await trpcMutation(ctx, "receipts.addItem", {
      receiptId,
      name: "Water",
      quantity: 2,
      unitPrice: 100,
      totalPrice: 200,
    });
    const item = (await addRes.json()).result?.data?.json;

    // splitQuantity: 0 should fail zod validation (min 1)
    const splitRes = await trpcMutation(ctx, "receipts.splitItem", {
      itemId: item.id,
      splitQuantity: 0,
    });
    expect(splitRes.ok()).toBe(false);

    await ctx.dispose();
  });

  test("guards against negative remaining price", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "split-rounding.png", mimeType: "image/png", buffer: FAKE_PNG },
      },
    });
    const { receiptId } = await uploadRes.json();

    // Add item: quantity 3, unitPrice 334, totalPrice 999 (334*3=1002 > 999)
    const addRes = await trpcMutation(ctx, "receipts.addItem", {
      receiptId,
      name: "Rounding Edge",
      quantity: 3,
      unitPrice: 334,
      totalPrice: 999,
    });
    const item = (await addRes.json()).result?.data?.json;

    // Split with splitQuantity 2: newTotalPrice = min(334*2, 999-1) = min(668, 998) = 668
    // remaining = 999 - 668 = 331
    const splitRes = await trpcMutation(ctx, "receipts.splitItem", {
      itemId: item.id,
      splitQuantity: 2,
    });
    expect(splitRes.ok()).toBe(true);

    // Fetch items and verify both have positive prices that sum to original total
    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    expect(data.items).toHaveLength(2);

    const remaining = data.items.find((i: { quantity: number }) => i.quantity === 1);
    const newSplit = data.items.find((i: { quantity: number }) => i.quantity === 2);
    expect(remaining).toBeDefined();
    expect(newSplit).toBeDefined();

    // Both prices positive
    expect(remaining.totalPrice).toBeGreaterThan(0);
    expect(newSplit.totalPrice).toBeGreaterThan(0);

    // Prices sum to original total
    expect(remaining.totalPrice + newSplit.totalPrice).toBe(999);

    await ctx.dispose();
  });
});
