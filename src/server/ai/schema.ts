import { z } from "zod";

export const receiptItemSchema = z.object({
  name: z.string(),
  quantity: z.number().int().min(1).default(1),
  unitPrice: z.number().int().min(0), // cents
  totalPrice: z.number().int().min(0), // cents
});

export const receiptExtractionSchema = z.object({
  merchantName: z.string().optional(),
  date: z.string().optional(),
  items: z.array(receiptItemSchema).min(1),
  subtotal: z.number().int().min(0),
  tax: z.number().int().min(0).default(0),
  tip: z.number().int().min(0).default(0),
  total: z.number().int().min(0),
  currency: z.string().default("USD"),
  confidence: z.number().min(0).max(1).optional(),
});

export type ReceiptItem = z.infer<typeof receiptItemSchema>;
export type ReceiptExtractionResult = z.infer<typeof receiptExtractionSchema>;
