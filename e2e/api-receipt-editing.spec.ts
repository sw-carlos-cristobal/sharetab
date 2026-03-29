import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { readFileSync } from "fs";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Receipt Item Editing", () => {
  const hasAI = !!process.env.RUN_AI_TESTS;
  test.setTimeout(120000);

  let ctx: Awaited<ReturnType<typeof authedContext>>;
  let receiptId: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(120000);
    if (!hasAI) return;

    ctx = await authedContext(users.alice.email, users.alice.password);

    // Upload and process a receipt
    const receiptBuffer = readFileSync(resolve("e2e/test-receipt.png"));
    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "edit-test.png", mimeType: "image/png", buffer: receiptBuffer },
      },
    });
    receiptId = (await uploadRes.json()).receiptId;
    await trpcMutation(ctx, "receipts.processReceipt", { receiptId }, 90000);
  });

  test.afterAll(async () => {
    await ctx?.dispose();
  });

  test("update item name and price", async () => {
    test.skip(!hasAI, "Set RUN_AI_TESTS=1 to enable");

    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const { items } = await trpcResult(itemsRes);
    const firstItem = items[0];

    const updateRes = await trpcMutation(ctx, "receipts.updateItem", {
      itemId: firstItem.id,
      name: "Corrected Item Name",
      totalPrice: 1599,
      unitPrice: 1599,
    });
    const updated = (await updateRes.json()).result?.data?.json;
    expect(updated.name).toBe("Corrected Item Name");
    expect(updated.totalPrice).toBe(1599);
  });

  test("update item quantity", async () => {
    test.skip(!hasAI, "Set RUN_AI_TESTS=1 to enable");

    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const { items } = await trpcResult(itemsRes);
    const item = items[1];

    const updateRes = await trpcMutation(ctx, "receipts.updateItem", {
      itemId: item.id,
      quantity: 3,
    });
    const updated = (await updateRes.json()).result?.data?.json;
    expect(updated.quantity).toBe(3);
  });

  test("add new item to receipt", async () => {
    test.skip(!hasAI, "Set RUN_AI_TESTS=1 to enable");

    const beforeRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const beforeCount = (await trpcResult(beforeRes)).items.length;

    const addRes = await trpcMutation(ctx, "receipts.addItem", {
      receiptId,
      name: "Extra Bread",
      quantity: 1,
      unitPrice: 350,
      totalPrice: 350,
    });
    const added = (await addRes.json()).result?.data?.json;
    expect(added.name).toBe("Extra Bread");
    expect(added.totalPrice).toBe(350);

    // Verify count increased
    const afterRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const afterCount = (await trpcResult(afterRes)).items.length;
    expect(afterCount).toBe(beforeCount + 1);
  });

  test("delete item from receipt", async () => {
    test.skip(!hasAI, "Set RUN_AI_TESTS=1 to enable");

    const beforeRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const items = (await trpcResult(beforeRes)).items;
    const beforeCount = items.length;
    const lastItem = items[items.length - 1];

    const deleteRes = await trpcMutation(ctx, "receipts.deleteItem", {
      itemId: lastItem.id,
    });
    expect((await deleteRes.json()).result?.data?.json?.success).toBe(true);

    const afterRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const afterCount = (await trpcResult(afterRes)).items.length;
    expect(afterCount).toBe(beforeCount - 1);
  });

  test("receipt image path is returned", async () => {
    test.skip(!hasAI, "Set RUN_AI_TESTS=1 to enable");

    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    expect(data.receipt.imagePath).toBeDefined();
    expect(data.receipt.imagePath).toContain("receipts/");
  });

  test("update extracted tax value", async () => {
    test.skip(!hasAI, "Set RUN_AI_TESTS=1 to enable");

    const updateRes = await trpcMutation(ctx, "receipts.updateExtractedData", {
      receiptId,
      tax: 3000, // $30.00
    });
    expect((await updateRes.json()).result?.data?.json?.success).toBe(true);

    // Verify the tax was updated
    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    expect(data.receipt.extractedData.tax).toBe(3000);
  });
});

test.describe("Receipt Item Editing (no AI)", () => {
  test("add item to receipt", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Upload a receipt
    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "items.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(50, 0xFF) },
      },
    });
    const { receiptId } = await uploadRes.json();

    // Add items manually
    const add1 = await trpcMutation(ctx, "receipts.addItem", {
      receiptId,
      name: "Pizza",
      quantity: 1,
      unitPrice: 1200,
      totalPrice: 1200,
    });
    expect((await add1.json()).result?.data?.json?.name).toBe("Pizza");

    const add2 = await trpcMutation(ctx, "receipts.addItem", {
      receiptId,
      name: "Soda",
      quantity: 2,
      unitPrice: 300,
      totalPrice: 600,
    });
    expect((await add2.json()).result?.data?.json?.quantity).toBe(2);

    // Verify items exist
    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    expect(data.items.length).toBe(2);

    // Update first item
    const updateRes = await trpcMutation(ctx, "receipts.updateItem", {
      itemId: data.items[0].id,
      name: "Large Pizza",
      totalPrice: 1500,
    });
    expect((await updateRes.json()).result?.data?.json?.name).toBe("Large Pizza");

    // Delete second item
    const deleteRes = await trpcMutation(ctx, "receipts.deleteItem", {
      itemId: data.items[1].id,
    });
    expect((await deleteRes.json()).result?.data?.json?.success).toBe(true);

    // Verify only 1 item remains
    const finalRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    expect((await trpcResult(finalRes)).items.length).toBe(1);

    await ctx.dispose();
  });

  test("update extracted data (tax/tip)", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "tax.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(50, 0xFF) },
      },
    });
    const { receiptId } = await uploadRes.json();

    const updateRes = await trpcMutation(ctx, "receipts.updateExtractedData", {
      receiptId,
      tax: 500,
      tip: 1000,
    });
    expect((await updateRes.json()).result?.data?.json?.success).toBe(true);

    await ctx.dispose();
  });
});
