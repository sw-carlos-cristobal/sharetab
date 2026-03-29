import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { readFileSync } from "fs";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError, createTestGroup } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Receipt Scanning Pipeline (5.2-5.3)", () => {
  // These tests require AI_PROVIDER to be configured on the server.
  // Set RUN_AI_TESTS=1 to enable them.
  const hasAI = !!process.env.RUN_AI_TESTS;

  // AI processing can take 30+ seconds
  test.setTimeout(120000);

  test("5.2.1 — process receipt extracts items", async () => {
    test.skip(!hasAI, "AI_PROVIDER not configured");

    const ctx = await authedContext(users.alice.email, users.alice.password);
    const receiptPath = resolve("e2e/test-receipt.png");
    const receiptBuffer = readFileSync(receiptPath);

    // Upload
    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "test-receipt.png", mimeType: "image/png", buffer: receiptBuffer },
      },
    });
    expect(uploadRes.status()).toBe(200);
    const { receiptId } = await uploadRes.json();

    // Process
    const processRes = await trpcMutation(ctx, "receipts.processReceipt", { receiptId });
    const result = (await processRes.json()).result?.data?.json;
    expect(result.status).toBe("COMPLETED");
    expect(result.itemCount).toBeGreaterThanOrEqual(15); // Our receipt has 18 items
    expect(result.subtotal).toBeGreaterThan(0);
    expect(result.tax).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);

    await ctx.dispose();
  });

  test("5.2.4 — get receipt items after processing", async () => {
    test.skip(!hasAI, "AI_PROVIDER not configured");

    const ctx = await authedContext(users.alice.email, users.alice.password);
    const receiptBuffer = readFileSync(resolve("e2e/test-receipt.png"));

    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "receipt.png", mimeType: "image/png", buffer: receiptBuffer },
      },
    });
    const { receiptId } = await uploadRes.json();
    await trpcMutation(ctx, "receipts.processReceipt", { receiptId });

    // Get items
    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    expect(data.receipt.status).toBe("COMPLETED");
    expect(data.items.length).toBeGreaterThanOrEqual(15);

    // Items should have name, quantity, prices
    for (const item of data.items) {
      expect(item.name).toBeDefined();
      expect(item.totalPrice).toBeGreaterThan(0);
    }

    await ctx.dispose();
  });

  test("5.2.3 — retry processing resets receipt", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Upload a tiny fake image that will fail processing
    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "fake.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(50, 0xFF) },
      },
    });
    const { receiptId } = await uploadRes.json();

    // Retry should reset status
    const retryRes = await trpcMutation(ctx, "receipts.retryProcessing", { receiptId });
    const body = await retryRes.json();
    expect(body.result?.data?.json?.success).toBe(true);

    // Check status is PENDING
    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    expect(data.receipt.status).toBe("PENDING");

    await ctx.dispose();
  });

  test("5.3.9 — assign items on PENDING receipt fails", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "Receipt Pending Test"
    );

    // Upload without processing
    const uploadRes = await owner.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "pending.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(50, 0xFF) },
      },
    });
    const { receiptId } = await uploadRes.json();

    const res = await trpcMutation(owner, "receipts.assignItemsAndCreateExpense", {
      groupId,
      receiptId,
      title: "Should Fail",
      paidById: memberIds[users.alice.email],
      assignments: [],
    });
    const err = await trpcError(res);
    expect(err?.data?.code).toBe("BAD_REQUEST");
    await dispose();
  });

  test("5.3.7 — full receipt to expense flow", async () => {
    test.skip(!hasAI, "AI_PROVIDER not configured");

    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Receipt to Expense"
    );
    const a = memberIds[users.alice.email];
    const b = memberIds[users.bob.email];

    // Upload
    const receiptBuffer = readFileSync(resolve("e2e/test-receipt.png"));
    const uploadRes = await owner.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "dinner.png", mimeType: "image/png", buffer: receiptBuffer },
      },
    });
    const { receiptId } = await uploadRes.json();

    // Process
    await trpcMutation(owner, "receipts.processReceipt", { receiptId });

    // Get items
    const itemsRes = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId });
    const { items } = await trpcResult(itemsRes);

    // Assign all items to both users
    const assignments = items.map((item: { id: string }) => ({
      receiptItemId: item.id,
      userIds: [a, b],
    }));

    // Create expense
    const expRes = await trpcMutation(owner, "receipts.assignItemsAndCreateExpense", {
      groupId,
      receiptId,
      title: "Golden Fork Dinner",
      paidById: a,
      assignments,
    });
    const expense = (await expRes.json()).result?.data?.json;
    expect(expense.splitMode).toBe("ITEM");
    expect(expense.amount).toBeGreaterThan(0);

    // Verify the expense shows up in the group
    const listRes = await trpcQuery(owner, "expenses.list", { groupId, limit: 1 });
    const expList = await trpcResult(listRes);
    expect(expList.expenses[0].title).toBe("Golden Fork Dinner");

    await dispose();
  });
});
