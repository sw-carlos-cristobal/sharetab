/**
 * Policy for OIDC sign-ins. `decideOidcSignIn` is pure; `gatherOidcFacts`
 * collects its inputs from the database. The Auth.js `signIn` callback turns
 * a denial into a redirect to `/login?error=<code>`.
 */

import type { PrismaClient } from '@/generated/prisma/client';

/** Provider id of the generic OIDC provider (callback path `/api/auth/callback/oidc`). */
export const OIDC_PROVIDER_ID = 'oidc';

export type OidcSignInError =
  'OidcSessionActive' | 'OidcEmailMissing' | 'OidcAccountNotLinked' | 'OidcRegistrationDisabled';

export interface OidcSignInFacts {
  /** User already linked to this (provider, sub) pair, if any. */
  linkedUserId: string | null;
  /** User signed in in this browser when the callback ran, if any. */
  sessionUserId: string | null;
  /** Email from the IdP (Auth.js lowercases it). */
  email: string | null;
  /** Existing user with that email, compared case-insensitively. */
  userByEmail: { id: string; isPlaceholder: boolean } | 'ambiguous' | null;
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
    // Placeholder and deleted-user records must never gain a login, and
    // with several case-variants there's no safe way to pick one.
    if (facts.userByEmail === 'ambiguous' || facts.userByEmail.isPlaceholder || !facts.allowEmailLinking) {
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
 * Picks the user an email refers to, ignoring case: the exact match if there
 * is one, else the only case-insensitive match, else `'ambiguous'`.
 *
 * Candidates are re-checked here because the database query may over-match
 * (a case-insensitive SQL comparison can treat `_` and `%` as wildcards).
 */
export function matchUserByEmail<T extends { email: string }>(email: string, candidates: T[]): T | 'ambiguous' | null {
  const exact = candidates.find((c) => c.email === email);
  if (exact) return exact;
  const lower = email.toLowerCase();
  const [only, ...rest] = candidates.filter((c) => c.email.toLowerCase() === lower);
  if (!only) return null;
  return rest.length === 0 ? only : 'ambiguous';
}

/**
 * Case-insensitive user lookup by email. Auth.js lowercases OAuth and
 * magic-link emails, while password sign-ups store the casing the user
 * typed, so an exact lookup would miss existing users.
 */
export async function findUserByEmail(db: PrismaClient, email: string) {
  const candidates = await db.user.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    take: 10,
  });
  return matchUserByEmail(email, candidates);
}

export interface OidcFactsInput {
  providerAccountId: string;
  email: string | null;
  sessionUserId: string | null;
  autoRegister: boolean;
  allowEmailLinking: boolean;
}

export async function gatherOidcFacts(db: PrismaClient, input: OidcFactsInput): Promise<OidcSignInFacts> {
  const [account, match, sessionUser] = await Promise.all([
    db.account.findUnique({
      where: {
        provider_providerAccountId: { provider: OIDC_PROVIDER_ID, providerAccountId: input.providerAccountId },
      },
      select: { userId: true },
    }),
    input.email ? findUserByEmail(db, input.email) : null,
    // A session cookie can outlive its user (deleted account); Auth.js
    // ignores such a session, so we must too.
    input.sessionUserId ? db.user.findUnique({ where: { id: input.sessionUserId }, select: { id: true } }) : null,
  ]);

  return {
    linkedUserId: account?.userId ?? null,
    sessionUserId: sessionUser?.id ?? null,
    email: input.email,
    userByEmail: match && match !== 'ambiguous' ? { id: match.id, isPlaceholder: match.isPlaceholder } : match,
    autoRegister: input.autoRegister,
    allowEmailLinking: input.allowEmailLinking,
  };
}
