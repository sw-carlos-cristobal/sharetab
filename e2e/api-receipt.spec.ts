import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { readFileSync } from "fs";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError, createTestGroup , FAKE_JPEG } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const AI_TIMEOUT = 90000; // 90s for AI processing calls

test.describe("Receipt Scanning Pipeline (5.2-5.3)", () => {
  // Set RUN_AI_TESTS=1 to enable AI-dependent tests
  const hasAI = !!process.env.RUN_AI_TESTS;

  test.setTimeout(120000);

  test("5.2.1 — process receipt extracts items", async () => {
    test.skip(!hasAI, "Set RUN_AI_TESTS=1 to enable");

    const ctx = await authedContext(users.alice.email, users.alice.password);
    const receiptBuffer = readFileSync(resolve("e2e/test-receipt.png"));

    // Upload
    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "test-receipt.png", mimeType: "image/png", buffer: receiptBuffer },
      },
    });
    expect(uploadRes.status()).toBe(200);
    const { receiptId } = await uploadRes.json();

    // Process (AI call — needs long timeout)
    const processRes = await trpcMutation(ctx, "receipts.processReceipt", { receiptId }, AI_TIMEOUT);
    const result = (await processRes.json()).result?.data?.json;
    expect(result.status).toBe("COMPLETED");
    expect(result.itemCount).toBeGreaterThanOrEqual(15);
    expect(result.subtotal).toBeGreaterThan(0);
    expect(result.tax).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);

    await ctx.dispose();
  });

  test("5.2.4 — get receipt items after processing", async () => {
    test.skip(!hasAI, "Set RUN_AI_TESTS=1 to enable");

    const ctx = await authedContext(users.alice.email, users.alice.password);
    const receiptBuffer = readFileSync(resolve("e2e/test-receipt.png"));

    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "receipt.png", mimeType: "image/png", buffer: receiptBuffer },
      },
    });
    const { receiptId } = await uploadRes.json();
    await trpcMutation(ctx, "receipts.processReceipt", { receiptId }, AI_TIMEOUT);

    // Get items
    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    expect(data.receipt.status).toBe("COMPLETED");
    expect(data.items.length).toBeGreaterThanOrEqual(15);

    for (const item of data.items) {
      expect(item.name).toBeDefined();
      expect(item.totalPrice).toBeGreaterThan(0);
    }

    await ctx.dispose();
  });

  test("5.2.3 — retry processing reprocesses receipt", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "fake.jpg", mimeType: "image/jpeg", buffer: FAKE_JPEG },
      },
    });
    const { receiptId } = await uploadRes.json();

    // retryProcessing now actually reprocesses — may succeed (mock) or fail (OCR on fake)
    const retryRes = await trpcMutation(ctx, "receipts.retryProcessing", { receiptId }, 60000);
    const body = await retryRes.json();

    const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
    const data = await trpcResult(itemsRes);
    // With mock provider: COMPLETED; with real provider on fake image: FAILED
    expect(["COMPLETED", "FAILED"]).toContain(data.receipt.status);

    await ctx.dispose();
  });

  test("5.3.9 — assign items on PENDING receipt fails", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "Receipt Pending Test"
    );

    const uploadRes = await owner.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "pending.jpg", mimeType: "image/jpeg", buffer: FAKE_JPEG },
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
    test.skip(!hasAI, "Set RUN_AI_TESTS=1 to enable");

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

    // Process (AI call)
    await trpcMutation(owner, "receipts.processReceipt", { receiptId }, AI_TIMEOUT);

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
