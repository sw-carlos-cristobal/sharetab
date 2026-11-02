import { z } from 'zod';
import { currencyCode } from '@/lib/currencies';

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

export const receiptItemSchema = z.object({
  name: z.string().max(500),
  quantity: z.number().int().min(1).max(10_000).default(1),
  unitPrice: moneyCents, // cents
  totalPrice: moneyCents, // cents
});

export const receiptExtractionSchema = z.object({
  merchantName: nullAsUndefined(z.string().max(500)),
  date: nullAsUndefined(z.string().max(100)),
  items: z.array(receiptItemSchema).min(1).max(500),
  subtotal: moneyCents,
  tax: moneyCents.default(0),
  tip: moneyCents.default(0),
  total: moneyCents,
  // An uppercase ISO 4217-shaped code, or undefined when the model couldn't tell (the prompt asks
  // for null) or returned something else. Unknown isn't USD: the scan falls back to the group's
  // currency (#361)
  currency: z.unknown().transform(currencyCode),
  confidence: z.number().min(0).max(1).optional(),
});

export type ReceiptItem = z.infer<typeof receiptItemSchema>;
export type ReceiptExtractionResult = z.infer<typeof receiptExtractionSchema>;
