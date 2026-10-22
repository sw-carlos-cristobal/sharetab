import type { ClaimEdits, SaveOutcome } from './claim-drafts';
import { CLAIM_POLL_RETRY_MS } from './guest-session';

/**
 * How many times the claim page sends one save (with the same save key) before it stops waiting
 * to learn whether it was stored, and how many times it reloads after a stored save before it
 * stops waiting for a reload to land. A save is sent again only once the server answers a reload
 * of the session, so an outage, however long, doesn't use up attempts: they run out only while
 * reads work and this save still gets no settled answer (the backoff between them adds up to 45
 * to 90 seconds, plus up to SAVE_ATTEMPT_TIMEOUT_MS for each attempt that hangs). Past that, the
 * page parks the save (ParkedSave).
 */
export const SAVE_ATTEMPTS = 10;

/**
 * How long the claim page waits for the answer to one save attempt, or one reload, before giving
 * up on it. Aborting a save attempt works because guest.claimItems has its own non-batched link
 * (src/components/providers.tsx).
 */
export const SAVE_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * How a save attempt that failed ended, from the HTTP status of the server's error answer
 * (undefined when no answer came, e.g. a dropped connection or a proxy's error page).
 * `retry`: the attempt sent a save again, with the same save key, after an earlier attempt of it
 * got no settled answer; the server answers a retry of a stored save as stored (#238).
 * - No answer, or a server error other than 503: unknown. The error can come after the save was
 *   stored (e.g. the connection dropped at commit), and sending it again is safe.
 * - A first attempt refused with any other status stored nothing: a client error, 409 (the
 *   person is no longer in the split, or the transaction's retries ran out), 429 (rate limited)
 *   or 503 (a transaction manager error, P2028: the transaction didn't start or was rolled back;
 *   #203 doesn't retry it).
 * - A retry answered 409, 429 or 503 stored nothing itself, but an earlier attempt may have:
 *   unknown. (A 409 can also mean the person was removed; the save then stops at its next step
 *   after a poll no longer lists them.)
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
 * - an unknown outcome is sent again (same request, same save key) after `wait(attempt)`, once
 *   the server answers a reload (a failed reload waits `wait(SAVE_ATTEMPTS)`, the longest
 *   backoff, and tries again), up to SAVE_ATTEMPTS sends;
 * - a stored save reloads until a reload lands, the session is gone, or SAVE_ATTEMPTS reloads
 *   failed, so its changes stay in the save in flight rather than showing as unsaved changes the
 *   server already has; any other outcome reloads once.
 * Stops at its next step, without reloading further, once `going()` is false (the page closed,
 * its unsaved changes were discarded, or the person was removed). Returns the last attempt.
 */
export async function settleSave<Attempt extends { outcome: SaveOutcome }>(io: {
  send: (retry: boolean) => Promise<Attempt>;
  reload: () => Promise<SaveReload>;
  wait: (attempt: number) => Promise<void>;
  going: () => boolean;
}): Promise<{ attempt: Attempt; reloaded: boolean }> {
  // Whether to send again: once a reload is answered (landed, or the session is gone, which the
  // send will then be refused for), unless the page stopped saving meanwhile
  const reachable = async () => {
    if (!io.going()) return false;
    while ((await io.reload()) === 'failed') {
      if (!io.going()) return false;
      await io.wait(SAVE_ATTEMPTS);
      if (!io.going()) return false;
    }
    return io.going();
  };

  let attempt = await io.send(false);
  for (let sent = 1; attempt.outcome === 'unknown' && sent < SAVE_ATTEMPTS && io.going(); sent++) {
    await io.wait(sent - 1);
    if (!(await reachable())) break;
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

/**
 * A save the claim page gave up on (#241): sent SAVE_ATTEMPTS times without an answer that says
 * whether it was stored. The page keeps its request, save key included, and its changes stay
 * shown under the person's unsaved changes (pendingEdits). The page's next Save, for anyone,
 * sends it again before anything newer (saveInOrder): the server answers it as stored if an
 * attempt stored it, without applying it again over what other devices saved since, and
 * otherwise stores it then. Before anything newer for anyone, because the server keeps only the
 * last few save keys of the person saving, whoever the saves are for.
 */
export type ParkedSave<Request> = { request: Request; sent: ClaimEdits };

/**
 * Sends saves one after another, each until it's settled (`settle`, which is settleSave): the
 * saves the page parked first, then the person's changes. The next one is sent only once the one
 * before it was stored, while the page is still saving: a parked save still unsettled must not
 * be sent after newer changes, since if it was never stored the server would apply it then, over
 * them. Returns the last save settled, and the ones not sent.
 */
export async function saveInOrder<Stage, Attempt extends { outcome: SaveOutcome }>(
  stages: readonly [Stage, ...Stage[]],
  settle: (stage: Stage) => Promise<{ attempt: Attempt; reloaded: boolean }>,
  going: () => boolean,
): Promise<{ stage: Stage; attempt: Attempt; reloaded: boolean; unsent: Stage[] }> {
  const [first, ...rest] = stages;
  let stage = first;
  for (;;) {
    const { attempt, reloaded } = await settle(stage);
    const next = rest.shift();
    if (next === undefined || attempt.outcome !== 'saved' || !going()) {
      return { stage, attempt, reloaded, unsent: next === undefined ? [] : [next, ...rest] };
    }
    stage = next;
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts (at once if it already has). */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
    if (signal.aborted) done();
  });
}

/** A signal that aborts after `ms`, or as soon as `signal` does; `release` when done with it. */
export function abortAfter(ms: number, signal: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, ms);
  signal.addEventListener('abort', abort);
  if (signal.aborted) abort();
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    },
  };
}
