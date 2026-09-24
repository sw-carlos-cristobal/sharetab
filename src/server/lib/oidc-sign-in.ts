/**
 * Policy for OIDC sign-ins. `decideOidcSignIn` is pure; `gatherOidcFacts`
 * collects its inputs from the database. The Auth.js `signIn` callback turns
 * a denial into a redirect to `/login?error=<code>`.
 */

import type { PrismaClient } from '@/generated/prisma/client';
import { isHttpUrl } from './auth-config';
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
  /** The user with that email ignoring case, or 'ambiguous' when several case variants exist. */
  userByEmail: { id: string; isPlaceholder: boolean; hasOidcAccount: boolean } | 'ambiguous' | null;
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
  'ambiguous_email' | 'placeholder' | 'already_linked' | 'linking_disabled' | 'password_registration_open';

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
  // An account with an IdP identity only signs in with that one; otherwise
  // anyone who can claim the email at the IdP could attach a second one.
  if (user.hasOidcAccount) return 'already_linked';
  if (!facts.allowEmailLinking) return 'linking_disabled';
  // While anyone can register a password account, someone could register
  // another person's address in advance and receive their IdP identity on
  // that person's first SSO sign-in.
  if (facts.passwordRegistrationOpen) return 'password_registration_open';
  return null;
}

export function decideOidcSignIn(facts: OidcSignInFacts): OidcSignInDecision {
  // Auth.js would silently link an unlinked identity to whoever is signed in
  // in this browser (on a shared device, someone else's account), and
  // refuses a linked identity that belongs to a different signed-in user.
  if (facts.sessionUserId && facts.sessionUserId !== facts.linkedUserId) {
    return { allow: false, error: 'OidcSessionActive' };
  }

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
    email: claim(claims, 'email'),
    // Rendered as <img src> for other group members: only plain web URLs.
    image: picture && isHttpUrl(picture) ? picture : null,
  };
}

export interface OidcFactsInput {
  providerAccountId: string;
  email: string | null;
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
  const oidcAccount = await db.account.findFirst({
    where: { userId: user.id, provider: OIDC_PROVIDER_ID },
    select: { id: true },
  });
  return { id: user.id, isPlaceholder: user.isPlaceholder, hasOidcAccount: oidcAccount !== null };
}

async function isPasswordRegistrationOpen(db: PrismaClient, passwordLogin: boolean): Promise<boolean> {
  if (!passwordLogin) return false;
  const setting = await db.systemSetting.findUnique({ where: { key: 'registrationMode' }, select: { value: true } });
  // Same reading as auth.register: anything but closed / invite-only is open.
  return setting?.value !== 'closed' && setting?.value !== 'invite-only';
}

export async function gatherOidcFacts(db: PrismaClient, input: OidcFactsInput): Promise<OidcSignInFacts> {
  const [account, userByEmail, sessionUser, passwordRegistrationOpen] = await Promise.all([
    db.account.findUnique({
      where: {
        provider_providerAccountId: { provider: OIDC_PROVIDER_ID, providerAccountId: input.providerAccountId },
      },
      select: { userId: true },
    }),
    input.email ? describeEmailMatch(db, input.email) : null,
    // Auth.js ignores a session whose user row is gone, so we do too. Deleted
    // users that ShareTab keeps as placeholder rows still count as signed in,
    // which also stops Auth.js linking a new identity to that row.
    input.sessionUserId ? db.user.findUnique({ where: { id: input.sessionUserId }, select: { id: true } }) : null,
    // Only matters when linking could happen.
    input.allowEmailLinking ? isPasswordRegistrationOpen(db, input.passwordLogin) : false,
  ]);

  return {
    linkedUserId: account?.userId ?? null,
    sessionUserId: sessionUser?.id ?? null,
    email: input.email,
    userByEmail,
    autoRegister: input.autoRegister,
    allowEmailLinking: input.allowEmailLinking,
    passwordRegistrationOpen,
  };
}
