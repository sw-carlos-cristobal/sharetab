import type { OidcSignInError } from '@/server/lib/oidc-sign-in';

/** Translation keys under `auth.login.errors`. */
export type SignInErrorKey =
  'sessionActive' | 'emailMissing' | 'accountNotLinked' | 'registrationDisabled' | 'linkExpired' | 'generic';

const OIDC_ERROR_KEYS: Record<OidcSignInError, SignInErrorKey> = {
  OidcSessionActive: 'sessionActive',
  OidcEmailMissing: 'emailMissing',
  OidcAccountNotLinked: 'accountNotLinked',
  OidcRegistrationDisabled: 'registrationDisabled',
};

// A Map, not an object lookup: the code comes from the URL, and keys like
// `constructor` must not resolve to Object.prototype members.
const ERROR_KEYS = new Map<string, SignInErrorKey>([
  ...Object.entries(OIDC_ERROR_KEYS),
  // Auth.js' own client-safe error codes
  ['OAuthAccountNotLinked', 'accountNotLinked'],
  ['Verification', 'linkExpired'],
]);

/**
 * Maps the `?error=` code on the login page (ours from the OIDC signIn
 * callback, or Auth.js' own) to a translation key.
 */
export function getSignInErrorKey(code: string | null): SignInErrorKey | null {
  if (!code) return null;
  return ERROR_KEYS.get(code) ?? 'generic';
}
