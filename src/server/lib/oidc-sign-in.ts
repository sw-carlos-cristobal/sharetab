/**
 * Policy for OIDC sign-ins, kept free of Auth.js and Prisma so it can be
 * unit-tested. The Auth.js `signIn` callback gathers the facts and turns a
 * denial into a redirect to `/login?error=<code>`.
 */

export type OidcSignInError =
  'OidcSessionActive' | 'OidcEmailMissing' | 'OidcAccountNotLinked' | 'OidcRegistrationDisabled';

export interface OidcSignInFacts {
  /** User already linked to this (provider, sub) pair, if any. */
  linkedUserId: string | null;
  /** User signed in in this browser when the callback ran, if any. */
  sessionUserId: string | null;
  /** Email from the IdP, already resolved to the stored casing. */
  email: string | null;
  /** Existing user with exactly that email, if any. */
  userByEmail: { id: string; isPlaceholder: boolean } | null;
  autoRegister: boolean;
  allowEmailLinking: boolean;
}

export type OidcSignInDecision = { allow: true } | { allow: false; error: OidcSignInError };

export function decideOidcSignIn(facts: OidcSignInFacts): OidcSignInDecision {
  // Returning user, matched by `sub`: the email at the IdP may have changed.
  if (facts.linkedUserId) return { allow: true };

  // Auth.js would silently link an unlinked identity to whoever is signed in
  // in this browser — on a shared device, someone else's account.
  if (facts.sessionUserId) return { allow: false, error: 'OidcSessionActive' };

  if (!facts.email) return { allow: false, error: 'OidcEmailMissing' };

  if (facts.userByEmail) {
    // Placeholder and deleted-user records must never gain a login.
    if (facts.userByEmail.isPlaceholder || !facts.allowEmailLinking) {
      return { allow: false, error: 'OidcAccountNotLinked' };
    }
    return { allow: true };
  }

  if (!facts.autoRegister) return { allow: false, error: 'OidcRegistrationDisabled' };
  return { allow: true };
}

export interface OidcUserProfile {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

function claim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function mapOidcProfile(claims: Record<string, unknown>): OidcUserProfile {
  const id = claim(claims, 'sub');
  if (!id) throw new Error('OIDC profile is missing the "sub" claim');

  const fullName = [claim(claims, 'given_name'), claim(claims, 'family_name')].filter(Boolean).join(' ');
  return {
    id,
    name:
      claim(claims, 'name') ?? (fullName || null) ?? claim(claims, 'preferred_username') ?? claim(claims, 'nickname'),
    email: claim(claims, 'email'),
    image: claim(claims, 'picture'),
  };
}

/**
 * Given the IdP's email and the stored emails that match it
 * case-insensitively, returns the casing to use so that exact-match lookups
 * (Auth.js' `getUserByEmail`, credentials login) find the same user.
 */
export function pickStoredEmail(email: string, candidates: string[]): string {
  if (candidates.includes(email)) return email;
  const [only, ...rest] = candidates;
  return only !== undefined && rest.length === 0 ? only : email;
}
