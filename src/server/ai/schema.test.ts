import { describe, it, expect } from 'vitest';
import { foldDiscountLines, receiptExtractionSchema, type ReceiptExtractionResult } from './schema';

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

// #507: models list a promo, coupon or discount on the whole order as an item with a negative
// price, which the schema refused, so the scan failed. The schema now takes such lines off the
// other items in proportion to their price, so everything it returns stays non-negative (#25)
describe('receiptExtractionSchema discount lines (#507)', () => {
  const item = (name: string, totalPrice: number, quantity = 1) => ({
    name,
    quantity,
    unitPrice: totalPrice / quantity,
    totalPrice,
  });
  const promo = (totalPrice: number) => ({ name: 'Promo applied', quantity: 1, unitPrice: totalPrice, totalPrice });
  const totals = (result: ReceiptExtractionResult) => result.items.map((i) => i.totalPrice);

  it('takes a promo line off the only item, leaving tax, tip, subtotal and total as read', () => {
    const lyft = {
      items: [item('Lyft Standard fare', 2793), promo(-139)],
      subtotal: 2654,
      tax: 0,
      tip: 1173,
      total: 3827,
    };
    const result = receiptExtractionSchema.parse(lyft);

    expect(result.items).toEqual([{ name: 'Lyft Standard fare', quantity: 1, unitPrice: 2654, totalPrice: 2654 }]);
    expect(result).toMatchObject({ subtotal: 2654, tax: 0, tip: 1173, total: 3827 });
  });

  it('shares a discount out by item price', () => {
    const result = receiptExtractionSchema.parse({
      ...extraction,
      items: [item('A', 2000), item('B', 3000), promo(-500)],
    });

    expect(totals(result)).toEqual([1800, 2700]);
    expect(result.items.map((i) => i.unitPrice)).toEqual([1800, 2700]);
    // The subtotal stays as the model read it, not the folded items' sum
    expect(result.subtotal).toBe(450);
  });

  it('adds up to the cent when the shares round, giving a tied cent to the earliest item', () => {
    const prices = [1001, 1001, 1001, 457];
    const sum = prices.reduce((a, b) => a + b, 0);
    const result = receiptExtractionSchema.parse({
      ...extraction,
      items: [...prices.map((p, i) => item(`Item ${i}`, p)), promo(-333)],
    });

    const folded = totals(result);
    expect(folded.reduce((a, b) => a + b, 0)).toBe(sum - 333);
    // Each item takes within a cent of its exact share of the discount
    folded.forEach((total, i) => expect(Math.abs(prices[i]! - total - (333 * prices[i]!) / sum)).toBeLessThan(1));
    expect(folded).toEqual([904, 905, 905, 413]);
  });

  it('sums several discount lines, wherever they are, and keeps the items in order', () => {
    const result = receiptExtractionSchema.parse({
      ...extraction,
      items: [promo(-100), item('A', 1000), { ...promo(-200), name: 'Coupon' }, item('B', 2000)],
    });

    expect(result.items.map((i) => [i.name, i.totalPrice])).toEqual([
      ['A', 900],
      ['B', 1800],
    ]);
  });

  it('reads the discount from totalPrice, whatever sign its unitPrice has', () => {
    const result = receiptExtractionSchema.parse({
      ...extraction,
      items: [item('A', 1000), { name: 'Coupon', quantity: 1, unitPrice: 250, totalPrice: -250 }],
    });

    expect(totals(result)).toEqual([750]);
  });

  it('stops at a free order when the discount is larger than the items', () => {
    const result = receiptExtractionSchema.parse({
      ...extraction,
      items: [item('A', 500), item('B', 300), promo(-1000)],
    });

    expect(result.items.map((i) => [i.totalPrice, i.unitPrice])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it('refuses a receipt with nothing but discount lines, saying why', () => {
    const result = receiptExtractionSchema.safeParse({ ...extraction, items: [promo(-139)] });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['items'], message: expect.stringMatching(/discount/i) }),
    ]);
  });

  it('keeps totalPrice exact on an item of several, rounding its unitPrice to the nearest cent', () => {
    const result = receiptExtractionSchema.parse({
      ...extraction,
      items: [item('Tacos', 3000, 3), promo(-100)],
    });

    expect(result.items).toEqual([{ name: 'Tacos', quantity: 3, unitPrice: 967, totalPrice: 2900 }]);
  });

  it('gives a zero-priced item no share of the discount', () => {
    const result = receiptExtractionSchema.parse({
      ...extraction,
      items: [item('Free refill', 0), item('Coffee', 2000), promo(-500)],
    });

    expect(totals(result)).toEqual([0, 1500]);
  });

  it('refuses a discount with only zero-priced items to take it, saying why', () => {
    const result = receiptExtractionSchema.safeParse({
      ...extraction,
      items: [item('Free sample', 0), promo(-500)],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['items'], message: expect.stringMatching(/discount/i) }),
    ]);
  });

  it('still reads an item with no quantity as one, discount or not', () => {
    for (const items of [
      [{ name: 'A', unitPrice: 1000, totalPrice: 1000 }],
      [{ name: 'A', unitPrice: 1000, totalPrice: 1000 }, promo(-100)],
    ]) {
      expect(receiptExtractionSchema.parse({ ...extraction, items }).items[0]?.quantity).toBe(1);
    }
  });

  it('returns items unchanged when the receipt has no discount line', () => {
    const items = [item('A', 1000), { name: 'B', quantity: 3, unitPrice: 333, totalPrice: 1000 }];
    expect(receiptExtractionSchema.parse({ ...extraction, items }).items).toEqual(items);
  });

  it('still refuses a negative tax, tip, subtotal or total (#25)', () => {
    for (const field of ['tax', 'tip', 'subtotal', 'total']) {
      const result = receiptExtractionSchema.safeParse({ ...extraction, [field]: -1 });
      expect(result.success, field).toBe(false);
    }
  });

  it('refuses a negative unitPrice on a line that is not a discount, even when a discount reprices it', () => {
    for (const items of [
      [{ name: 'A', quantity: 1, unitPrice: -100, totalPrice: 500 }],
      [{ name: 'A', quantity: 1, unitPrice: -100, totalPrice: 500 }, promo(-100)],
    ]) {
      expect(receiptExtractionSchema.safeParse({ ...extraction, items }).success).toBe(false);
    }
  });

  it('refuses a discount line beyond the per-field cap', () => {
    for (const discount of [
      promo(-1_000_000_001),
      { name: 'Promo', quantity: 1, unitPrice: -100, totalPrice: -1_000_000_001 },
      { name: 'Promo', quantity: 1, unitPrice: -1_000_000_001, totalPrice: -100 },
    ]) {
      const result = receiptExtractionSchema.safeParse({ ...extraction, items: [item('A', 1000), discount] });
      expect(result.success, JSON.stringify(discount)).toBe(false);
    }
  });
});

describe('foldDiscountLines', () => {
  it('returns the same items when there is no discount line', () => {
    const items = [{ name: 'A', quantity: 1, unitPrice: 100, totalPrice: 100 }];
    expect(foldDiscountLines(items)).toEqual(items);
  });

  it('never leaves an item below zero', () => {
    const items = [
      { name: 'A', quantity: 2, unitPrice: 1, totalPrice: 1 },
      { name: 'B', quantity: 1, unitPrice: 999, totalPrice: 999 },
      { name: 'Coupon', quantity: 1, unitPrice: -999, totalPrice: -999 },
    ];
    const folded = foldDiscountLines(items);
    expect(folded.map((i) => i.totalPrice)).toEqual([0, 1]);
    for (const i of folded) expect(i.unitPrice).toBeGreaterThanOrEqual(0);
  });
});
