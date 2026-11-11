import { describe, expect, test } from 'vitest';
import { rateLimitedMinutes, rateLimitedSignInCode } from './sign-in-rate-limit';

describe('rateLimitedSignInCode', () => {
  test('carries the wait in whole minutes, rounded up', () => {
    expect(rateLimitedSignInCode(15 * 60 * 1000)).toBe('rate_limited:15');
    expect(rateLimitedSignInCode(60_001)).toBe('rate_limited:2');
  });

  test('never says less than a minute', () => {
    expect(rateLimitedSignInCode(1)).toBe('rate_limited:1');
    expect(rateLimitedSignInCode(0)).toBe('rate_limited:1');
    expect(rateLimitedSignInCode(-5)).toBe('rate_limited:1');
  });
});

describe('rateLimitedMinutes', () => {
  test('reads back the minutes a code carries', () => {
    expect(rateLimitedMinutes(rateLimitedSignInCode(14 * 60 * 1000 + 1))).toBe(15);
    expect(rateLimitedMinutes('rate_limited:1')).toBe(1);
  });

  test('is null for any other code, so the page says the password is wrong', () => {
    for (const code of [
      undefined,
      '',
      'credentials',
      'rate_limited',
      'rate_limited:',
      'rate_limited:0',
      'rate_limited:abc',
      'rate_limited:1.5',
      'rate_limited:-3',
      'xrate_limited:5',
      'rate_limited:5x',
    ]) {
      expect(rateLimitedMinutes(code), String(code)).toBeNull();
    }
  });
});
