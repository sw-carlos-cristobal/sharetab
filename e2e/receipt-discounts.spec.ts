import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { users, authedContext, trpcMutation, trpcQuery, trpcResult } from './helpers';

/**
 * Scans receipts with promo, coupon and discount lines through the configured AI provider (#507).
 * Models list an order-wide discount as an item with a negative price, and the scan takes it off the
 * other items, so the scan succeeds, no discount line is left as an item, and the items add up to
 * the receipt's discounted subtotal whichever items the model puts the discount on. Needs
 * RUN_AI_TESTS=1: the mock provider returns fixed items without reading the image. The images, and
 * the amounts below, come from e2e/generate-receipt-images.mjs.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const AI_TIMEOUT = 150_000;

const receipts = [
  // An order-wide promo code, with tax and tip
  { file: 'discount-promo-pizzeria.png', itemsTotal: 3200, tax: 264, tip: 600, total: 4064 },
  // A per-item member saving, an order-wide store coupon and a "you saved" summary line
  { file: 'discount-coupon-grocery.png', itemsTotal: 2403, tax: 120, tip: 0, total: 2523 },
  // The ride receipt from #507: a fare, a tip and a promo
  { file: 'discount-ride-promo.png', itemsTotal: 2654, tax: 0, tip: 1173, total: 3827 },
  // Two order-wide discounts, one a percentage
  { file: 'discount-bar-tab.png', itemsTotal: 4050, tax: 324, tip: 0, total: 4374 },
];

const DISCOUNT_NAME = /promo|coupon|discount|saving|saved|happy hour|loyalty/i;

type ScannedReceipt = {
  receipt: { status: string; extractedData: Record<string, unknown> };
  items: { name: string; unitPrice: number; totalPrice: number }[];
};

test.describe('Receipt scans with discount lines (#507)', () => {
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS) testInfo.skip(true, 'Set RUN_AI_TESTS=1 to enable');
  });
  test.setTimeout(AI_TIMEOUT);

  for (const expected of receipts) {
    test(`${expected.file} scans with its discounts taken off the items`, async () => {
      const ctx = await authedContext(users.alice.email, users.alice.password);
      try {
        const upload = await ctx.post(`${BASE}/api/upload`, {
          multipart: {
            file: {
              name: expected.file,
              mimeType: 'image/png',
              buffer: readFileSync(resolve('e2e/receipts', expected.file)),
            },
          },
        });
        expect(upload.ok(), await upload.text()).toBe(true);
        const { receiptId } = await upload.json();

        const processed = await trpcMutation(ctx, 'receipts.processReceipt', { receiptId }, AI_TIMEOUT);
        expect(processed.ok(), await processed.text()).toBe(true);

        const { receipt, items } = (await trpcResult(
          await trpcQuery(ctx, 'receipts.getReceiptItems', { receiptId }),
        )) as ScannedReceipt;
        expect(receipt.status).toBe('COMPLETED');
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
          expect(item.name).not.toMatch(DISCOUNT_NAME);
          expect(item.totalPrice, item.name).toBeGreaterThanOrEqual(0);
          expect(item.unitPrice, item.name).toBeGreaterThanOrEqual(0);
        }
        expect(items.reduce((sum, item) => sum + item.totalPrice, 0)).toBe(expected.itemsTotal);
        expect(receipt.extractedData).toMatchObject({ tax: expected.tax, tip: expected.tip, total: expected.total });
      } finally {
        await ctx.dispose();
      }
    });
  }
});
