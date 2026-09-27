import { describe, expect, test } from 'vitest';
import {
  isGuestSessionToken,
  joinKeyFor,
  needsMembershipCheck,
  newJoinKey,
  personalLinkHash,
  readPersonalLinkToken,
  resumeOutcome,
  shouldRetryResume,
} from './guest-session';

const TOKEN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('personal link fragment', () => {
  test('round-trips a person token', () => {
    expect(personalLinkHash(TOKEN)).toBe(`#me=${TOKEN}`);
    expect(readPersonalLinkToken(personalLinkHash(TOKEN))).toBe(TOKEN);
  });

  test('reads the token with or without the leading #, next to other parameters', () => {
    expect(readPersonalLinkToken(`me=${TOKEN}`)).toBe(TOKEN);
    expect(readPersonalLinkToken(`#foo=1&me=${TOKEN}`)).toBe(TOKEN);
  });

  test('ignores a missing or malformed token', () => {
    expect(readPersonalLinkToken('')).toBeNull();
    expect(readPersonalLinkToken('#section')).toBeNull();
    expect(readPersonalLinkToken('#me=')).toBeNull();
    expect(readPersonalLinkToken('#me=not-a-token')).toBeNull();
  });
});

describe('newJoinKey', () => {
  test('makes a lowercase version 4 UUID that the server accepts', () => {
    const key = newJoinKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isGuestSessionToken(key)).toBe(true);
  });

  test('makes a different key each time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newJoinKey()));
    expect(keys.size).toBe(50);
  });
});

describe('joinKeyFor', () => {
  const makeKey = () => OTHER;

  test('reuses the pending join key when retrying the same name, however it is typed', () => {
    expect(joinKeyFor(' Bob ', { joinKey: TOKEN, name: 'bob' }, makeKey)).toEqual({ joinKey: TOKEN, name: 'bob' });
  });

  test('makes a new join key for a different name, or when nothing is pending', () => {
    expect(joinKeyFor('Carol', { joinKey: TOKEN, name: 'bob' }, makeKey)).toEqual({ joinKey: OTHER, name: 'carol' });
    expect(joinKeyFor('Carol', null, makeKey)).toEqual({ joinKey: OTHER, name: 'carol' });
  });
});

describe('resumeOutcome', () => {
  // A resumeSession answer for TOKEN, with this device storing `storedToken`
  function outcome(answer: {
    found: boolean;
    fromLink?: boolean;
    confirmed?: boolean;
    storedToken?: string | undefined;
  }) {
    return resumeOutcome({
      found: answer.found,
      fromLink: answer.fromLink ?? false,
      confirmed: answer.confirmed ?? false,
      personToken: TOKEN,
      storedToken: answer.storedToken,
    });
  }

  test("a device's own stored token resumes silently", () => {
    expect(outcome({ found: true, storedToken: TOKEN })).toBe('adopt');
  });

  test("this device's own personal link resumes silently", () => {
    expect(outcome({ found: true, fromLink: true, storedToken: TOKEN })).toBe('adopt');
  });

  test("a personal link for someone else asks first, on a device that's someone else or no one yet", () => {
    expect(outcome({ found: true, fromLink: true, storedToken: OTHER })).toBe('confirm');
    expect(outcome({ found: true, fromLink: true, storedToken: undefined })).toBe('confirm');
  });

  test('a personal link the user already confirmed is adopted', () => {
    expect(outcome({ found: true, fromLink: true, confirmed: true, storedToken: OTHER })).toBe('adopt');
    expect(outcome({ found: true, fromLink: true, confirmed: true, storedToken: undefined })).toBe('adopt');
  });

  test('a personal link nobody holds is reported, whatever this device stored, even once confirmed', () => {
    expect(outcome({ found: false, fromLink: true, storedToken: OTHER })).toBe('linkInvalid');
    expect(outcome({ found: false, fromLink: true, storedToken: undefined })).toBe('linkInvalid');
    expect(outcome({ found: false, fromLink: true, confirmed: true, storedToken: OTHER })).toBe('linkInvalid');
  });

  test('a stored token nobody holds any more is forgotten', () => {
    expect(outcome({ found: false, storedToken: TOKEN })).toBe('forget');
  });

  test('an answer for a stored token that was replaced meanwhile (e.g. by another tab) is stale, found or not', () => {
    expect(outcome({ found: true, storedToken: OTHER })).toBe('stale');
    expect(outcome({ found: true, storedToken: undefined })).toBe('stale');
    expect(outcome({ found: false, storedToken: OTHER })).toBe('stale');
    expect(outcome({ found: false, storedToken: undefined })).toBe('stale');
  });
});

describe('shouldRetryResume', () => {
  test('retries network and server errors, up to three attempts in all', () => {
    expect(shouldRetryResume(0, undefined)).toBe(true);
    expect(shouldRetryResume(0, 500)).toBe(true);
    expect(shouldRetryResume(1, 503)).toBe(true);
    expect(shouldRetryResume(2, 500)).toBe(false);
  });

  test('treats client errors as final', () => {
    expect(shouldRetryResume(0, 404)).toBe(false);
    expect(shouldRetryResume(0, 429)).toBe(false);
    expect(shouldRetryResume(0, 400)).toBe(false);
  });
});

describe('needsMembershipCheck', () => {
  const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
  const check = {
    personId: ME as string | null,
    isListed: (id: string) => id !== ME,
    loadedAt: 2000,
    checkedThrough: 1000,
    busy: false,
  };

  test("asks when a load made since the last check doesn't list this device's person", () => {
    expect(needsMembershipCheck(check)).toBe(true);
  });

  test('not before this device is anyone', () => {
    // Nobody is listed, so only the missing person stops the check
    expect(needsMembershipCheck({ ...check, personId: null, isListed: () => false })).toBe(false);
  });

  test('not while the session lists them', () => {
    expect(needsMembershipCheck({ ...check, isListed: () => true })).toBe(false);
  });

  test('at most once per load, and not for a load from before this device became them', () => {
    // checkedThrough is the last checked load, or when this device became the person
    expect(needsMembershipCheck({ ...check, checkedThrough: 2000 })).toBe(false);
    expect(needsMembershipCheck({ ...check, checkedThrough: 2500 })).toBe(false);
  });

  test('not while a join, resume or earlier check is in flight', () => {
    expect(needsMembershipCheck({ ...check, busy: true })).toBe(false);
  });
});
