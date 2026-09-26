import { describe, test, expect, vi, beforeEach } from 'vitest';

// rate-limit.ts starts a cleanup setInterval at load time, so fake timers go first
vi.useFakeTimers();

const { checkJoinRateLimit } = await import('./guest-join-limit');

let tokenSeq = 0;
function newToken() {
  tokenSeq += 1;
  return `token-${tokenSeq}`;
}

function joinMany(token: string, names: string[]) {
  return names.map((name) => checkJoinRateLimit(token, name));
}

beforeEach(() => {
  // Expire every window left over from the previous test
  vi.advanceTimersByTime(24 * 60 * 60 * 1000);
});

describe('checkJoinRateLimit', () => {
  test('lets one person rejoin 10 times a minute, then refuses them', () => {
    const token = newToken();
    const results = joinMany(token, Array(11).fill('Alice'));
    expect(results.slice(0, 10)).toEqual(Array(10).fill(true));
    expect(results[10]).toBe(false);
  });

  test('lets the person back in once the minute is over', () => {
    const token = newToken();
    joinMany(token, Array(10).fill('Alice'));
    expect(checkJoinRateLimit(token, 'Alice')).toBe(false);

    vi.advanceTimersByTime(60 * 1000 + 1);
    expect(checkJoinRateLimit(token, 'Alice')).toBe(true);
  });

  test('matches the person by name the way joinSession does, ignoring case and outer spaces', () => {
    const token = newToken();
    joinMany(token, ['Alice', 'alice', ' ALICE ', 'Alice', 'alice', 'Alice', 'Alice', 'Alice', 'Alice', 'Alice']);
    expect(checkJoinRateLimit(token, 'aLiCe  ')).toBe(false);
  });

  test('lets a 100-person group each join twice in the same minute', () => {
    const token = newToken();
    const names = Array.from({ length: 100 }, (_, i) => `Person ${i}`);
    const results = joinMany(token, [...names, ...names]);
    expect(results.every(Boolean)).toBe(true);
  });

  test('caps the whole session at 200 joins a minute', () => {
    const token = newToken();
    const names = Array.from({ length: 200 }, (_, i) => `Person ${i}`);
    expect(joinMany(token, names).every(Boolean)).toBe(true);
    expect(checkJoinRateLimit(token, 'Latecomer')).toBe(false);
  });

  test("a client looping on one name does not use up the session's budget", () => {
    const token = newToken();
    const looped = joinMany(token, Array(1000).fill('Alice'));
    expect(looped.filter(Boolean)).toHaveLength(10);

    const others = Array.from({ length: 190 }, (_, i) => `Person ${i}`);
    expect(joinMany(token, others).every(Boolean)).toBe(true);
    expect(checkJoinRateLimit(token, 'Latecomer')).toBe(false);
  });

  test("a refusal because the session is full does not use up the person's own budget", () => {
    const token = newToken();
    joinMany(
      token,
      Array.from({ length: 200 }, (_, i) => `Person ${i}`),
    );

    // Half a minute later the session is still full, so Bob keeps getting refused
    vi.advanceTimersByTime(30 * 1000);
    expect(joinMany(token, Array(15).fill('Bob')).some(Boolean)).toBe(false);

    // The session window opened 60s ago and has reset; Bob's refusals must not have counted
    vi.advanceTimersByTime(30 * 1000 + 1);
    expect(checkJoinRateLimit(token, 'Bob')).toBe(true);
  });

  test('gives each session its own budget', () => {
    const busy = newToken();
    const quiet = newToken();
    joinMany(
      busy,
      Array.from({ length: 200 }, (_, i) => `Person ${i}`),
    );
    joinMany(busy, Array(10).fill('Alice'));

    expect(checkJoinRateLimit(busy, 'Alice')).toBe(false);
    expect(checkJoinRateLimit(quiet, 'Alice')).toBe(true);
  });

  test('a device presenting its token is budgeted by that token, whatever name it types', () => {
    const token = newToken();
    const alicesToken = '11111111-1111-4111-8111-111111111111';
    const typed = Array.from({ length: 11 }, (_, i) => `name ${i}`);
    const results = typed.map((name) => checkJoinRateLimit(token, name, alicesToken));
    expect(results.slice(0, 10)).toEqual(Array(10).fill(true));
    expect(results[10]).toBe(false);
  });

  test("joins without Alice's token under her name don't use up her own device's budget", () => {
    const token = newToken();
    const alicesToken = '11111111-1111-4111-8111-111111111111';
    // Someone with only the share link keeps trying "Alice" (each is refused by joinSession)
    joinMany(token, Array(15).fill('Alice'));
    expect(checkJoinRateLimit(token, 'Alice')).toBe(false);
    // Alice's own device sends her stored token, so it still gets in
    expect(checkJoinRateLimit(token, 'Alice', alicesToken)).toBe(true);
  });

  test('keeps person budgets separate when a token or name contains the key separator', () => {
    const token = newToken();
    joinMany(`${token}:alice`, Array(10).fill('x'));
    expect(checkJoinRateLimit(`${token}:alice`, 'x')).toBe(false);
    expect(checkJoinRateLimit(token, 'alice:x')).toBe(true);
  });
});
