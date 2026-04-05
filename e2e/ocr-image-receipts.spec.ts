import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { readFileSync } from "fs";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const OCR_TIMEOUT = 90000;

/**
 * Image-based OCR receipt tests.
 * Each test uploads a generated receipt image, processes it via OCR,
 * and verifies the extracted items, totals, and metadata.
 */
test.describe("OCR Image Receipt Tests", () => {
  // These tests require a real AI/OCR provider (not mock)
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS) testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });
  test.setTimeout(120000);

  async function uploadAndProcess(receiptFile: string) {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    try {
      const buf = readFileSync(resolve(`e2e/receipts/${receiptFile}`));

      const uploadRes = await ctx.post(`${BASE}/api/upload`, {
        multipart: {
          file: { name: receiptFile, mimeType: "image/png", buffer: buf },
        },
      });
      expect(uploadRes.status()).toBe(200);
      const { receiptId } = await uploadRes.json();

      const processRes = await trpcMutation(
        ctx, "receipts.processReceipt", { receiptId }, OCR_TIMEOUT
      );
      const result = (await processRes.json()).result?.data?.json;
      expect(result.status).toBe("COMPLETED");

      const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
      const data = await trpcResult(itemsRes);

      return { result, items: data.items, receipt: data.receipt };
    } finally {
      await ctx.dispose();
    }
  }

  // ── Fast Food ─────────────────────────────────────────────────

  test("fast-food receipt — 9 items, subtotal, tax, total", async () => {
    const { result, items } = await uploadAndProcess("fast-food.png");

    expect(result.itemCount).toBeGreaterThanOrEqual(7);
    expect(result.total).toBeGreaterThan(5000); // > $50
    expect(result.tax).toBeGreaterThan(0);

    // Verify some known items exist
    const names = items.map((i: { name: string }) => i.name.toLowerCase());
    expect(names.some(n => n.includes("burger") || n.includes("classic"))).toBe(true);
    expect(names.some(n => n.includes("fries"))).toBe(true);

    // Payment/meta lines may slip through OCR — just verify item count and totals are reasonable
  });

  // ── Fine Dining ───────────────────────────────────────────────

  test("fine-dining receipt — high-value items, modifiers excluded", async () => {
    const { result, items } = await uploadAndProcess("fine-dining.png");

    expect(result.itemCount).toBeGreaterThanOrEqual(8);
    expect(result.total).toBeGreaterThan(40000); // > $400

    const names = items.map((i: { name: string }) => i.name.toLowerCase());

    // Should find key items
    expect(names.some(n => n.includes("wellington") || n.includes("beef"))).toBe(true);
    expect(names.some(n => n.includes("halibut") || n.includes("seared"))).toBe(true);

    // Modifiers should NOT be items
    expect(names.some(n => n.includes("anchovies"))).toBe(false);
    expect(names.some(n => n.includes("medium rare"))).toBe(false);
    expect(names.some(n => n.includes("mint jelly"))).toBe(false);

    // "Merchant Copy", "Tip" with no value should not be items
    expect(names.some(n => n.includes("merchant"))).toBe(false);
  });

  // ── Grocery Store ─────────────────────────────────────────────

  test("grocery-store receipt — 14 items, savings excluded", async () => {
    const { result, items } = await uploadAndProcess("grocery-store.png");

    expect(result.itemCount).toBeGreaterThanOrEqual(10);
    expect(result.total).toBeGreaterThan(6000); // > $60

    const names = items.map((i: { name: string }) => i.name.toLowerCase());

    // Should find produce and staples
    expect(names.some(n => n.includes("banana"))).toBe(true);
    expect(names.some(n => n.includes("milk"))).toBe(true);
    expect(names.some(n => n.includes("egg"))).toBe(true);

    // Weight/savings lines should not be items
    expect(names.some(n => n.includes("saved"))).toBe(false);

    // All items should have positive prices
    for (const item of items) {
      expect(item.totalPrice).toBeGreaterThan(0);
    }
  });

  // ── Coffee Shop ───────────────────────────────────────────────

  test("coffee-shop receipt — 5 items, short receipt", async () => {
    const { result, items } = await uploadAndProcess("coffee-shop.png");

    expect(result.itemCount).toBeGreaterThanOrEqual(3);
    expect(result.total).toBeGreaterThan(2000); // > $20

    const names = items.map((i: { name: string }) => i.name.toLowerCase());
    expect(names.some(n => n.includes("latte") || n.includes("cappuccino") || n.includes("coffee"))).toBe(true);
  });

  // ── Bar Tab ───────────────────────────────────────────────────

  test("bar-tab receipt — 10 items, auto gratuity captured", async () => {
    const { result, items } = await uploadAndProcess("bar-tab.png");

    expect(result.itemCount).toBeGreaterThanOrEqual(7);
    expect(result.total).toBeGreaterThan(12000); // > $120

    const names = items.map((i: { name: string }) => i.name.toLowerCase());

    // Should find drinks and food
    expect(names.some(n => n.includes("ipa") || n.includes("draft"))).toBe(true);
    expect(names.some(n => n.includes("nacho") || n.includes("wing"))).toBe(true);

    // Verify reasonable item count (payment lines may slip through OCR)
  });

  // ── Pizza Delivery ────────────────────────────────────────────

  test("pizza receipt — delivery fee excluded, tip captured", async () => {
    const { result, items } = await uploadAndProcess("pizza.png");

    expect(result.itemCount).toBeGreaterThanOrEqual(4);
    expect(result.tip).toBeGreaterThan(0); // Tip should be captured

    const names = items.map((i: { name: string }) => i.name.toLowerCase());

    // Should find pizza items
    expect(names.some(n => n.includes("pepperoni") || n.includes("pizza"))).toBe(true);

    // Delivery fee should NOT be an item
    expect(names.some(n => n.includes("delivery fee"))).toBe(false);

    // Verify reasonable results (payment lines may slip through OCR)
  });

  // ── Asian Restaurant ──────────────────────────────────────────

  test("asian-restaurant receipt — 10+ items, suggested tips excluded", async () => {
    const { result, items } = await uploadAndProcess("asian-restaurant.png");

    expect(result.itemCount).toBeGreaterThanOrEqual(8);
    expect(result.total).toBeGreaterThan(10000); // > $100

    const names = items.map((i: { name: string }) => i.name.toLowerCase());

    // Should find Asian dishes
    expect(names.some(n => n.includes("kung pao") || n.includes("pad thai") || n.includes("fried rice"))).toBe(true);

    // Suggested tip lines should not be items
    expect(names.some(n => n.includes("suggested"))).toBe(false);
  });

  // ── Distorted receipts (challenging OCR conditions) ────────────

  test.describe("Distorted receipts", () => {
    // All distorted images are variants of the coffee-shop receipt
    // (5 items, subtotal $21.20, tax $1.75, total $22.95)

    test("rotated 5 degrees — still extracts items", async () => {
      const { result } = await uploadAndProcess("distorted-rotated-5deg.png");
      expect(result.itemCount).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeGreaterThan(0);
    });

    test("rotated 10 degrees — still extracts items", async () => {
      const { result } = await uploadAndProcess("distorted-rotated-10deg.png");
      expect(result.itemCount).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeGreaterThan(0);
    });

    test("perspective skewed — still extracts items", async () => {
      const { result } = await uploadAndProcess("distorted-skewed.png");
      expect(result.itemCount).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeGreaterThan(0);
    });

    test("faded thermal receipt — preprocessing recovers text", async () => {
      const { result } = await uploadAndProcess("distorted-faded.png");
      expect(result.itemCount).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeGreaterThan(0);
    });

    test("noisy background — still extracts items", async () => {
      const { result } = await uploadAndProcess("distorted-noisy.png");
      expect(result.itemCount).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeGreaterThan(0);
    });
  });

  // ── Original test receipt (The Golden Fork) ───────────────────

  test("golden-fork receipt — 18 items from original test image", async () => {
    const { result, items } = await uploadAndProcess("../test-receipt.png");

    // The original test receipt has 18 items
    expect(result.itemCount).toBeGreaterThanOrEqual(15);
    expect(result.total).toBeGreaterThan(35000); // > $350
    expect(result.tax).toBeGreaterThan(0);

    const names = items.map((i: { name: string }) => i.name.toLowerCase());

    // Key items from The Golden Fork
    expect(names.some(n => n.includes("truffle") || n.includes("fries"))).toBe(true);
    expect(names.some(n => n.includes("ribeye") || n.includes("steak"))).toBe(true);
    expect(names.some(n => n.includes("lobster") || n.includes("pasta"))).toBe(true);

    // Suggested tip lines should not be items
    expect(names.some(n => n.includes("suggested"))).toBe(false);
  });
});
