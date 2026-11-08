import { z } from 'zod';
import { currencyCode } from '@/lib/currencies';
import { allocateProportionally } from '@/lib/money';

// Cap individual extracted money fields well below the Int4 column limit so a
// hallucinated or prompt-injected value can't overflow the DB or silently
// inflate expense shares. $10M in cents is far beyond any plausible receipt.
const MAX_RECEIPT_CENTS = 1_000_000_000;

const moneyCents = z.number().int().min(0).max(MAX_RECEIPT_CENTS);

// The extraction prompt asks for null when a receipt shows no store name or
// date. Read null as undefined, so those fields keep their optional string
// type and callers never see null.
const nullAsUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional());

const quantity = z.number().int().min(1).max(10_000);

export const receiptItemSchema = z.object({
  name: z.string().max(500),
  quantity,
  unitPrice: moneyCents, // cents
  totalPrice: moneyCents, // cents
});

// An item as the model returns it: a discount, promo or coupon on the whole order comes as its own
// line with a negative totalPrice (#507). Only such a line may have a negative price.
const scannedItemSchema = receiptItemSchema
  .extend({
    quantity: quantity.default(1),
    unitPrice: z.number().int().min(-MAX_RECEIPT_CENTS).max(MAX_RECEIPT_CENTS),
    totalPrice: z.number().int().min(-MAX_RECEIPT_CENTS).max(MAX_RECEIPT_CENTS),
  })
  .refine((item) => item.totalPrice < 0 || item.unitPrice >= 0, {
    message: 'Only a discount line (a negative totalPrice) may have a negative unitPrice',
    path: ['unitPrice'],
  });

type PricedLine = { quantity: number; unitPrice: number; totalPrice: number };

/**
 * Takes a scan's discount lines (a negative totalPrice) out of its items and takes their sum off the
 * other items in proportion to their totalPrice, with `allocateProportionally`, so the cents add up
 * exactly and every price returned is non-negative (#25, #507). Tax, tip and items are all shared
 * by item price, so each person's share of the discount follows what they had. A zero-priced item
 * takes none of it, and a discount larger than the items makes them all 0, a free order, never less.
 * An item whose totalPrice changes gets the unitPrice `Math.round(totalPrice / quantity)`, as the
 * receipt pages derive it, so on an item of several quantity * unitPrice can be a cent or so off its
 * totalPrice, which is what the split uses. The other items come back as they were, in their order.
 * #333's discount line replaces this once it lands.
 */
export function foldDiscountLines<T extends PricedLine>(items: T[]): T[] {
  const kept = items.filter((item) => item.totalPrice >= 0);
  const discount = items.reduce((sum, item) => (item.totalPrice < 0 ? sum - item.totalPrice : sum), 0);
  const itemsTotal = kept.reduce((sum, item) => sum + item.totalPrice, 0);
  // allocateProportionally splits equally over weights that are all zero; here nothing takes it
  if (discount === 0 || itemsTotal === 0) return kept;
  const shares = allocateProportionally(
    Math.min(discount, itemsTotal),
    kept.map((item) => item.totalPrice),
  );
  return kept.map((item, i) => {
    const share = shares[i]!;
    if (share === 0) return item;
    const totalPrice = item.totalPrice - share;
    return { ...item, totalPrice, unitPrice: Math.round(totalPrice / item.quantity) };
  });
}

export const receiptExtractionSchema = z.object({
  merchantName: nullAsUndefined(z.string().max(500)),
  date: nullAsUndefined(z.string().max(100)),
  items: z
    .array(scannedItemSchema)
    .min(1)
    .max(500)
    .transform(foldDiscountLines)
    .pipe(z.array(receiptItemSchema).min(1, 'Receipt has no items once its discount lines are taken out')),
  subtotal: moneyCents,
  tax: moneyCents.default(0),
  tip: moneyCents.default(0),
  total: moneyCents,
  // An uppercase ISO 4217-shaped code, or undefined when the model couldn't tell (the prompt asks
  // for null, and a model may leave the key out) or returned something else. Unknown isn't USD:
  // the scan falls back to the group's currency (USD outside a group) (#361)
  currency: z.unknown().optional().transform(currencyCode),
  confidence: z.number().min(0).max(1).optional(),
});

export type ReceiptItem = z.infer<typeof receiptItemSchema>;
export type ReceiptExtractionResult = z.infer<typeof receiptExtractionSchema>;
