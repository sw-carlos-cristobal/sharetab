import type { SaveOutcome } from './claim-drafts';
import { CLAIM_POLL_RETRY_MS } from './guest-session';

/**
 * How many times the claim page sends one save (with the same save key) before it stops waiting
 * to learn whether it was stored: waits of 45 to 90 seconds in all between attempts that got no
 * answer. Past that the save's changes stay as unsaved edits, as before #238.
 */
export const SAVE_ATTEMPTS = 10;

/** How long the claim page waits for the answer to one save attempt before sending it again. */
export const SAVE_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * How a save attempt that failed ended, from the HTTP status of the server's error answer
 * (undefined when no answer came). `retry`: the attempt sent a save again, with the same save
 * key, after an earlier attempt of it got no answer; the server answers a retry of a stored save
 * as stored (#238).
 * - No answer, or a server error: unknown. A server error can come after the save was stored
 *   (e.g. the connection dropped at commit), and sending it again is safe.
 * - A retry rate limited (429) or that lost to other writes (409, the transaction's retries ran
 *   out): unknown. It stored nothing, but an earlier attempt may have.
 * - Any other client error: refused. For a first attempt nothing was stored; for a retry the
 *   refusal is for good (the session was finalized or is gone, or the caller was removed), and
 *   whatever an earlier attempt stored no longer matters.
 */
export function failedSaveOutcome(httpStatus: number | undefined, retry: boolean): SaveOutcome {
  if (httpStatus === undefined || httpStatus >= 500) return 'unknown';
  if (retry && (httpStatus === 429 || httpStatus === 409)) return 'unknown';
  return 'refused';
}

/**
 * How long the claim page waits before sending an unanswered save again, or reloading again
 * after a stored save: a second, doubling each attempt up to the poll's own retry interval, and
 * jittered into the upper half of that, so pages that lost the server together don't all come
 * back at once. `attempt` counts from 0.
 */
export function saveRetryDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(1000 * 2 ** attempt, CLAIM_POLL_RETRY_MS);
  return ceiling / 2 + (random() * ceiling) / 2;
}

/**
 * Sends a save until the answer settles whether it was stored (up to SAVE_ATTEMPTS), then
 * reloads the session. A stored save reloads until a reload lands (or the session is gone), so
 * its changes stay in the save in flight rather than showing as unsaved changes the server
 * already has; any other outcome reloads once. Stops, without reloading, as soon as `going()`
 * turns false (the page closed, or its unsaved changes were discarded).
 */
export async function settleSave(steps: {
  send: (retry: boolean) => Promise<SaveOutcome>;
  reload: () => Promise<'loaded' | 'failed' | 'gone'>;
  wait: (ms: number) => Promise<void>;
  going: () => boolean;
  delay?: (attempt: number) => number;
}): Promise<{ outcome: SaveOutcome; reloaded: boolean }> {
  const delay = steps.delay ?? saveRetryDelay;
  let outcome = await steps.send(false);
  for (let attempt = 1; outcome === 'unknown' && attempt < SAVE_ATTEMPTS && steps.going(); attempt++) {
    await steps.wait(delay(attempt - 1));
    if (!steps.going()) break;
    outcome = await steps.send(true);
  }
  if (!steps.going()) return { outcome, reloaded: false };

  let reload = await steps.reload();
  for (let attempt = 0; reload === 'failed' && outcome === 'saved' && steps.going(); attempt++) {
    await steps.wait(delay(attempt));
    if (!steps.going()) break;
    reload = await steps.reload();
  }
  return { outcome, reloaded: reload === 'loaded' };
}
