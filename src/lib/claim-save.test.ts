import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SaveOutcome } from './claim-drafts';
import { SAVE_ATTEMPTS, abortAfter, failedSaveOutcome, saveRetryDelay, settleSave, sleep } from './claim-save';
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
 * script is unknown, a reload past it fails), every call is logged, and the page stops saving
 * right after the first call logged as `stopAt`.
 */
function script({ sends, reloads = [], stopAt }: { sends: SaveOutcome[]; reloads?: Reload[]; stopAt?: string }) {
  const log: string[] = [];
  let stopped = false;
  const record = (entry: string) => {
    log.push(entry);
    if (entry === stopAt) stopped = true;
  };
  return {
    log,
    io: {
      send: async (retry: boolean) => {
        record(retry ? 'retry' : 'send');
        return { outcome: sends.shift() ?? ('unknown' as const), sent: log.length };
      },
      reload: async () => {
        record('reload');
        return reloads.shift() ?? 'failed';
      },
      wait: async (attempt: number) => {
        record(`wait ${attempt}`);
      },
      going: () => !stopped,
    },
  };
}

const loaded = (n: number): Reload[] => Array.from({ length: n }, () => 'loaded');
const failed = (n: number): Reload[] => Array.from({ length: n }, () => 'failed');

describe('settleSave (#238)', () => {
  test('a save answered at once: reloaded once, and the answer returned', async () => {
    const { log, io } = script({ sends: ['saved'], reloads: ['loaded'] });
    expect(await settleSave(io)).toEqual({ attempt: { outcome: 'saved', sent: 1 }, reloaded: true });
    expect(log).toEqual(['send', 'reload']);
  });

  test('sends again, after a backoff, only once the server answers a reload', async () => {
    const { log, io } = script({ sends: ['unknown', 'saved'], reloads: ['failed', 'failed', 'loaded', 'loaded'] });
    const settled = await settleSave(io);
    expect(settled).toMatchObject({ attempt: { outcome: 'saved' }, reloaded: true });
    expect(log).toEqual([
      'send',
      'wait 0',
      'reload',
      `wait ${SAVE_ATTEMPTS}`,
      'reload',
      `wait ${SAVE_ATTEMPTS}`,
      'reload',
      'retry',
      'reload',
    ]);
  });

  test("an outage doesn't use up attempts, however long it lasts", async () => {
    const { log, io } = script({ sends: ['unknown', 'saved'], reloads: [...failed(50), ...loaded(2)] });
    expect((await settleSave(io)).attempt.outcome).toBe('saved');
    expect(log.filter((entry) => entry === 'send' || entry === 'retry')).toEqual(['send', 'retry']);
  });

  test('waits for the backoff before checking the server and sending again', async () => {
    const log: string[] = [];
    let release = () => {};
    const settled = settleSave({
      send: async (retry: boolean) => {
        log.push(retry ? 'retry' : 'send');
        return { outcome: retry ? ('saved' as const) : ('unknown' as const) };
      },
      reload: async () => {
        log.push('reload');
        return 'loaded' as const;
      },
      wait: () => new Promise<void>((resolve) => (release = resolve)),
      going: () => true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(['send']);
    release();
    expect((await settled).attempt.outcome).toBe('saved');
    expect(log).toEqual(['send', 'reload', 'retry', 'reload']);
  });

  test('a retry refused for good ends it as refused, reloaded once', async () => {
    const { log, io } = script({ sends: ['unknown', 'refused'], reloads: ['loaded', 'failed'] });
    expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'refused' }, reloaded: false });
    expect(log).toEqual(['send', 'wait 0', 'reload', 'retry', 'reload']);
  });

  test('a session gone before sending again: sends it once more, to be refused', async () => {
    const { log, io } = script({ sends: ['unknown', 'refused'], reloads: ['gone', 'gone'] });
    expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'refused' }, reloaded: false });
    expect(log).toEqual(['send', 'wait 0', 'reload', 'retry', 'reload']);
  });

  test(`gives up after ${SAVE_ATTEMPTS} sends while reloads land, still unknown, and reloads once more`, async () => {
    const { log, io } = script({ sends: [], reloads: loaded(SAVE_ATTEMPTS) });
    expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'unknown' }, reloaded: true });
    expect(log.filter((entry) => entry === 'send' || entry === 'retry')).toHaveLength(SAVE_ATTEMPTS);
    expect(log.filter((entry) => entry.startsWith('wait'))).toEqual(
      Array.from({ length: SAVE_ATTEMPTS - 1 }, (_, attempt) => `wait ${attempt}`),
    );
    expect(log.filter((entry) => entry === 'reload')).toHaveLength(SAVE_ATTEMPTS);
    expect(log.at(-1)).toBe('reload');
  });

  test('a stored save reloads until a reload lands', async () => {
    const { log, io } = script({ sends: ['saved'], reloads: ['failed', 'failed', 'loaded'] });
    expect((await settleSave(io)).reloaded).toBe(true);
    expect(log).toEqual(['send', 'reload', 'wait 0', 'reload', 'wait 1', 'reload']);
  });

  test(`a stored save stops reloading after ${SAVE_ATTEMPTS} reloads that failed`, async () => {
    const { log, io } = script({ sends: ['saved'] });
    expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'saved' }, reloaded: false });
    expect(log.filter((entry) => entry === 'reload')).toHaveLength(SAVE_ATTEMPTS);
  });

  test('a stored save stops reloading once the session is gone', async () => {
    const { log, io } = script({ sends: ['saved'], reloads: ['gone'] });
    expect((await settleSave(io)).reloaded).toBe(false);
    expect(log).toEqual(['send', 'reload']);
  });

  describe('stops at its next step once the page stops saving (closed, edits discarded, person removed)', () => {
    test('after an unanswered send', async () => {
      const { log, io } = script({ sends: ['unknown'], stopAt: 'send' });
      expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'unknown' }, reloaded: false });
      expect(log).toEqual(['send']);
    });

    test('during the backoff', async () => {
      const { log, io } = script({ sends: ['unknown', 'saved'], stopAt: 'wait 0' });
      expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'unknown' }, reloaded: false });
      expect(log).toEqual(['send', 'wait 0']);
    });

    test('while waiting for the server', async () => {
      const { log, io } = script({ sends: ['unknown', 'saved'], reloads: ['failed', 'loaded'], stopAt: 'reload' });
      expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'unknown' }, reloaded: false });
      expect(log).toEqual(['send', 'wait 0', 'reload']);
    });

    test('after a stored answer, before reloading', async () => {
      const { log, io } = script({ sends: ['saved'], stopAt: 'send' });
      expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'saved' }, reloaded: false });
      expect(log).toEqual(['send']);
    });

    test('after a failed reload of a stored save', async () => {
      const { log, io } = script({ sends: ['saved'], reloads: ['failed', 'loaded'], stopAt: 'reload' });
      expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'saved' }, reloaded: false });
      expect(log).toEqual(['send', 'reload']);
    });

    test('during the wait between reloads of a stored save', async () => {
      const { log, io } = script({ sends: ['saved'], reloads: ['failed', 'loaded'], stopAt: 'wait 0' });
      expect(await settleSave(io)).toMatchObject({ attempt: { outcome: 'saved' }, reloaded: false });
      expect(log).toEqual(['send', 'reload', 'wait 0']);
    });
  });
});

describe('sleep and abortAfter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('sleep resolves after the time, or as soon as the signal aborts (at once if it already has)', async () => {
    const done = vi.fn();
    void sleep(1000, new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();

    const stop = new AbortController();
    const early = vi.fn();
    void sleep(60_000, stop.signal).then(early);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(early).toHaveBeenCalled();

    const already = vi.fn();
    void sleep(60_000, stop.signal).then(already);
    await vi.advanceTimersByTimeAsync(0);
    expect(already).toHaveBeenCalled();
  });

  test('abortAfter aborts after the time, or when the signal aborts; release stops it', () => {
    const timed = abortAfter(1000, new AbortController().signal);
    vi.advanceTimersByTime(1000);
    expect(timed.signal.aborted).toBe(true);

    const stop = new AbortController();
    const stopped = abortAfter(60_000, stop.signal);
    stop.abort();
    expect(stopped.signal.aborted).toBe(true);
    expect(abortAfter(60_000, stop.signal).signal.aborted).toBe(true);

    const released = abortAfter(1000, new AbortController().signal);
    released.release();
    vi.advanceTimersByTime(1000);
    expect(released.signal.aborted).toBe(false);
  });
});
