import { checkRateLimit, peekRateLimit } from './rate-limit';

/**
 * Saves of one kind per person per minute (the caller's person token). One every two seconds,
 * faster than anyone picks items and presses Save, even for someone claiming for the whole table.
 */
const WRITE_LIMIT_PER_PERSON = 30;
/** Saves of one kind per share token per minute, everyone combined: three for each of the 100 people a session holds. */
const WRITE_LIMIT_PER_SESSION = 300;
/**
 * getSession calls per share token per minute. The claim page polls every 3 s (20 a minute), so
 * 100 open pages make 2000; the rest covers extra tabs and the reloads after each save.
 */
const READ_LIMIT_PER_SESSION = 3000;
const WINDOW_MS = 60 * 1000;

/** The claim-session changes that take a person token, each budgeted separately. */
export type ClaimWriteAction = 'claim' | 'edit-name' | 'remove-person' | 'split-item';

/**
 * Rate limit for the claim-session changes that take a person token: claimItems,
 * editPersonName, removePerson and splitClaimItem. Each write runs a transaction on the
 * session row, so an unlimited loop keeps that row busy and other people's saves can run
 * out of retries.
 *
 * Two budgets per kind of change, as checkJoinRateLimit does for joins: the per-person budget
 * stops one client looping, and the per-session budget bounds all such writes on one share
 * token. A single per-session budget sized for one or two people refused the eleventh person
 * saving in the same minute, and let anyone with the link block every save (#204). A refused
 * call consumes nothing: the session budget is peeked before the person budget is spent.
 *
 * The person token is checked against the session only inside the transaction, after this
 * runs, so a made-up token gets a budget of its own. A client that sends a new one on every
 * call is held only by the per-session budget and can use it up until the window resets;
 * the same tradeoff checkJoinRateLimit accepts for names.
 *
 * Kept out of guest.ts so the limits can be unit-tested against the real limiter;
 * guest.test.ts mocks rate-limit for the whole file.
 */
export function checkClaimWriteRateLimit(action: ClaimWriteAction, token: string, personToken: string): boolean {
  const sessionKey = `guest-${action}:${token}`;
  // JSON-encoded so a token containing ':' can't land on another pair's key
  const personKey = `guest-${action}-person:${JSON.stringify([token, personToken])}`;

  if (!peekRateLimit(sessionKey, WRITE_LIMIT_PER_SESSION).allowed) return false;
  if (!checkRateLimit(personKey, WRITE_LIMIT_PER_PERSON, WINDOW_MS).allowed) return false;
  // Synchronous since the peek, so the session budget still has room
  checkRateLimit(sessionKey, WRITE_LIMIT_PER_SESSION, WINDOW_MS);
  return true;
}

/**
 * Rate limit for guest.getSession, one budget per share token. getSession takes no person
 * token (people poll before they join), so there's no per-viewer budget; the limit is sized
 * so that a full session's pages never reach it.
 */
export function checkSessionReadRateLimit(token: string): boolean {
  return checkRateLimit(`guest-session-read:${token}`, READ_LIMIT_PER_SESSION, WINDOW_MS).allowed;
}
