import { z } from 'zod';

const guestSessionTokenSchema = z.string().uuid();

export const storedClaimIdentitySchema = z.object({
  name: z.string(),
  personToken: guestSessionTokenSchema,
});
export type StoredClaimIdentity = z.infer<typeof storedClaimIdentitySchema>;

/** The localStorage key under which the claim page keeps this device's identity for a session. */
export function claimStorageKey(shareToken: string): string {
  return `sharetab-claim:${shareToken}`;
}

export function normalizeGuestName(name: string): string {
  return name.trim().toLowerCase();
}

export function isGuestSessionToken(value: string): boolean {
  return guestSessionTokenSchema.safeParse(value).success;
}
