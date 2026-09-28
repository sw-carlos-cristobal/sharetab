import { describe, expect, test } from 'vitest';
import type { SaveOutcome } from './claim-drafts';
import { SAVE_ATTEMPTS, failedSaveOutcome, saveRetryDelay, settleSave } from './claim-save';
import { CLAIM_POLL_RETRY_MS } from './guest-session';

describe('failedSaveOutcome (#238)', () => {
  test('no answer from the server: the save may have been stored', () => {
    expect(failedSaveOutcome(undefined, false)).toBe('unknown');
    expect(failedSaveOutcome(undefined, true)).toBe('unknown');
  });

  test('an internal server error may come after the save was stored (e.g. the connection dropped at commit)', () => {
    for (const status of [500, 502, 504]) {
      expect(failedSaveOutcome(status, false)).toBe('unknown');
      expect(failedSaveOutcome(status, true)).toBe('unknown');
    }
  });

  test('a first attempt refused (a client error, or busy: 503 rolls back) stored nothing', () => {
    for (const status of [400, 403, 404, 409, 429, 503]) {
      expect(failedSaveOutcome(status, false)).toBe('refused');
    }
  });

  test('a retry that was rate limited, busy, or answered 409 stored nothing itself: still unknown', () => {
    for (const status of [409, 429, 503]) {
      expect(failedSaveOutcome(status, true)).toBe('unknown');
    }
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

/**
 * A scripted save: each send and reload answers the next scripted result (a send past the
 * script is unknown, a reload past it fails), every call is logged, and the page stays saving
 * for the first `goingFor` checks.
 */
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
  let checks = 0;
  return {
    log,
    io: {
      send: async (retry: boolean) => {
        log.push(retry ? 'retry' : 'send');
        return { outcome: sends.shift() ?? ('unknown' as const), attempt: log.length };
      },
      reload: async () => {
        log.push('reload');
        return reloads.shift() ?? 'failed';
      },
      wait: async (attempt: number) => {
        log.push(`wait ${attempt}`);
      },
      online: async () => {
        log.push('online');
      },
      going: () => checks++ < goingFor,
    },
  };
}

describe('settleSave (#238)', () => {
  test('a save answered at once: reloaded once, and the answer returned', async () => {
    const { log, io } = script({ sends: ['saved'] });
    expect(await settleSave(io)).toEqual({ attempt: { outcome: 'saved', attempt: 1 }, reloaded: true });
    expect(log).toEqual(['send', 'reload']);
  });

  test('sends again once online, waiting longer each time, until an answer says it was stored', async () => {
    const { log, io } = script({ sends: ['unknown', 'unknown', 'saved'] });
    const settled = await settleSave(io);
    expect(settled.attempt.outcome).toBe('saved');
    expect(settled.reloaded).toBe(true);
    expect(log).toEqual(['send', 'wait 0', 'online', 'retry', 'wait 1', 'online', 'retry', 'reload']);
  });

  test('a retry refused for good ends it as refused, reloaded once', async () => {
    const { log, io } = script({ sends: ['unknown', 'refused'], reloads: ['failed'] });
    const settled = await settleSave(io);
    expect(settled.attempt.outcome).toBe('refused');
    expect(settled.reloaded).toBe(false);
    expect(log).toEqual(['send', 'wait 0', 'online', 'retry', 'reload']);
  });

  test(`gives up after ${SAVE_ATTEMPTS} sends, still unknown, and reloads once`, async () => {
    const { log, io } = script({ sends: [], reloads: ['failed'] });
    const settled = await settleSave(io);
    expect(settled.attempt.outcome).toBe('unknown');
    expect(settled.reloaded).toBe(false);
    expect(log.filter((entry) => entry === 'send' || entry === 'retry')).toHaveLength(SAVE_ATTEMPTS);
    expect(log.filter((entry) => entry.startsWith('wait'))).toEqual(
      Array.from({ length: SAVE_ATTEMPTS - 1 }, (_, attempt) => `wait ${attempt}`),
    );
    expect(log.filter((entry) => entry === 'reload')).toHaveLength(1);
  });

  test('a stored save reloads until a reload lands', async () => {
    const { log, io } = script({ sends: ['saved'], reloads: ['failed', 'failed', 'loaded'] });
    expect((await settleSave(io)).reloaded).toBe(true);
    expect(log).toEqual(['send', 'reload', 'wait 0', 'reload', 'wait 1', 'reload']);
  });

  test(`a stored save stops reloading after ${SAVE_ATTEMPTS} reloads that failed`, async () => {
    const { log, io } = script({ sends: ['saved'], reloads: [] });
    const settled = await settleSave(io);
    expect(settled).toMatchObject({ attempt: { outcome: 'saved' }, reloaded: false });
    expect(log.filter((entry) => entry === 'reload')).toHaveLength(SAVE_ATTEMPTS);
  });

  test('a stored save stops reloading once the session is gone', async () => {
    const { log, io } = script({ sends: ['saved'], reloads: ['gone'] });
    expect((await settleSave(io)).reloaded).toBe(false);
    expect(log).toEqual(['send', 'reload']);
  });

  describe('stops as soon as the page stops saving (closed, edits discarded, person removed)', () => {
    test('before sending again', async () => {
      const { log, io } = script({ sends: ['unknown'], goingFor: 0 });
      expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'unknown' }, reloaded: false });
      expect(log).toEqual(['send']);
    });

    test('during the wait before sending again', async () => {
      const { log, io } = script({ sends: ['unknown', 'saved'], goingFor: 1 });
      expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'unknown' }, reloaded: false });
      expect(log).toEqual(['send', 'wait 0', 'online']);
    });

    test('after a stored answer, before reloading', async () => {
      const { log, io } = script({ sends: ['saved'], goingFor: 0 });
      expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'saved' }, reloaded: false });
      expect(log).toEqual(['send']);
    });

    test('while a stored save keeps reloading', async () => {
      const { log, io } = script({ sends: ['saved'], reloads: ['failed', 'loaded'], goingFor: 2 });
      expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'saved' }, reloaded: false });
      expect(log).toEqual(['send', 'reload', 'wait 0']);
    });
  });
});
