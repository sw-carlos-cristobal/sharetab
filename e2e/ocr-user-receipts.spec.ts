import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { readFileSync } from "fs";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const OCR_TIMEOUT = 90000;

/**
 * OCR tests using AI-generated photorealistic receipt images.
 * These simulate real-world phone photos: angled shots, varied lighting,
 * background objects (coffee cups, plates, debit cards), and different
 * receipt formats (grocery, cafe, gas station, takeout, pharmacy, restaurant).
 */
test.describe("Photorealistic Receipt OCR", () => {
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS) testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });
  test.setTimeout(120000);

  async function uploadAndProcess(filename: string) {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    try {
      const buf = readFileSync(resolve(`e2e/receipts/${filename}`));
      const mimeType = filename.endsWith(".png") ? "image/png" : "image/jpeg";

      const uploadRes = await ctx.post(`${BASE}/api/upload`, {
        multipart: {
          file: { name: filename, mimeType, buffer: buf },
        },
      });
      expect(uploadRes.status()).toBe(200);
      const { receiptId } = await uploadRes.json();

      const processRes = await trpcMutation(
        ctx, "receipts.processReceipt", { receiptId }, OCR_TIMEOUT
      );
      const body = await processRes.json();
      const result = body.result?.data?.json;

      let items: { name: string; totalPrice: number }[] = [];
      if (result?.status === "COMPLETED") {
        const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
        const data = await trpcResult(itemsRes);
        items = data.items;
      }

      return { result, items };
    } finally {
      await ctx.dispose();
    }
  }

  // ── Synthetic photo receipts ──────────────────────────────────

  test.describe("Synthetic photo receipts", () => {
    test("Pine Ridge Market grocery — 10 items, rewards savings excluded", async () => {
      const { result, items } = await uploadAndProcess("synthetic-photo-grocery.jpg");
      expect(result.status).toBe("COMPLETED");
      expect(result.itemCount).toBeGreaterThanOrEqual(5);
      expect(result.total).toBeGreaterThan(4000); // > $40

      const names = items.map(i => i.name.toLowerCase());
      expect(names.some(n => n.includes("strawberr") || n.includes("potato") || n.includes("chicken"))).toBe(true);
      // "Rewards Savings" should be excluded
      expect(names.some(n => n.includes("reward"))).toBe(false);
    });

    test("Maple & Steam cafe — 5 items with tip", async () => {
      const { result, items } = await uploadAndProcess("synthetic-photo-cafe.jpg");
      expect(result.status).toBe("COMPLETED");
      expect(result.itemCount).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeGreaterThan(2000); // > $20

      const names = items.map(i => i.name.toLowerCase());
      expect(names.some(n => n.includes("latte") || n.includes("brew") || n.includes("croissant"))).toBe(true);
    });

    test("Red Pepper Wok takeout — extracts food items", async () => {
      const { result } = await uploadAndProcess("synthetic-photo-takeout.jpg");
      expect(result.status).toBe("COMPLETED");
      expect(result.itemCount).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeGreaterThan(3000); // > $30
    });

    test("Mile Marker Fuel gas station — fuel + convenience items", async () => {
      const { result } = await uploadAndProcess("synthetic-photo-gas.jpg");
      expect(result.status).toBe("COMPLETED");
      expect(result.itemCount).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeGreaterThan(4000); // > $40
    });
  });

  // ── Gemini-generated photorealistic receipts ──────────────────

  test.describe("Gemini AI-generated receipt photos", () => {
    test("Alpha Grocery Lab (flat) — multi-column grocery receipt", async () => {
      const { result, items } = await uploadAndProcess("Gemini_Generated_Image_5gpiuz5gpiuz5gpi.png");
      expect(result.status).toBe("COMPLETED");
      expect(result.itemCount).toBeGreaterThanOrEqual(5);
      expect(result.total).toBeGreaterThan(4000); // > $40

      // Should have grocery items
      const names = items.map(i => i.name.toLowerCase());
      expect(names.some(n => n.includes("milk") || n.includes("egg") || n.includes("bread"))).toBe(true);
    });

    test("Alpha Grocery Lab (angled) — tilted receipt with columns", async () => {
      const { result } = await uploadAndProcess("Gemini_Generated_Image_nwqe3fnwqe3fnwqe.png");
      expect(result.status).toBe("COMPLETED");
      expect(result.itemCount).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeGreaterThan(5000); // > $50
    });

    test("Midnight Cafe Lab — perspective shot in dim lighting", async () => {
      const { result, items } = await uploadAndProcess("Gemini_Generated_Image_ojj90yojj90yojj9.png");
      expect(result.status).toBe("COMPLETED");
      expect(result.itemCount).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeGreaterThan(3000); // > $30

      const names = items.map(i => i.name.toLowerCase());
      expect(names.some(n => n.includes("latte") || n.includes("toast") || n.includes("chai"))).toBe(true);
    });

    test("Northfield Market — multi-column grocery with discount", async () => {
      const { result } = await uploadAndProcess("Gemini_Generated_Image_t9gyket9gyket9gy.png");
      expect(result.status).toBe("COMPLETED");
      // Multi-column layout with SKU codes is challenging for OCR
      expect(result.itemCount).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeGreaterThan(0);
    });

    test("City Pharma Demo Store — long receipt with coupons excluded", async () => {
      const { result, items } = await uploadAndProcess("Gemini_Generated_Image_tn7wautn7wautn7w.png");
      expect(result.status).toBe("COMPLETED");
      expect(result.itemCount).toBeGreaterThanOrEqual(5);
      expect(result.total).toBeGreaterThan(10000); // > $100

      const names = items.map(i => i.name.toLowerCase());
      // Coupon lines should be excluded
      expect(names.some(n => n.includes("coupon"))).toBe(false);
    });

    test("Harbor Table restaurant — fine dining with tip line", async () => {
      const { result, items } = await uploadAndProcess("Gemini_Generated_Image_wa8205wa8205wa82.png");
      expect(result.status).toBe("COMPLETED");
      expect(result.itemCount).toBeGreaterThanOrEqual(4);
      expect(result.total).toBeGreaterThan(10000); // > $100

      const names = items.map(i => i.name.toLowerCase());
      expect(names.some(n => n.includes("crab") || n.includes("chicken") || n.includes("fish") || n.includes("harbor"))).toBe(true);
    });
  });
});
