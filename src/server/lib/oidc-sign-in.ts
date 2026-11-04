/**
 * Policy for OIDC sign-ins. `decideOidcSignIn` is pure; `gatherOidcFacts`
 * collects its inputs from the database; `checkOidcSignIn` runs both for the
 * Auth.js `signIn` callback, turning a denial into a redirect to
 * `/login?error=<code>`.
 */

import type { PrismaClient } from '@/generated/prisma/client';
import { isHttpUrl } from './auth-config';
import { logger } from './logger';
import { isRegistrationOpen } from './registration-mode';
import { findLinkedUserId, findSignedInUserId, isSessionConflict } from './sign-in-identity';
import { findUsersByEmail } from './user-email';

/** Provider id of the generic OIDC provider (callback path `/api/auth/callback/oidc`). */
export const OIDC_PROVIDER_ID = 'oidc';

/** Same limit as the register form's name field. */
const MAX_NAME_LENGTH = 100;

export type OidcSignInError =
  'OidcSessionActive' | 'OidcEmailMissing' | 'OidcAccountNotLinked' | 'OidcRegistrationDisabled';

export interface OidcSignInFacts {
  /** User already linked to this (provider, sub) pair, if any. */
  linkedUserId: string | null;
  /** User signed in in this browser when the callback ran, if any. */
  sessionUserId: string | null;
  /**
   * The IdP's email, lowercased by Auth.js. For linked identities Auth.js
   * passes the linked user's stored email instead (unused by the policy).
   */
  email: string | null;
  /** The IdP's `email_verified` claim, or null when it doesn't send one. */
  emailVerified: boolean | null;
  /** The user with that email ignoring case, or 'ambiguous' when several case variants exist. */
  userByEmail: { id: string; isPlaceholder: boolean; hasLinkedIdentity: boolean } | 'ambiguous' | null;
  autoRegister: boolean;
  allowEmailLinking: boolean;
  /** Anyone can create a password account (password login on, registration not closed or invite-only). */
  passwordRegistrationOpen: boolean;
}

/**
 * Why an existing account wasn't linked. Users all see the same
 * `OidcAccountNotLinked` message; the reason is logged for the admin.
 */
export type OidcLinkRefusal =
  | 'ambiguous_email'
  | 'placeholder'
  | 'already_linked'
  | 'linking_disabled'
  | 'email_unverified'
  | 'password_registration_open';

export type OidcSignInDecision =
  | { allow: true }
  | { allow: false; error: Exclude<OidcSignInError, 'OidcAccountNotLinked'> }
  | { allow: false; error: 'OidcAccountNotLinked'; reason: OidcLinkRefusal };

/** Why the identity may not be linked to the account with its email, or null when it may. */
function linkRefusal(
  facts: OidcSignInFacts,
  user: NonNullable<OidcSignInFacts['userByEmail']>,
): OidcLinkRefusal | null {
  // Several case variants leave no way to pick one.
  if (user === 'ambiguous') return 'ambiguous_email';
  // Placeholder and deleted-user records must never gain a login.
  if (user.isPlaceholder) return 'placeholder';
  // An account already linked to an IdP or Google identity keeps only that
  // one; otherwise anyone who can claim the email at the IdP could attach a second.
  if (user.hasLinkedIdentity) return 'already_linked';
  if (!facts.allowEmailLinking) return 'linking_disabled';
  // The IdP itself doesn't vouch for the address (Authentik's default email
  // mapping always says so), so it proves nothing about who owns the account.
  if (facts.emailVerified === false) return 'email_unverified';
  // While anyone can register a password account, someone could register
  // another person's address in advance and receive their IdP identity on
  // that person's first SSO sign-in. (An account made through Google has a
  // Google identity, so it's refused above as already_linked.)
  if (facts.passwordRegistrationOpen) return 'password_registration_open';
  return null;
}

export function decideOidcSignIn(facts: OidcSignInFacts): OidcSignInDecision {
  if (isSessionConflict(facts)) return { allow: false, error: 'OidcSessionActive' };

  // Returning user, matched by `sub`: the email at the IdP may have changed.
  if (facts.linkedUserId) return { allow: true };

  if (!facts.email) return { allow: false, error: 'OidcEmailMissing' };

  if (facts.userByEmail) {
    const reason = linkRefusal(facts, facts.userByEmail);
    return reason ? { allow: false, error: 'OidcAccountNotLinked', reason } : { allow: true };
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
  const name =
    claim(claims, 'name') ?? (fullName || null) ?? claim(claims, 'preferred_username') ?? claim(claims, 'nickname');
  const picture = claim(claims, 'picture');
  return {
    id,
    name: name?.slice(0, MAX_NAME_LENGTH) ?? null,
    // Auth.js lowercases it too; doing it here doesn't depend on that.
    email: claim(claims, 'email')?.toLowerCase() ?? null,
    // Rendered as <img src> for other group members: only plain web URLs.
    image: picture && isHttpUrl(picture) ? picture : null,
  };
}

export interface OidcFactsInput {
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean | null;
  sessionUserId: string | null;
  autoRegister: boolean;
  allowEmailLinking: boolean;
  passwordLogin: boolean;
}

async function describeEmailMatch(db: PrismaClient, email: string): Promise<OidcSignInFacts['userByEmail']> {
  const matches = await findUsersByEmail(db, email);
  // Stricter than pickUserByEmail: linking needs exactly one candidate.
  if (matches.length > 1) return 'ambiguous';
  const [user] = matches;
  if (!user) return null;
  // Only OIDC and Google sign-ins create Account rows (magic links and
  // passwords don't), so any row is an external identity linked to the account.
  const linkedIdentity = await db.account.findFirst({ where: { userId: user.id }, select: { id: true } });
  return { id: user.id, isPlaceholder: user.isPlaceholder, hasLinkedIdentity: linkedIdentity !== null };
}

export async function gatherOidcFacts(db: PrismaClient, input: OidcFactsInput): Promise<OidcSignInFacts> {
  const [linkedUserId, userByEmail, sessionUserId, passwordRegistrationOpen] = await Promise.all([
    findLinkedUserId(db, OIDC_PROVIDER_ID, input.providerAccountId),
    input.email ? describeEmailMatch(db, input.email) : null,
    findSignedInUserId(db, input.sessionUserId),
    // Only matters when linking could happen.
    input.allowEmailLinking && input.passwordLogin ? isRegistrationOpen(db) : false,
  ]);

  return {
    linkedUserId,
    sessionUserId,
    email: input.email,
    emailVerified: input.emailVerified,
    userByEmail,
    autoRegister: input.autoRegister,
    allowEmailLinking: input.allowEmailLinking,
    passwordRegistrationOpen,
  };
}

/** The `signIn` callback's answer for an OIDC sign-in: `true`, or where to redirect a denial. */
export async function checkOidcSignIn(db: PrismaClient, input: OidcFactsInput): Promise<true | string> {
  const decision = decideOidcSignIn(await gatherOidcFacts(db, input));
  if (decision.allow) return true;

  logger.warn('auth.oidc_denied', {
    error: decision.error,
    ...('reason' in decision ? { reason: decision.reason } : {}),
    email: input.email,
  });
  return `/login?error=${decision.error}`;
}
