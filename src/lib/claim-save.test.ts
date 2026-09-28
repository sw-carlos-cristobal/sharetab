import { describe, expect, test } from 'vitest';
import type { SaveOutcome } from './claim-drafts';
import { SAVE_ATTEMPTS, failedSaveOutcome, saveRetryDelay, settleSave } from './claim-save';
import { CLAIM_POLL_RETRY_MS } from './guest-session';

describe('failedSaveOutcome (#238)', () => {
  test('no answer from the server: the save may have been stored', () => {
    expect(failedSaveOutcome(undefined, false)).toBe('unknown');
    expect(failedSaveOutcome(undefined, true)).toBe('unknown');
  });

  test('a server error may come after the save was stored (e.g. the connection dropped at commit)', () => {
    for (const status of [500, 502, 503]) {
      expect(failedSaveOutcome(status, false)).toBe('unknown');
      expect(failedSaveOutcome(status, true)).toBe('unknown');
    }
  });

  test('a first attempt refused with a client error stored nothing', () => {
    for (const status of [400, 403, 404, 409, 429]) {
      expect(failedSaveOutcome(status, false)).toBe('refused');
    }
  });

  test('a retry that was rate limited, or lost to other writes (409), stored nothing itself: still unknown', () => {
    expect(failedSaveOutcome(429, true)).toBe('unknown');
    expect(failedSaveOutcome(409, true)).toBe('unknown');
  });

  test('a retry refused for good (finalized, caller removed, session gone): refused', () => {
    for (const status of [400, 403, 404]) {
      expect(failedSaveOutcome(status, true)).toBe('refused');
    }
  });
});

describe('saveRetryDelay (#238)', () => {
  test('doubles from a second up to the poll retry interval, jittered into its upper half', () => {
    const ceilings = [1000, 2000, 4000, 8000, CLAIM_POLL_RETRY_MS, CLAIM_POLL_RETRY_MS];
    ceilings.forEach((ceiling, attempt) => {
      expect(saveRetryDelay(attempt, () => 0)).toBe(ceiling / 2);
      expect(saveRetryDelay(attempt, () => 0.999999)).toBeCloseTo(ceiling, -1);
    });
    expect(saveRetryDelay(20, () => 0.5)).toBe(CLAIM_POLL_RETRY_MS * 0.75);
  });
});

type Reload = 'loaded' | 'failed' | 'gone';

/** A scripted save: each send and reload answers the next scripted result, and every call is logged. */
function script({
  sends,
  reloads = ['loaded'],
  goingFor = Infinity,
}: {
  sends: SaveOutcome[];
  reloads?: Reload[];
  goingFor?: number;
}) {
  const log: string[] = [];
  let calls = 0;
  return {
    log,
    steps: {
      send: async (retry: boolean) => {
        log.push(retry ? 'retry' : 'send');
        return sends.shift() ?? 'unknown';
      },
      reload: async () => {
        log.push('reload');
        return reloads.shift() ?? 'failed';
      },
      wait: async (ms: number) => {
        log.push(`wait ${ms}`);
      },
      // Still saving for the first `goingFor` checks
      going: () => calls++ < goingFor,
      delay: (attempt: number) => attempt,
    },
  };
}

describe('settleSave (#238)', () => {
  test('a save answered at once: reloaded once', async () => {
    const { log, steps } = script({ sends: ['saved'] });
    expect(await settleSave(steps)).toEqual({ outcome: 'saved', reloaded: true });
    expect(log).toEqual(['send', 'reload']);
  });

  test('sends again, waiting longer each time, until an answer says it was stored', async () => {
    const { log, steps } = script({ sends: ['unknown', 'unknown', 'saved'] });
    expect(await settleSave(steps)).toEqual({ outcome: 'saved', reloaded: true });
    expect(log).toEqual(['send', 'wait 0', 'retry', 'wait 1', 'retry', 'reload']);
  });

  test('a retry refused for good ends it as refused', async () => {
    const { log, steps } = script({ sends: ['unknown', 'refused'] });
    expect(await settleSave(steps)).toEqual({ outcome: 'refused', reloaded: true });
    expect(log).toEqual(['send', 'wait 0', 'retry', 'reload']);
  });

  test(`gives up after ${SAVE_ATTEMPTS} attempts, still unknown, and reloads once`, async () => {
    const { log, steps } = script({ sends: [] });
    expect(await settleSave(steps)).toEqual({ outcome: 'unknown', reloaded: true });
    expect(log.filter((entry) => entry === 'send' || entry === 'retry')).toHaveLength(SAVE_ATTEMPTS);
    expect(log.at(-1)).toBe('reload');
  });

  test('stops as soon as the page stops saving (closed, or its edits discarded), without reloading', async () => {
    // Still saving for the checks before the first wait, not after it
    const { log, steps } = script({ sends: ['unknown', 'saved'], goingFor: 1 });
    expect(await settleSave(steps)).toEqual({ outcome: 'unknown', reloaded: false });
    expect(log).toEqual(['send', 'wait 0']);
  });

  test('a stored save reloads until a reload lands', async () => {
    const { log, steps } = script({ sends: ['saved'], reloads: ['failed', 'failed', 'loaded'] });
    expect(await settleSave(steps)).toEqual({ outcome: 'saved', reloaded: true });
    expect(log).toEqual(['send', 'reload', 'wait 0', 'reload', 'wait 1', 'reload']);
  });

  test('a stored save stops reloading once the session is gone', async () => {
    const { log, steps } = script({ sends: ['saved'], reloads: ['gone'] });
    expect(await settleSave(steps)).toEqual({ outcome: 'saved', reloaded: false });
    expect(log).toEqual(['send', 'reload']);
  });

  test('a refused save reloads once: nothing was stored, so its changes can wait for the next poll', async () => {
    const { log, steps } = script({ sends: ['refused'], reloads: ['failed'] });
    expect(await settleSave(steps)).toEqual({ outcome: 'refused', reloaded: false });
    expect(log).toEqual(['send', 'reload']);
  });
});
