import { describe, it, expect } from 'vitest';
import { receiptExtractionSchema, type ReceiptExtractionResult } from './schema';

const extraction = {
  items: [{ name: 'Coffee', quantity: 1, unitPrice: 450, totalPrice: 450 }],
  subtotal: 450,
  tax: 36,
  tip: 0,
  total: 486,
  currency: 'USD',
};

describe('receiptExtractionSchema', () => {
  it('reads a null merchantName and date as undefined (#247)', () => {
    const result = receiptExtractionSchema.parse({ ...extraction, merchantName: null, date: null });

    // Typed without merchantName and date: they stay optional fields.
    const expected: ReceiptExtractionResult = extraction;
    expect(result).toEqual(expected);
  });

  it('accepts a missing merchantName and date, and keeps ones the model read', () => {
    expect(receiptExtractionSchema.parse(extraction)).toEqual(extraction);
    const read = { ...extraction, merchantName: 'Cafe', date: '2026-10-04' };
    expect(receiptExtractionSchema.parse(read)).toEqual(read);
  });

  it('still rejects a merchantName or date that is not a string or is too long', () => {
    expect(receiptExtractionSchema.safeParse({ ...extraction, merchantName: 42 }).success).toBe(false);
    expect(receiptExtractionSchema.safeParse({ ...extraction, date: 20261004 }).success).toBe(false);
    expect(receiptExtractionSchema.safeParse({ ...extraction, merchantName: 'x'.repeat(501) }).success).toBe(false);
    expect(receiptExtractionSchema.safeParse({ ...extraction, date: 'x'.repeat(101) }).success).toBe(false);
  });
});
