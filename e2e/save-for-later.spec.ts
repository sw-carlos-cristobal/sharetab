import { test, expect } from "@playwright/test";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, createTestGroup, FAKE_JPEG } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

/**
 * Upload a receipt image, process it, and return the receiptId only if it reaches
 * COMPLETED status. Returns null when processing fails (e.g., no AI provider).
 */
async function uploadAndProcess(
  ctx: Awaited<ReturnType<typeof authedContext>>,
  filename: string
): Promise<string | null> {
  const uploadRes = await ctx.post(`${BASE}/api/upload`, {
    multipart: {
      file: { name: filename, mimeType: "image/jpeg", buffer: FAKE_JPEG },
    },
  });
  const { receiptId } = await uploadRes.json();

  // retryProcessing triggers the AI pipeline (mock provider returns COMPLETED)
  await trpcMutation(ctx, "receipts.retryProcessing", { receiptId }, 60000);

  const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
  const data = await trpcResult(itemsRes);
  if (data.receipt.status !== "COMPLETED") return null;
  return receiptId;
}

test.describe("Save for later persistence", () => {
  test.setTimeout(120000);

  test("saves and restores paidById", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "SaveForLater paidById"
    );

    const receiptId = await uploadAndProcess(owner, "sfl-paidby.jpg");
    test.skip(!receiptId, "Receipt did not reach COMPLETED status (no AI provider)");

    const aliceId = memberIds[users.alice.email];

    // Save with paidById set to alice's userId
    const saveRes = await trpcMutation(owner, "receipts.saveForLater", {
      groupId,
      receiptId: receiptId!,
      paidById: aliceId,
    });
    expect((await saveRes.json()).result?.data?.json?.success).toBe(true);

    // Retrieve and verify paidById
    const itemsRes = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: receiptId! });
    const data = await trpcResult(itemsRes);
    expect(data.receipt.paidById).toBe(aliceId);

    await dispose();
  });

  test("saves and restores item assignments", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "SaveForLater assignments"
    );

    const receiptId = await uploadAndProcess(owner, "sfl-assign.jpg");
    test.skip(!receiptId, "Receipt did not reach COMPLETED status (no AI provider)");

    const aliceId = memberIds[users.alice.email];
    const bobId = memberIds[users.bob.email];

    // Get items so we can reference their IDs
    const itemsRes1 = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: receiptId! });
    const { items } = await trpcResult(itemsRes1);
    expect(items.length).toBeGreaterThanOrEqual(2);
    const item1Id = items[0].id;
    const item2Id = items[1].id;

    // Save with assignments: item1 -> alice, item2 -> bob
    const saveRes = await trpcMutation(owner, "receipts.saveForLater", {
      groupId,
      receiptId: receiptId!,
      paidById: aliceId,
      assignments: [
        { receiptItemId: item1Id, userIds: [aliceId] },
        { receiptItemId: item2Id, userIds: [bobId] },
      ],
    });
    expect((await saveRes.json()).result?.data?.json?.success).toBe(true);

    // Retrieve and verify assignments
    const itemsRes2 = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: receiptId! });
    const data = await trpcResult(itemsRes2);

    const savedItem1 = data.items.find((i: { id: string }) => i.id === item1Id);
    const savedItem2 = data.items.find((i: { id: string }) => i.id === item2Id);

    expect(savedItem1.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: aliceId })])
    );
    expect(savedItem2.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: bobId })])
    );

    await dispose();
  });

  test("clearing paidById with null works", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "SaveForLater clear paidBy"
    );

    const receiptId = await uploadAndProcess(owner, "sfl-clearpaid.jpg");
    test.skip(!receiptId, "Receipt did not reach COMPLETED status (no AI provider)");

    const aliceId = memberIds[users.alice.email];

    // Save with paidById = alice
    await trpcMutation(owner, "receipts.saveForLater", {
      groupId,
      receiptId: receiptId!,
      paidById: aliceId,
    });

    // Verify paidById is set
    const res1 = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: receiptId! });
    const data1 = await trpcResult(res1);
    expect(data1.receipt.paidById).toBe(aliceId);

    // Save again with paidById = null
    await trpcMutation(owner, "receipts.saveForLater", {
      groupId,
      receiptId: receiptId!,
      paidById: null,
    });

    // Verify paidById is null
    const res2 = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: receiptId! });
    const data2 = await trpcResult(res2);
    expect(data2.receipt.paidById).toBeNull();

    await dispose();
  });

  test("empty assignments array clears existing assignments", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "SaveForLater clear assign"
    );

    const receiptId = await uploadAndProcess(owner, "sfl-clearassign.jpg");
    test.skip(!receiptId, "Receipt did not reach COMPLETED status (no AI provider)");

    const aliceId = memberIds[users.alice.email];

    // Get items
    const itemsRes = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: receiptId! });
    const { items } = await trpcResult(itemsRes);
    const item1Id = items[0].id;

    // Save with assignments
    await trpcMutation(owner, "receipts.saveForLater", {
      groupId,
      receiptId: receiptId!,
      assignments: [{ receiptItemId: item1Id, userIds: [aliceId] }],
    });

    // Verify assignments exist
    const res1 = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: receiptId! });
    const data1 = await trpcResult(res1);
    const savedItem = data1.items.find((i: { id: string }) => i.id === item1Id);
    expect(savedItem.assignments.length).toBeGreaterThan(0);

    // Save again with empty assignments array
    await trpcMutation(owner, "receipts.saveForLater", {
      groupId,
      receiptId: receiptId!,
      assignments: [],
    });

    // Verify assignments are cleared
    const res2 = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: receiptId! });
    const data2 = await trpcResult(res2);
    const clearedItem = data2.items.find((i: { id: string }) => i.id === item1Id);
    expect(clearedItem.assignments.length).toBe(0);

    await dispose();
  });
});
