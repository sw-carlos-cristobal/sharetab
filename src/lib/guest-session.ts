import { z } from 'zod';

const guestSessionTokenSchema = z.string().uuid();

export const storedClaimIdentitySchema = z.object({
  name: z.string(),
  personToken: guestSessionTokenSchema,
});
export type StoredClaimIdentity = z.infer<typeof storedClaimIdentitySchema>;
/**
 * Who this device is in a claim session: the stored identity plus that person's id, which
 * (unlike their index) doesn't change when someone listed before them is removed.
 */
export type ClaimIdentity = StoredClaimIdentity & { personId: string };

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
 * A new random request key (a version 4 UUID): the idempotency key the claim page sends with a
 * join (its join key), so a join whose response was lost can be retried as the same person, and
 * with a claim save (its save key), so a save whose answer was lost can be sent again without
 * being applied twice.
 * Built on crypto.getRandomValues because crypto.randomUUID only exists in a secure context,
 * and self-hosted instances are often reached over plain HTTP.
 */
export function newRequestKey(): string {
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
export function joinKeyFor(name: string, pending: PendingJoin | null, makeKey = newRequestKey): PendingJoin {
  const normalized = normalizeGuestName(name);
  return pending?.name === normalized ? pending : { joinKey: makeKey(), name: normalized };
}

/**
 * Whether this device may become the person a join or an accepted personal link answered with,
 * given the token it stored when the request was sent and the one stored now. Tabs of one
 * browser share the stored identity, so another tab may have become someone else while the
 * request was out; adopting the later answer would replace them, and the person they became
 * would be left without a stored token (#213). Adopt only when that can't happen: storage is
 * unchanged, empty (replacing nobody), or already holds the person answered for.
 */
export function canAdoptAnswer(answer: {
  personToken: string;
  storedAtStart: string | undefined;
  storedNow: string | undefined;
}): boolean {
  return (
    answer.storedNow === undefined ||
    answer.storedNow === answer.storedAtStart ||
    answer.storedNow === answer.personToken
  );
}

/**
 * What the claim page does with a guest.resumeSession answer for `personToken`:
 * - adopt: become that person (this device's own stored token or own personal link, or a
 *   personal link the user confirmed, if no other tab became someone else meanwhile);
 * - confirm: a personal link names someone other than this device's person, so ask first (or
 *   again: another tab of this browser stored someone else while the confirmed lookup was out,
 *   so the card now says who continuing replaces);
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
  /** The token this device stores now */
  storedToken: string | undefined;
  /** The token it stored when the request was sent */
  storedAtStart: string | undefined;
}): ResumeOutcome {
  const isStored = answer.personToken === answer.storedToken;
  if (answer.fromLink) {
    if (!answer.found) return 'linkInvalid';
    if (isStored) return 'adopt';
    const stillConfirmed =
      answer.confirmed &&
      canAdoptAnswer({
        personToken: answer.personToken,
        storedAtStart: answer.storedAtStart,
        storedNow: answer.storedToken,
      });
    return stillConfirmed ? 'adopt' : 'confirm';
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

/** How often the claim page reloads the session while claims are open. */
export const CLAIM_POLL_MS = 3000;
/** How often it tries again after a reload failed: rate limited, a server error, or offline. */
export const CLAIM_POLL_RETRY_MS = 15000;

/**
 * When the claim page next reloads the session (guest.getSession), or false to stop: once the
 * split is finalized, or once the session is gone (404: expired or deleted). After any other
 * failure it keeps trying, less often, so a viewer who was rate limited or briefly offline goes
 * back to seeing other people's claims without reloading the page (#204).
 */
export function claimPollInterval(poll: {
  finalized: boolean;
  error: { httpStatus: number | undefined } | null;
}): number | false {
  if (poll.finalized) return false;
  if (poll.error === null) return CLAIM_POLL_MS;
  return poll.error.httpStatus === 404 ? false : CLAIM_POLL_RETRY_MS;
}

/**
 * After guest.getSession failed, whether the claim page gives up on the session and shows the
 * not-found screen: when it never loaded, or the server says it's gone (404). A session already
 * on screen stays there through any other failed reload while the poll tries again, instead of
 * a rate-limited or dropped request replacing the page (#204).
 */
export function isSessionLost(loaded: boolean, httpStatus: number | undefined): boolean {
  return !loaded || httpStatus === 404;
}

/**
 * Whether the claim page should ask the server (guest.resumeSession) if this device's person
 * is still in the session: someone on another device may have removed them. Only when the
 * session as loaded doesn't list them; at most once per load (loadedAt is the load's time,
 * checkedThrough the last checked load's); never for a load from before this device became
 * that person (checkedThrough is set to that moment), since a join's answer arrives before a
 * load lists the new person; and not while a join, resume or earlier check is in flight.
 */
export function needsMembershipCheck(check: {
  personId: string | null;
  isListed: (personId: string) => boolean;
  loadedAt: number;
  checkedThrough: number;
  busy: boolean;
}): boolean {
  return (
    check.personId !== null && !check.busy && check.loadedAt > check.checkedThrough && !check.isListed(check.personId)
  );
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
