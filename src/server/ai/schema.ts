import { z } from "zod";

// Cap individual extracted money fields well below the Int4 column limit so a
// hallucinated or prompt-injected value can't overflow the DB or silently
// inflate expense shares. $10M in cents is far beyond any plausible receipt.
const MAX_RECEIPT_CENTS = 1_000_000_000;

const moneyCents = z.number().int().min(0).max(MAX_RECEIPT_CENTS);

export const receiptItemSchema = z.object({
  name: z.string().max(500),
  quantity: z.number().int().min(1).max(10_000).default(1),
  unitPrice: moneyCents, // cents
  totalPrice: moneyCents, // cents
});

export const receiptExtractionSchema = z.object({
  merchantName: z.string().max(500).optional(),
  date: z.string().max(100).optional(),
  items: z.array(receiptItemSchema).min(1).max(500),
  subtotal: moneyCents,
  tax: moneyCents.default(0),
  tip: moneyCents.default(0),
  total: moneyCents,
  // Normalize to an uppercase ISO 4217-shaped code: downstream UI passes this
  // into Intl.NumberFormat, which throws for malformed currency strings.
  currency: z
    .string()
    .max(10)
    .default("USD")
    .transform((c) => (/^[a-zA-Z]{3}$/.test(c.trim()) ? c.trim().toUpperCase() : "USD")),
  confidence: z.number().min(0).max(1).optional(),
});

export type ReceiptItem = z.infer<typeof receiptItemSchema>;
export type ReceiptExtractionResult = z.infer<typeof receiptExtractionSchema>;
