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

// #361: the schema turned a missing or malformed currency into USD, so a receipt whose currency
// the model couldn't read was converted from USD into the group's currency
describe('receiptExtractionSchema currency (#361)', () => {
  it('reads a null or malformed currency as unknown, not USD', () => {
    for (const currency of [null, '', '$', 'US Dollar', 'EURO', 42]) {
      const result = receiptExtractionSchema.parse({ ...extraction, currency });
      expect(result.currency, JSON.stringify(currency)).toBeUndefined();
    }
  });

  it('reads a reply that leaves the currency out as unknown, rather than failing the scan', () => {
    const withoutCurrency: Record<string, unknown> = { ...extraction };
    delete withoutCurrency.currency;
    expect(Object.keys(withoutCurrency)).not.toContain('currency');
    const result = receiptExtractionSchema.safeParse(withoutCurrency);
    expect(result.success && result.data.currency).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('keeps a currency code the model read, uppercased', () => {
    expect(receiptExtractionSchema.parse({ ...extraction, currency: 'eur' }).currency).toBe('EUR');
    expect(receiptExtractionSchema.parse({ ...extraction, currency: ' JPY ' }).currency).toBe('JPY');
  });
});
