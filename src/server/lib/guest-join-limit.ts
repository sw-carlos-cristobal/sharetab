import { normalizeGuestName } from '@/lib/guest-session';
import { checkRateLimit, peekRateLimit } from './rate-limit';

/**
 * Joins per person per minute: per share token and the caller's person token when it sends one,
 * otherwise per share token and typed name. The claim page only joins when the user asks;
 * returning devices use guest.resumeSession.
 */
const JOIN_LIMIT_PER_PERSON = 10;
/** Joins per share token per minute, all names combined: twice for each of the 100 people a session holds. */
const JOIN_LIMIT_PER_SESSION = 200;
const JOIN_WINDOW_MS = 60 * 1000;

/**
 * Rate limit for guest.joinSession. A token holder rejoining with a
 * different groupSize writes the session row on every call, so an unlimited
 * loop keeps that row busy and other people's claims can run out of retries.
 *
 * The per-person budget stops a client looping on one person. It follows the
 * identity joinSession uses: a caller that sends a person token (a returning
 * device) is budgeted by that token, since joinSession returns its holder
 * whatever name was typed; otherwise by the typed name. So refused joins under
 * Alice's name from someone without her token don't use up her own device's
 * budget. The joins it is allowed still count toward the per-session budget, which bounds all joins
 * (and so all joinSession transactions) on one share token. A refused call
 * consumes nothing: the session budget is peeked before the person budget is
 * spent, so a session that is already full does not use up the person's own
 * budget.
 *
 * Known tradeoff: a client that changes the name (or presents a different
 * made-up person token) on every call is held only
 * by the per-session budget, so it can use it up and block other joins on
 * that token until the window resets. Anyone with the share link can already
 * do the same to claimItems (10 a minute per token); there is no per-IP
 * bound because people splitting a bill often share one IP.
 *
 * Kept out of guest.ts so the check order can be unit-tested against the real
 * limiter; guest.test.ts mocks rate-limit for the whole file.
 */
export function checkJoinRateLimit(token: string, name: string, personToken?: string): boolean {
  const sessionKey = `guest-join:${token}`;
  // JSON-encoded so a token or name containing ':' can't land on another pair's key
  const person = personToken ? ['token', personToken] : ['name', normalizeGuestName(name)];
  const personKey = `guest-join-person:${JSON.stringify([token, ...person])}`;

  if (!peekRateLimit(sessionKey, JOIN_LIMIT_PER_SESSION).allowed) return false;
  if (!checkRateLimit(personKey, JOIN_LIMIT_PER_PERSON, JOIN_WINDOW_MS).allowed) return false;
  // Synchronous since the peek, so the session budget still has room
  checkRateLimit(sessionKey, JOIN_LIMIT_PER_SESSION, JOIN_WINDOW_MS);
  return true;
}
