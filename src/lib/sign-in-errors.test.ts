import { describe, expect, test } from 'vitest';
import { getSignInErrorKey } from './sign-in-errors';

describe('getSignInErrorKey', () => {
  test('no code means no error', () => {
    expect(getSignInErrorKey(null)).toBeNull();
    expect(getSignInErrorKey('')).toBeNull();
  });

  test.each([
    ['OidcSessionActive', 'sessionActive'],
    ['OidcEmailMissing', 'emailMissing'],
    ['OidcAccountNotLinked', 'accountNotLinked'],
    ['OAuthAccountNotLinked', 'accountNotLinked'],
    ['OidcRegistrationDisabled', 'registrationDisabled'],
    ['Verification', 'linkExpired'],
  ])('%s maps to %s', (code, key) => {
    expect(getSignInErrorKey(code)).toBe(key);
  });

  test.each(['Configuration', 'AccessDenied', 'OAuthCallbackError', 'something-else', 'constructor', '__proto__'])(
    'other codes (%s) map to generic',
    (code) => {
      expect(getSignInErrorKey(code)).toBe('generic');
    },
  );
});
