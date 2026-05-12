import { z } from "zod";

export const extractedDataSchema = z.object({
  merchantName: z.string().optional(),
  date: z.string().optional(),
  subtotal: z.number().default(0),
  tax: z.number().default(0),
  tip: z.number().default(0),
  total: z.number().default(0),
  currency: z.string().default("USD"),
}).passthrough();

export type ExtractedData = z.infer<typeof extractedDataSchema>;

export const guestItemSchema = z.object({
  name: z.string(),
  quantity: z.number().int().min(1),
  unitPrice: z.number().int(),
  totalPrice: z.number().int(),
});

export type GuestItem = z.infer<typeof guestItemSchema>;

export const guestPersonSchema = z.object({
  name: z.string(),
  personToken: z.string().optional(),
  groupSize: z.number().int().min(1).optional(),
});

export type GuestPerson = z.infer<typeof guestPersonSchema>;

export const guestAssignmentSchema = z.object({
  itemIndex: z.number().int(),
  personIndices: z.array(z.number().int()),
});

export type GuestAssignment = z.infer<typeof guestAssignmentSchema>;

export const guestSummaryEntrySchema = z.object({
  personIndex: z.number().int(),
  name: z.string(),
  itemTotal: z.number(),
  tax: z.number(),
  tip: z.number(),
  total: z.number(),
});

export type GuestSummaryEntry = z.infer<typeof guestSummaryEntrySchema>;

export function parseExtractedData(data: unknown): ExtractedData {
  return extractedDataSchema.parse(data ?? {});
}

export function parseGuestItems(data: unknown): GuestItem[] {
  return z.array(guestItemSchema).parse(data);
}

export function parseGuestPeople(data: unknown): GuestPerson[] {
  return z.array(guestPersonSchema).parse(data);
}

export function parseGuestAssignments(data: unknown): GuestAssignment[] {
  return z.array(guestAssignmentSchema).parse(data);
}
