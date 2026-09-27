import { describe, test, expect, vi, beforeEach } from 'vitest';

// rate-limit.ts starts a cleanup setInterval at load time, so fake timers go first
vi.useFakeTimers();

const { checkClaimWriteRateLimit, checkSessionReadRateLimit } = await import('./guest-session-limits');

let tokenSeq = 0;
function newToken() {
  tokenSeq += 1;
  return `token-${tokenSeq}`;
}

function personToken(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const people = (count: number) => Array.from({ length: count }, (_, i) => personToken(i));

function saveMany(token: string, personTokens: string[]) {
  return personTokens.map((pt) => checkClaimWriteRateLimit('claim', token, pt));
}

function readMany(token: string, count: number) {
  return Array.from({ length: count }, () => checkSessionReadRateLimit(token));
}

beforeEach(() => {
  // Expire every window left over from the previous test
  vi.advanceTimersByTime(24 * 60 * 60 * 1000);
});

describe('checkClaimWriteRateLimit', () => {
  test('lets eleven people save claims in the same minute (#204)', () => {
    const token = newToken();
    expect(saveMany(token, people(11)).every(Boolean)).toBe(true);
  });

  test('lets a 100-person group each save three times in the same minute', () => {
    const token = newToken();
    const everyone = people(100);
    expect(saveMany(token, [...everyone, ...everyone, ...everyone]).every(Boolean)).toBe(true);
  });

  test('lets one person save 30 times a minute, then refuses them', () => {
    const token = newToken();
    const results = saveMany(token, Array(31).fill(personToken(1)));
    expect(results.slice(0, 30)).toEqual(Array(30).fill(true));
    expect(results[30]).toBe(false);
  });

  test('lets the person save again once the minute is over', () => {
    const token = newToken();
    saveMany(token, Array(30).fill(personToken(1)));
    expect(checkClaimWriteRateLimit('claim', token, personToken(1))).toBe(false);

    vi.advanceTimersByTime(60 * 1000 + 1);
    expect(checkClaimWriteRateLimit('claim', token, personToken(1))).toBe(true);
  });

  test('caps the whole session at 300 saves a minute', () => {
    const token = newToken();
    const everyone = people(100);
    saveMany(token, [...everyone, ...everyone, ...everyone]);
    expect(checkClaimWriteRateLimit('claim', token, personToken(100))).toBe(false);
  });

  test("a client looping on one person does not use up the session's budget", () => {
    const token = newToken();
    const looped = saveMany(token, Array(1000).fill(personToken(1)));
    expect(looped.filter(Boolean)).toHaveLength(30);

    expect(
      saveMany(
        token,
        people(270).map((_, i) => personToken(i + 2)),
      ).every(Boolean),
    ).toBe(true);
    expect(checkClaimWriteRateLimit('claim', token, personToken(999))).toBe(false);
  });

  test("a refusal because the session is full does not use up the person's own budget", () => {
    const token = newToken();
    saveMany(
      token,
      people(300).map((_, i) => personToken(i % 100)),
    );

    // Half a minute later the session is still full, so this person keeps getting refused
    vi.advanceTimersByTime(30 * 1000);
    expect(saveMany(token, Array(40).fill(personToken(500))).some(Boolean)).toBe(false);

    // The session window opened 60s ago and has reset; the refusals must not have counted
    vi.advanceTimersByTime(30 * 1000 + 1);
    expect(checkClaimWriteRateLimit('claim', token, personToken(500))).toBe(true);
  });

  test('gives each kind of change its own budget', () => {
    const token = newToken();
    saveMany(token, Array(30).fill(personToken(1)));
    expect(checkClaimWriteRateLimit('claim', token, personToken(1))).toBe(false);

    expect(checkClaimWriteRateLimit('edit-name', token, personToken(1))).toBe(true);
    expect(checkClaimWriteRateLimit('remove-person', token, personToken(1))).toBe(true);
    expect(checkClaimWriteRateLimit('split-item', token, personToken(1))).toBe(true);
  });

  test('gives each session its own budget', () => {
    const busy = newToken();
    const quiet = newToken();
    const everyone = people(100);
    saveMany(busy, [...everyone, ...everyone, ...everyone]);

    expect(checkClaimWriteRateLimit('claim', busy, personToken(1))).toBe(false);
    expect(checkClaimWriteRateLimit('claim', quiet, personToken(1))).toBe(true);
  });

  test('keeps person budgets separate when a share token contains the key separator', () => {
    const token = newToken();
    saveMany(`${token}:x`, Array(30).fill(personToken(1)));
    expect(checkClaimWriteRateLimit('claim', `${token}:x`, personToken(1))).toBe(false);
    expect(checkClaimWriteRateLimit('claim', token, `x:${personToken(1)}`)).toBe(true);
  });
});

describe('checkSessionReadRateLimit', () => {
  test('lets 100 open claim pages poll every 3 seconds for a minute', () => {
    const token = newToken();
    expect(readMany(token, 100 * 20).every(Boolean)).toBe(true);
  });

  test('caps the session at 3000 reads a minute', () => {
    const token = newToken();
    expect(readMany(token, 3000).every(Boolean)).toBe(true);
    expect(checkSessionReadRateLimit(token)).toBe(false);
  });

  test('allows reads again once the minute is over', () => {
    const token = newToken();
    readMany(token, 3000);
    vi.advanceTimersByTime(60 * 1000 + 1);
    expect(checkSessionReadRateLimit(token)).toBe(true);
  });

  test('gives each session its own budget', () => {
    const busy = newToken();
    readMany(busy, 3000);
    expect(checkSessionReadRateLimit(newToken())).toBe(true);
  });
});
