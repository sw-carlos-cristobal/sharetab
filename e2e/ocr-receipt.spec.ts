import { test, expect, request } from "@playwright/test";
import { resolve } from "path";
import { readFileSync } from "fs";
import {
  users,
  login,
  authedContext,
  trpcMutation,
  trpcQuery,
  trpcResult,
  createTestGroup,
  navigateToGroup,
} from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const OCR_TIMEOUT = 120000; // Tesseract can be slow on first run (downloads WASM + lang data)

test.describe("OCR Receipt Scanning", () => {
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS) testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });
  test.setTimeout(120000);

  // ── API Tests ───────────────────────────────────────────────

  test.describe("API — OCR processing", () => {
    test("OCR extracts items from test receipt", async () => {
      const ctx = await authedContext(users.alice.email, users.alice.password);
      try {
        const receiptBuffer = readFileSync(resolve("e2e/test-receipt.png"));

        // Upload
        const uploadRes = await ctx.post(`${BASE}/api/upload`, {
          multipart: {
            file: { name: "ocr-test.png", mimeType: "image/png", buffer: receiptBuffer },
          },
        });
        expect(uploadRes.status()).toBe(200);
        const { receiptId } = await uploadRes.json();

        // Process
        const processRes = await trpcMutation(
          ctx, "receipts.processReceipt", { receiptId }, OCR_TIMEOUT
        );
        const result = (await processRes.json()).result?.data?.json;
        expect(result.status).toBe("COMPLETED");
        expect(result.itemCount).toBeGreaterThanOrEqual(1);
        expect(result.total).toBeGreaterThan(0);
      } finally {
        await ctx.dispose();
      }
    });

    test("OCR returns items with names and prices", async () => {
      const ctx = await authedContext(users.alice.email, users.alice.password);
      try {
        const receiptBuffer = readFileSync(resolve("e2e/test-receipt.png"));

        const uploadRes = await ctx.post(`${BASE}/api/upload`, {
          multipart: {
            file: { name: "ocr-items.png", mimeType: "image/png", buffer: receiptBuffer },
          },
        });
        const { receiptId } = await uploadRes.json();
        await trpcMutation(ctx, "receipts.processReceipt", { receiptId }, OCR_TIMEOUT);

        // Get items
        const itemsRes = await trpcQuery(ctx, "receipts.getReceiptItems", { receiptId });
        const data = await trpcResult(itemsRes);
        expect(data.receipt.status).toBe("COMPLETED");
        expect(data.items.length).toBeGreaterThanOrEqual(1);

        for (const item of data.items) {
          expect(item.name).toBeTruthy();
          expect(item.totalPrice).toBeGreaterThan(0);
        }
      } finally {
        await ctx.dispose();
      }
    });

    test("OCR full flow — upload, process, assign, create expense", async () => {
      const { owner, groupId, memberIds, dispose } = await createTestGroup(
        users.alice.email, users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        "OCR Expense Test"
      );
      const aliceId = memberIds[users.alice.email];
      const bobId = memberIds[users.bob.email];

      const receiptBuffer = readFileSync(resolve("e2e/test-receipt.png"));
      const uploadRes = await owner.post(`${BASE}/api/upload`, {
        multipart: {
          file: { name: "ocr-flow.png", mimeType: "image/png", buffer: receiptBuffer },
        },
      });
      const { receiptId } = await uploadRes.json();

      // Process with OCR
      await trpcMutation(owner, "receipts.processReceipt", { receiptId }, OCR_TIMEOUT);

      // Get items
      const itemsRes = await trpcQuery(owner, "receipts.getReceiptItems", { receiptId });
      const { items } = await trpcResult(itemsRes);
      expect(items.length).toBeGreaterThanOrEqual(1);

      // Assign all items to both users
      const assignments = items.map((item: { id: string }) => ({
        receiptItemId: item.id,
        userIds: [aliceId, bobId],
      }));

      // Create expense from OCR items
      const expRes = await trpcMutation(owner, "receipts.assignItemsAndCreateExpense", {
        groupId,
        receiptId,
        title: "OCR Dinner",
        paidById: aliceId,
        assignments,
      });
      const expense = (await expRes.json()).result?.data?.json;
      expect(expense.splitMode).toBe("ITEM");
      expect(expense.amount).toBeGreaterThan(0);

      await dispose();
    });

    test("OCR guest flow — upload and process without auth", async () => {
      const receiptBuffer = readFileSync(resolve("e2e/test-receipt.png"));

      const guestCtx = await request.newContext({ baseURL: BASE });

      // Guest upload
      const uploadRes = await guestCtx.post("/api/upload?guest=true", {
        multipart: {
          file: { name: "guest-ocr.png", mimeType: "image/png", buffer: receiptBuffer },
        },
      });
      expect(uploadRes.status()).toBe(200);
      const { receiptId } = await uploadRes.json();

      // Process as guest
      const processRes = await trpcMutation(
        guestCtx, "guest.processReceipt", { receiptId }, OCR_TIMEOUT
      );
      const result = (await processRes.json()).result?.data?.json;
      expect(result.status).toBe("COMPLETED");
      expect(result.itemCount).toBeGreaterThanOrEqual(1);

      await guestCtx.dispose();
    });
  });

  // ── Browser UI Tests ────────────────────────────────────────

  test.describe("UI — OCR scan page", () => {
    test("authenticated scan page uploads and processes receipt", async ({ page }) => {
      await login(page, users.alice.email, users.alice.password);
      await navigateToGroup(page, "Apartment");
      const groupUrl = page.url();
      await page.goto(groupUrl + "/scan");

      // Upload using the gallery input (second file input, no capture attr)
      const fileInput = page.locator('input[type="file"]:not([capture])');
      await fileInput.setInputFiles(resolve("e2e/test-receipt.png"));

      // Wait for processing to complete — should show dollar amounts
      await expect(page.getByText(/\$\d+\.\d{2}/).first()).toBeVisible({ timeout: 120000 });
    });

    test("guest split page uploads and processes receipt", async ({ page }) => {
      await page.goto("/en/split");
      await expect(page.getByText("Split a bill")).toBeVisible();

      // Upload using the "Choose from Gallery" input (no capture attr)
      const fileInput = page.locator('input[type="file"]:not([capture])');
      await fileInput.setInputFiles(resolve("e2e/test-receipt.png"));

      // After OCR processing, the guest flow advances to "Who's splitting?"
      await expect(page.getByText("Who's splitting?")).toBeVisible({ timeout: 120000 });
      await expect(page.getByText("Assign Items")).toBeVisible();
    });
  });
});
