import type { SaveOutcome } from './claim-drafts';
import { CLAIM_POLL_RETRY_MS } from './guest-session';

/**
 * How many times the claim page sends one save (with the same save key) before it stops waiting
 * to learn whether it was stored, and how many times it reloads after a stored save before it
 * stops waiting for a reload to land. Attempts wait for the device to be online, so an outage
 * doesn't use them up; the waits between them add up to 45 to 90 seconds, plus up to
 * SAVE_ATTEMPT_TIMEOUT_MS for each attempt that hangs. Past that, editsAfterSave keeps what it
 * can't settle.
 */
export const SAVE_ATTEMPTS = 10;

/** How long the claim page waits for the answer to one save attempt, or one reload, before giving up on it. */
export const SAVE_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * How a save attempt that failed ended, from the HTTP status of the server's error answer
 * (undefined when no answer came). `retry`: the attempt sent a save again, with the same save
 * key, after an earlier attempt of it got no answer; the server answers a retry of a stored save
 * as stored (#238).
 * - No answer, or a server error other than 503: unknown. The error can come after the save was
 *   stored (e.g. the connection dropped at commit), and sending it again is safe.
 * - A first attempt refused with any other status stored nothing: a client error, 409 (the
 *   person is no longer in the split, or the transaction's retries ran out), 429 (rate limited)
 *   or 503 (busy: the transaction rolled back; #203 doesn't retry it).
 * - A retry answered 409, 429 or 503 stored nothing itself, but an earlier attempt may have:
 *   unknown. (A 409 can also mean the person was removed; the page then stops at its next poll,
 *   which no longer lists them.)
 * - A retry refused otherwise is refused for good (the session was finalized or is gone, or the
 *   caller was removed): whatever an earlier attempt stored no longer matters.
 */
export function failedSaveOutcome(httpStatus: number | undefined, retry: boolean): SaveOutcome {
  if (httpStatus === undefined || (httpStatus >= 500 && httpStatus !== 503)) return 'unknown';
  if (retry && (httpStatus === 409 || httpStatus === 429 || httpStatus === 503)) return 'unknown';
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

/** A reload of the session: landed, failed, or gone (the server says the session no longer exists). */
export type SaveReload = 'loaded' | 'failed' | 'gone';

/**
 * Sends a save until an answer settles whether it was stored, then reloads the session:
 * - an unknown outcome is sent again (same request, same save key) after `wait(attempt)` and
 *   `online()`, up to SAVE_ATTEMPTS sends;
 * - a stored save reloads until a reload lands, the session is gone, or SAVE_ATTEMPTS reloads
 *   failed, so its changes stay in the save in flight rather than showing as unsaved changes the
 *   server already has; any other outcome reloads once.
 * Stops at its next step, without reloading, once `going()` is false (the page closed, its
 * unsaved changes were discarded, or the person was removed). Returns the last attempt.
 */
export async function settleSave<Attempt extends { outcome: SaveOutcome }>(io: {
  send: (retry: boolean) => Promise<Attempt>;
  reload: () => Promise<SaveReload>;
  wait: (attempt: number) => Promise<void>;
  online: () => Promise<void>;
  going: () => boolean;
}): Promise<{ attempt: Attempt; reloaded: boolean }> {
  let attempt = await io.send(false);
  for (let sent = 1; attempt.outcome === 'unknown' && sent < SAVE_ATTEMPTS && io.going(); sent++) {
    await io.wait(sent - 1);
    await io.online();
    if (!io.going()) break;
    attempt = await io.send(true);
  }
  if (!io.going()) return { attempt, reloaded: false };

  let reload = await io.reload();
  for (
    let tries = 1;
    reload === 'failed' && attempt.outcome === 'saved' && tries < SAVE_ATTEMPTS && io.going();
    tries++
  ) {
    await io.wait(tries - 1);
    if (!io.going()) break;
    reload = await io.reload();
  }
  return { attempt, reloaded: reload === 'loaded' };
}
