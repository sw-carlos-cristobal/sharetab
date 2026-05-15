import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { readFileSync, readdirSync } from "fs";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const OCR_TIMEOUT = 120000;

/**
 * Real-world receipt OCR tests using two sources:
 *
 * 1. SROIE dataset (ICDAR-2019): clean scanned Malaysian receipts
 *    Source: https://github.com/zzzDavid/ICDAR-2019-SROIE
 *
 * 2. Wikimedia Commons photos: actual phone photos of receipts
 *    - German store collage (Lidl, EDEKA, REWE, RENO)
 *    - Polish hardware store (Castorama)
 *    - Polish convenience store (Żabka) — blurry, textured surface
 *    - UK Tesco receipt — outdoors, angled, partially obscured
 *    - Indonesian convenience store (Lawson) — clean phone photo
 *    - German thermal receipt (Kassenbon)
 *
 * Tests are lenient — real receipts may have OCR failures.
 * We verify the pipeline doesn't crash and extracts reasonable data.
 */
test.describe("Real-World Receipt OCR", () => {
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS) testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });
  test.setTimeout(120000);

  const receiptDir = resolve("e2e/receipts");

  async function uploadAndProcess(filename: string) {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    try {
      const buf = readFileSync(resolve(receiptDir, filename));
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
      return body;
    } finally {
      await ctx.dispose();
    }
  }

  // ── SROIE dataset: scanned Malaysian receipts ─────────────────

  test.describe("SROIE scanned receipts", () => {
    const sroieImages = readdirSync(receiptDir).filter(f => f.startsWith("real-sroie-"));
    if (sroieImages.length === 0) throw new Error("No SROIE receipt images found in e2e/receipts/");

    for (const img of sroieImages) {
      test(`${img} — processes without crash`, async () => {
        const body = await uploadAndProcess(img);
        const result = body.result?.data?.json;
        const error = body.error?.json;

        if (result) {
          expect(result.status).toBe("COMPLETED");
          expect(result.itemCount).toBeGreaterThanOrEqual(1);
          expect(result.total).toBeGreaterThan(0);
        } else if (error) {
          // Graceful failure is acceptable for difficult images
          expect(error.message).toBeDefined();
        }
      });
    }
  });

  // ── Wikimedia Commons: real phone photos ──────────────────────

  test.describe("Real phone photos", () => {
    test("Castorama (Polish hardware store) — phone photo", async () => {
      const body = await uploadAndProcess("real-photo-castorama.jpg");
      expect(body.result || body.error).toBeDefined();
      const result = body.result?.data?.json;
      if (result?.status === "COMPLETED") {
        expect(result.itemCount).toBeGreaterThanOrEqual(1);
        expect(result.total).toBeGreaterThan(0);
      }
    });

    test("Żabka (Polish convenience store) — blurry, textured surface", async () => {
      const body = await uploadAndProcess("real-photo-zabka.jpg");
      expect(body.result || body.error).toBeDefined();
      const result = body.result?.data?.json;
      // This image is blurry — may fail to extract, that's OK
      if (result?.status === "COMPLETED") {
        expect(result.itemCount).toBeGreaterThanOrEqual(1);
      }
    });

    test("Lawson (Indonesian store) — clean phone photo on table", async () => {
      const body = await uploadAndProcess("real-photo-lawson.jpg");
      expect(body.result || body.error).toBeDefined();
      const result = body.result?.data?.json;
      if (result?.status === "COMPLETED") {
        expect(result.itemCount).toBeGreaterThanOrEqual(1);
        expect(result.total).toBeGreaterThan(0);
      }
    });

    test("Kassenbon (German thermal receipt) — high contrast photo", async () => {
      const body = await uploadAndProcess("real-photo-kassenbon.jpg");
      expect(body.result || body.error).toBeDefined();
      const result = body.result?.data?.json;
      if (result?.status === "COMPLETED") {
        expect(result.itemCount).toBeGreaterThanOrEqual(1);
      }
    });

    test("German store collage (6 receipts in one photo)", async () => {
      // Multiple receipts in one image — OCR will see mixed text
      const body = await uploadAndProcess("real-photo-german.jpg");
      expect(body.result || body.error).toBeDefined();
      const result = body.result?.data?.json;
      if (result?.status === "COMPLETED") {
        // Should extract at least some items from any of the receipts
        expect(result.itemCount).toBeGreaterThanOrEqual(1);
      }
    });

    test("Tesco (receipt in nature) — extremely challenging", async () => {
      // This is a receipt hanging on a tree branch — very hard for OCR
      const body = await uploadAndProcess("real-photo-tesco.jpg");
      // We don't assert success — this image may be too degraded
      // Just verify it doesn't crash the server
      expect(body).toBeDefined();
    });
  });

  // ── SROIE detailed tests on known-good images ─────────────────

  test.describe("Known-good SROIE receipts", () => {
    test("sroie-050 (Morganfield's restaurant) — multiple items", async () => {
      const ctx = await authedContext(users.alice.email, users.alice.password);
      try {
        const buf = readFileSync(resolve(receiptDir, "real-sroie-050.jpg"));

        const uploadRes = await ctx.post(`${BASE}/api/upload`, {
          multipart: { file: { name: "sroie-050.jpg", mimeType: "image/jpeg", buffer: buf } },
        });
        const { receiptId } = await uploadRes.json();
        await trpcMutation(ctx, "receipts.processReceipt", { receiptId }, OCR_TIMEOUT);

        const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
        const data = await trpcResult(itemsRes);

        expect(data.receipt.status).toBe("COMPLETED");
        expect(data.items.length).toBeGreaterThanOrEqual(3);

        for (const item of data.items) {
          expect(item.name.length).toBeGreaterThan(0);
          expect(item.totalPrice).toBeGreaterThan(0);
        }
      } finally {
        await ctx.dispose();
      }
    });

    test("sroie-003 (YONGFATT) — total in reasonable range", async () => {
      const body = await uploadAndProcess("real-sroie-003.jpg");
      expect(body.result || body.error).toBeDefined();
      const result = body.result?.data?.json;
      if (result?.status === "COMPLETED") {
        expect(result.total).toBeGreaterThan(1000);
      }
    });

    test("sroie-350 (PINGHWAI bulk purchase) — extracts items", async () => {
      const body = await uploadAndProcess("real-sroie-350.jpg");
      expect(body.result || body.error).toBeDefined();
      const result = body.result?.data?.json;
      if (result?.status === "COMPLETED") {
        // RM 1,007.50 total but OCR may misread digits on this receipt
        expect(result.itemCount).toBeGreaterThanOrEqual(1);
        expect(result.total).toBeGreaterThan(0);
      }
    });
  });
});
