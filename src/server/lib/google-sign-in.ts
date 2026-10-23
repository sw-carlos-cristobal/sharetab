/**
 * Policy for Google sign-ins. `decideGoogleSignIn` is pure; `gatherGoogleFacts`
 * collects its inputs from the database and Google's ID token claims;
 * `checkGoogleSignIn` runs both for the Auth.js `signIn` callback, turning a
 * denial into a redirect to `/login?error=<code>`.
 *
 * Google never links by email (unlike OIDC's `OIDC_ALLOW_EMAIL_LINKING`): a
 * Google account signs in to the ShareTab account linked to it, or creates a
 * new one.
 */

import type { PrismaClient } from '@/generated/prisma/client';
import type { GoogleConfig } from './auth-config';
import { logger } from './logger';
import { isRegistrationOpen } from './registration-mode';
import { findLinkedUserId, findSignedInUserId, isSessionConflict, readEmailVerified } from './sign-in-identity';
import { findUsersByEmail } from './user-email';

/** Provider id of the Google provider (callback path `/api/auth/callback/google`). */
export const GOOGLE_PROVIDER_ID = 'google';

/**
 * The options `auth.ts` gives Auth.js' Google provider; `google-provider.test.ts`
 * runs them through the real Auth.js.
 */
export function googleProviderOptions(config: GoogleConfig) {
  return {
    // Pinned, since the signIn callback picks the Google policy by it.
    id: GOOGLE_PROVIDER_ID,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    // Always show Google's account chooser, so on a shared device the next
    // person isn't signed in as whoever is still signed in to Google.
    authorization: { params: { prompt: 'select_account' } },
  };
}

export type GoogleSignInError =
  | 'GoogleSessionActive'
  | 'GoogleEmailUnverified'
  | 'GoogleAccountExists'
  | 'GoogleAdminEmailNotHosted'
  | 'GoogleRegistrationDisabled';

export interface GoogleSignInFacts {
  /** User already linked to this Google account, if any. */
  linkedUserId: string | null;
  /** User signed in in this browser when the callback ran, if any. */
  sessionUserId: string | null;
  /**
   * The Google account's email, lowercased by Auth.js. For linked accounts
   * Auth.js passes the linked user's stored email instead (unused by the policy).
   */
  email: string | null;
  /** Google's `email_verified` claim, or null when it doesn't send one. */
  emailVerified: boolean | null;
  /**
   * Google is authoritative for the address (a Gmail address, or an account in
   * a Workspace or Cloud Identity domain: the `hd` claim), so it vouches for
   * who holds it now. For other addresses `email_verified` only says the
   * address was verified when the Google account was made.
   */
  emailHostedByGoogle: boolean;
  /** The email is the instance's `ADMIN_EMAIL`, ignoring case. */
  isAdminEmail: boolean;
  /**
   * Whether a ShareTab user already has that email, in any letter case.
   * Placeholder and deleted users have `@placeholder.local` addresses, so they never match.
   */
  emailTaken: boolean;
  /** The admin's Registration setting is open (not closed or invite-only). */
  registrationOpen: boolean;
}

export type GoogleSignInDecision = { allow: true } | { allow: false; error: GoogleSignInError };

export function decideGoogleSignIn(facts: GoogleSignInFacts): GoogleSignInDecision {
  if (isSessionConflict(facts)) return { allow: false, error: 'GoogleSessionActive' };

  // Returning user, matched by Google's account id: the email may have changed.
  if (facts.linkedUserId) return { allow: true };

  // A new account takes the email as its identity, so Google must vouch for
  // it. Checked first, so an address Google doesn't vouch for learns nothing
  // about which accounts exist.
  if (!facts.email || facts.emailVerified !== true) return { allow: false, error: 'GoogleEmailUnverified' };

  // Auth.js would refuse it too (OAuthAccountNotLinked), which the login page
  // shows as "ask your administrator", and no admin can link a Google account.
  if (facts.emailTaken) return { allow: false, error: 'GoogleAccountExists' };

  // ADMIN_EMAIL grants admin by address. Someone who once held a mailbox at
  // another provider can keep a Google account with it verified, so only an
  // address Google is authoritative for may create the admin account.
  if (facts.isAdminEmail && !facts.emailHostedByGoogle) return { allow: false, error: 'GoogleAdminEmailNotHosted' };

  // Invite-only counts as closed: ShareTab has no way to take an invite code through Google.
  if (!facts.registrationOpen) return { allow: false, error: 'GoogleRegistrationDisabled' };

  return { allow: true };
}

export interface GoogleFactsInput {
  providerAccountId: string;
  /** `user.email` from the `signIn` callback. */
  email: string | null;
  /** Google's ID token claims (the callback's `profile`). */
  claims: Record<string, unknown>;
  sessionUserId: string | null;
  /** `process.env.ADMIN_EMAIL`. */
  adminEmail: string | null | undefined;
}

function isHostedByGoogle(email: string, claims: Record<string, unknown>): boolean {
  const hostedDomain = claims['hd'];
  return email.toLowerCase().endsWith('@gmail.com') || (typeof hostedDomain === 'string' && hostedDomain !== '');
}

export async function gatherGoogleFacts(db: PrismaClient, input: GoogleFactsInput): Promise<GoogleSignInFacts> {
  const [linkedUserId, sessionUserId, usersWithEmail, registrationOpen] = await Promise.all([
    findLinkedUserId(db, GOOGLE_PROVIDER_ID, input.providerAccountId),
    findSignedInUserId(db, input.sessionUserId),
    input.email ? findUsersByEmail(db, input.email) : [],
    isRegistrationOpen(db),
  ]);
  // Looser than the exact match that grants admin everywhere else, on
  // purpose: a near miss still gets the stricter Google check.
  const adminEmail = input.adminEmail?.trim().toLowerCase() ?? '';

  return {
    linkedUserId,
    sessionUserId,
    email: input.email,
    emailVerified: readEmailVerified(input.claims),
    emailHostedByGoogle: input.email !== null && isHostedByGoogle(input.email, input.claims),
    isAdminEmail: adminEmail !== '' && input.email?.toLowerCase() === adminEmail,
    emailTaken: usersWithEmail.length > 0,
    registrationOpen,
  };
}

/** The `signIn` callback's answer for a Google sign-in: `true`, or where to redirect a denial. */
export async function checkGoogleSignIn(db: PrismaClient, input: GoogleFactsInput): Promise<true | string> {
  const decision = decideGoogleSignIn(await gatherGoogleFacts(db, input));
  if (decision.allow) return true;

  // The Google account's ID too: an account whose Google account was deleted
  // and made again only signs in once its `Account` row has the new one.
  logger.warn('auth.google_denied', {
    error: decision.error,
    email: input.email,
    providerAccountId: input.providerAccountId,
  });
  return `/login?error=${decision.error}`;
}
