import { z } from 'zod';

const guestSessionTokenSchema = z.string().uuid();

export const storedClaimIdentitySchema = z.object({
  name: z.string(),
  personToken: guestSessionTokenSchema,
});
export type StoredClaimIdentity = z.infer<typeof storedClaimIdentitySchema>;
/** Who this device is in a claim session: the stored identity plus that person's current index. */
export type ClaimIdentity = StoredClaimIdentity & { personIndex: number };

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

/**
 * A new random join key (a version 4 UUID): the idempotency key the claim page sends with a
 * join, so a join whose response was lost can be retried as the same person.
 * Built on crypto.getRandomValues because crypto.randomUUID only exists in a secure context,
 * and self-hosted instances are often reached over plain HTTP.
 */
export function newJoinKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A join this page sent but hasn't seen succeed: its join key and the normalized name it was for. */
export type PendingJoin = { joinKey: string; name: string };

/**
 * The join key to send for a join as `name`: the pending one when this retries the same name
 * (the server replays that join), otherwise a new one, since the server refuses a join key
 * replayed with a different name.
 */
export function joinKeyFor(name: string, pending: PendingJoin | null, makeKey = newJoinKey): PendingJoin {
  const normalized = normalizeGuestName(name);
  return pending?.name === normalized ? pending : { joinKey: makeKey(), name: normalized };
}

/**
 * What the claim page does with a guest.resumeSession answer for `personToken`:
 * - adopt: become that person (this device's own stored token or own personal link, or a
 *   personal link the user confirmed);
 * - confirm: a personal link names someone other than this device's person, so ask first;
 * - linkInvalid: nobody holds a personal link's token, so say so and fall back to the stored identity;
 * - forget: nobody holds this device's stored token any more (e.g. the person was removed);
 * - stale: the stored token changed while the request was out (e.g. another tab joined), so
 *   the answer is about someone this device no longer is: resume whoever is stored now.
 */
export type ResumeOutcome = 'adopt' | 'confirm' | 'linkInvalid' | 'forget' | 'stale';

export function resumeOutcome(answer: {
  found: boolean;
  fromLink: boolean;
  /** The user already accepted this personal link's card */
  confirmed: boolean;
  personToken: string;
  storedToken: string | undefined;
}): ResumeOutcome {
  const isStored = answer.personToken === answer.storedToken;
  if (answer.fromLink) {
    if (!answer.found) return 'linkInvalid';
    return answer.confirmed || isStored ? 'adopt' : 'confirm';
  }
  if (!isStored) return 'stale';
  return answer.found ? 'adopt' : 'forget';
}

/**
 * Whether to retry a failed guest.resumeSession. Network and server errors are retried (three
 * attempts in all), because a lost resume leaves the join form up while this device still holds
 * a valid token; client errors (the session is gone, rate limited) are final.
 */
export function shouldRetryResume(failureCount: number, httpStatus: number | undefined): boolean {
  return failureCount < 2 && (httpStatus ?? 500) >= 500;
}

// A personal link is the claim page URL with this device's person token in the #fragment,
// so the same person can continue on another device. Browsers never send the fragment to
// the server, so the token stays out of request URLs, and so out of access logs and Referer
// headers. (The page still sends the token in POST bodies, e.g. to guest.resumeSession.)
const PERSONAL_LINK_PARAM = 'me';

export function personalLinkHash(personToken: string): string {
  return `#${PERSONAL_LINK_PARAM}=${personToken}`;
}

/** The person token in a personal link's #fragment, or null if there isn't a valid one. */
export function readPersonalLinkToken(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get(PERSONAL_LINK_PARAM);
  return value && isGuestSessionToken(value) ? value : null;
}
