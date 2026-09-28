import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export const extractedDataSchema = z
  .object({
    merchantName: z.string().optional(),
    date: z.string().optional(),
    subtotal: z.number().int().min(0).default(0),
    tax: z.number().int().min(0).default(0),
    tip: z.number().int().min(0).default(0),
    total: z.number().int().min(0).default(0),
    currency: z.string().default('USD'),
  })
  .passthrough();

export type ExtractedData = z.infer<typeof extractedDataSchema>;

export const guestItemSchema = z.object({
  name: z.string(),
  quantity: z.number().int().min(1),
  unitPrice: z.number().int().min(0),
  totalPrice: z.number().int().min(0),
});

export type GuestItem = z.infer<typeof guestItemSchema>;

/** A claim save's key and a digest of its changes, kept on the person who sent it (guest.claimItems, #238). */
const guestSaveRecordSchema = z.object({ key: z.string(), hash: z.string() });

/**
 * The well-formed records in a person's stored `saves`; anything else is ignored rather than
 * failing the request. (guestPersonSchema leaves `saves` out: parsing strips it, and the one
 * caller, finalizeSession, doesn't use it.)
 */
export function validSaveRecords(value: unknown): z.infer<typeof guestSaveRecordSchema>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((record) => {
    const parsed = guestSaveRecordSchema.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });
}

export const guestPersonSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  personToken: z.string().optional(),
  groupSize: z.number().int().min(1).optional(),
  join: z.object({ key: z.string(), name: z.string(), expiresAt: z.number() }).optional(),
});

export type GuestPerson = z.infer<typeof guestPersonSchema>;

export const guestAssignmentSchema = z.object({
  itemIndex: z.number().int().min(0),
  personIndices: z.array(z.number().int().min(0)),
});

export type GuestAssignment = z.infer<typeof guestAssignmentSchema>;

export const guestSummaryEntrySchema = z.object({
  personIndex: z.number().int().min(0),
  name: z.string(),
  itemTotal: z.number(),
  tax: z.number(),
  tip: z.number(),
  total: z.number(),
});

export type GuestSummaryEntry = z.infer<typeof guestSummaryEntrySchema>;

function wrapZodError(label: string, fn: () => unknown) {
  try {
    return fn();
  } catch (err) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Invalid ${label} data`,
      cause: err,
    });
  }
}

export function parseExtractedData(data: unknown): ExtractedData {
  return wrapZodError('receipt', () => extractedDataSchema.parse(data ?? {})) as ExtractedData;
}

export function parseGuestItems(data: unknown): GuestItem[] {
  return wrapZodError('items', () => z.array(guestItemSchema).parse(data)) as GuestItem[];
}

export function parseGuestPeople(data: unknown): GuestPerson[] {
  return wrapZodError('people', () => z.array(guestPersonSchema).parse(data)) as GuestPerson[];
}

export function parseGuestAssignments(data: unknown): GuestAssignment[] {
  return wrapZodError('assignments', () => z.array(guestAssignmentSchema).parse(data)) as GuestAssignment[];
}
