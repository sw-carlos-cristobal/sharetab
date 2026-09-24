/**
 * Policy for OIDC sign-ins. `decideOidcSignIn` is pure; `gatherOidcFacts`
 * collects its inputs from the database. The Auth.js `signIn` callback turns
 * a denial into a redirect to `/login?error=<code>`.
 */

import type { PrismaClient } from '@/generated/prisma/client';
import { isHttpUrl } from './auth-config';

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
  /** Email Auth.js passes to the callback: the IdP's, lowercased (only irrelevant for linked identities). */
  email: string | null;
  /** The user with that email ignoring case, or 'ambiguous' when several case variants exist. */
  userByEmail: { id: string; isPlaceholder: boolean; hasOidcAccount: boolean } | 'ambiguous' | null;
  autoRegister: boolean;
  allowEmailLinking: boolean;
}

export type OidcSignInDecision = { allow: true } | { allow: false; error: OidcSignInError };

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
    // Never link when there's no single safe target: placeholder and
    // deleted-user records must not gain a login, several case variants
    // leave no way to pick one, and an account that already has an IdP
    // identity only signs in with that one (otherwise anyone who can claim
    // the email at the IdP could attach a second identity to it).
    if (
      facts.userByEmail === 'ambiguous' ||
      facts.userByEmail.isPlaceholder ||
      facts.userByEmail.hasOidcAccount ||
      !facts.allowEmailLinking
    ) {
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

/**
 * Users whose email equals `email` ignoring case, oldest first. Auth.js
 * lowercases OAuth and magic-link emails, while password sign-ups store the
 * casing the user typed, so an exact lookup would miss existing users.
 */
export async function findUsersByEmail(db: PrismaClient, email: string) {
  // lower() = lower() rather than Prisma's `mode: 'insensitive'`, which
  // compiles to ILIKE and treats `_` and `%` in the address as wildcards.
  const rows = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE lower(email) = lower(${email})`;
  if (rows.length === 0) return [];
  return db.user.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: 'asc' } });
}

/**
 * The user Auth.js' `getUserByEmail` should return: the exact match if there
 * is one (what the stock adapter returns), else the only case-insensitive
 * match. Several other-case matches throw, so Auth.js fails the sign-in
 * instead of treating the address as unused and creating yet another account.
 */
export function pickUserByEmail<T extends { email: string }>(email: string, matches: T[]): T | null {
  const exact = matches.find((m) => m.email === email);
  if (exact) return exact;
  if (matches.length > 1) throw new Error('Several accounts match this email ignoring case');
  return matches[0] ?? null;
}

export interface OidcFactsInput {
  providerAccountId: string;
  email: string | null;
  sessionUserId: string | null;
  autoRegister: boolean;
  allowEmailLinking: boolean;
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

export async function gatherOidcFacts(db: PrismaClient, input: OidcFactsInput): Promise<OidcSignInFacts> {
  const [account, userByEmail, sessionUser] = await Promise.all([
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
  ]);

  return {
    linkedUserId: account?.userId ?? null,
    sessionUserId: sessionUser?.id ?? null,
    email: input.email,
    userByEmail,
    autoRegister: input.autoRegister,
    allowEmailLinking: input.allowEmailLinking,
  };
}
