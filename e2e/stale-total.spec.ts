import { test, expect, request } from "@playwright/test";
import { trpcMutation, trpcQuery, trpcResult } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("createSplit total with tipOverride", () => {
  test("stored total reflects tipOverride, not original tip", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Receipt: subtotal 2000, tax 200, tip 100, total 2300
    // Override tip to 500 → expected total = 2000 + 200 + 500 = 2700
    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Tip Override Test",
        subtotal: 2000,
        tax: 200,
        tip: 100,
        total: 2300,
        currency: "USD",
      },
      items: [
        { name: "Burger", quantity: 1, unitPrice: 2000, totalPrice: 2000 },
      ],
      people: [{ name: "Alice" }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
      paidByIndex: 0,
      tipOverride: 500,
    });
    expect(createRes.ok()).toBe(true);
    const { shareToken } = (await createRes.json()).result?.data?.json;

    // Fetch the split and check stored receiptData.total
    const getRes = await trpcQuery(ctx, "guest.getSplit", { token: shareToken });
    const data = await trpcResult(getRes);

    // The stored tip should be the override value
    expect(data.receiptData.tip).toBe(500);
    // The stored total should be recalculated: subtotal + tax + overriddenTip
    expect(data.receiptData.total).toBe(2700);

    // Summary totals should also sum to the correct total
    const summaryTotal = data.summary.reduce(
      (sum: number, s: { total: number }) => sum + s.total,
      0
    );
    expect(summaryTotal).toBe(2700);

    await ctx.dispose();
  });

  test("stored total preserved when no tipOverride is provided", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "No Override Test",
        subtotal: 2000,
        tax: 200,
        tip: 100,
        total: 2300,
        currency: "USD",
      },
      items: [
        { name: "Salad", quantity: 1, unitPrice: 2000, totalPrice: 2000 },
      ],
      people: [{ name: "Alice" }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
      paidByIndex: 0,
    });
    expect(createRes.ok()).toBe(true);
    const { shareToken } = (await createRes.json()).result?.data?.json;

    const getRes = await trpcQuery(ctx, "guest.getSplit", { token: shareToken });
    const data = await trpcResult(getRes);

    expect(data.receiptData.tip).toBe(100);
    expect(data.receiptData.total).toBe(2300);

    await ctx.dispose();
  });
});
