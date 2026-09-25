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

// A personal link is the claim page URL with this device's person token in the #fragment,
// so the same person can continue on another device. Browsers never send the fragment to
// the server, so the token stays out of requests, server logs and Referer headers.
const PERSONAL_LINK_PARAM = 'me';

export function personalLinkHash(personToken: string): string {
  return `#${PERSONAL_LINK_PARAM}=${personToken}`;
}

/** The person token in a personal link's #fragment, or null if there isn't a valid one. */
export function readPersonalLinkToken(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get(PERSONAL_LINK_PARAM);
  return value && isGuestSessionToken(value) ? value : null;
}
