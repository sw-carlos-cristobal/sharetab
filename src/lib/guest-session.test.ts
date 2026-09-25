import { describe, expect, test } from 'vitest';
import { personalLinkHash, readPersonalLinkToken } from './guest-session';

const TOKEN = '11111111-1111-4111-8111-111111111111';

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
