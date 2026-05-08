import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { readFileSync } from "fs";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, createTestGroup } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const RECEIPT_IMAGE = readFileSync(resolve("e2e/receipts/coffee-shop.png"));

async function uploadAndProcess(
  ctx: Awaited<ReturnType<typeof authedContext>>,
  receiptId?: string
): Promise<{ receiptId: string; items: { id: string }[] } | null> {
  if (!receiptId) {
    const uploadRes = await ctx.post(`${BASE}/api/upload`, {
      multipart: {
        file: { name: "sfl-test.png", mimeType: "image/png", buffer: RECEIPT_IMAGE },
      },
    });
    if (!uploadRes.ok()) return null;
    receiptId = (await uploadRes.json()).receiptId;
  }

  const procRes = await trpcMutation(
    ctx, "receipts.processReceipt", { receiptId: receiptId! }, 120000
  );
  if (!procRes.ok()) return null;

  const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId: receiptId! });
  const data = await trpcResult(itemsRes);
  if (!data || data.receipt.status !== "COMPLETED") return null;
  return { receiptId: receiptId!, items: data.items };
}

test.describe("Save for later persistence", () => {
  test.setTimeout(120000);

  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS)
      testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });

  test("saves and restores paidById", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "SaveForLater paidById"
    );
    try {
      const result = await uploadAndProcess(owner);
      test.skip(!result, "Receipt processing failed");

      const aliceId = memberIds[users.alice.email];
      const saveRes = await trpcMutation(owner, "receipts.saveForLater", {
        groupId,
        receiptId: result!.receiptId,
        paidById: aliceId,
      });
      expect((await saveRes.json()).result?.data?.json?.success).toBe(true);

      const itemsRes = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: result!.receiptId });
      const data = await trpcResult(itemsRes);
      expect(data.receipt.paidById).toBe(aliceId);
    } finally {
      await dispose();
    }
  });

  test("saves and restores item assignments", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "SaveForLater assignments"
    );
    try {
      const result = await uploadAndProcess(owner);
      test.skip(!result, "Receipt processing failed");
      test.skip(result!.items.length < 2, "Need at least 2 items");

      const aliceId = memberIds[users.alice.email];
      const bobId = memberIds[users.bob.email];
      const item1Id = result!.items[0].id;
      const item2Id = result!.items[1].id;

      const saveRes = await trpcMutation(owner, "receipts.saveForLater", {
        groupId,
        receiptId: result!.receiptId,
        paidById: aliceId,
        assignments: [
          { receiptItemId: item1Id, userIds: [aliceId] },
          { receiptItemId: item2Id, userIds: [bobId] },
        ],
      });
      expect((await saveRes.json()).result?.data?.json?.success).toBe(true);

      const itemsRes = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: result!.receiptId });
      const data = await trpcResult(itemsRes);

      const savedItem1 = data.items.find((i: { id: string }) => i.id === item1Id);
      const savedItem2 = data.items.find((i: { id: string }) => i.id === item2Id);

      expect(savedItem1.assignments).toEqual(
        expect.arrayContaining([expect.objectContaining({ userId: aliceId })])
      );
      expect(savedItem2.assignments).toEqual(
        expect.arrayContaining([expect.objectContaining({ userId: bobId })])
      );
    } finally {
      await dispose();
    }
  });

  test("clearing paidById with null works", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "SaveForLater clear paidBy"
    );
    try {
      const result = await uploadAndProcess(owner);
      test.skip(!result, "Receipt processing failed");

      const aliceId = memberIds[users.alice.email];

      await trpcMutation(owner, "receipts.saveForLater", {
        groupId,
        receiptId: result!.receiptId,
        paidById: aliceId,
      });

      const res1 = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: result!.receiptId });
      expect((await trpcResult(res1)).receipt.paidById).toBe(aliceId);

      await trpcMutation(owner, "receipts.saveForLater", {
        groupId,
        receiptId: result!.receiptId,
        paidById: null,
      });

      const res2 = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: result!.receiptId });
      expect((await trpcResult(res2)).receipt.paidById).toBeNull();
    } finally {
      await dispose();
    }
  });

  test("empty assignments array clears existing assignments", async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [],
      "SaveForLater clear assign"
    );
    try {
      const result = await uploadAndProcess(owner);
      test.skip(!result, "Receipt processing failed");
      test.skip(result!.items.length < 1, "Need at least 1 item");

      const aliceId = memberIds[users.alice.email];
      const item1Id = result!.items[0].id;

      await trpcMutation(owner, "receipts.saveForLater", {
        groupId,
        receiptId: result!.receiptId,
        assignments: [{ receiptItemId: item1Id, userIds: [aliceId] }],
      });

      const res1 = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: result!.receiptId });
      const savedItem = (await trpcResult(res1)).items.find((i: { id: string }) => i.id === item1Id);
      expect(savedItem.assignments.length).toBeGreaterThan(0);

      await trpcMutation(owner, "receipts.saveForLater", {
        groupId,
        receiptId: result!.receiptId,
        assignments: [],
      });

      const res2 = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId: result!.receiptId });
      const clearedItem = (await trpcResult(res2)).items.find((i: { id: string }) => i.id === item1Id);
      expect(clearedItem.assignments.length).toBe(0);
    } finally {
      await dispose();
    }
  });
});
