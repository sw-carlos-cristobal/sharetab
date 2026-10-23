/**
 * What the OIDC and Google sign-ins both need to know about the identity
 * signing in: who it's linked to, who is already signed in in this browser,
 * whether letting it in would attach it to that person, and its
 * `email_verified` claim.
 */

import type { PrismaClient } from '@/generated/prisma/client';

/** The user linked to this provider identity (`Account` row), if any. */
export async function findLinkedUserId(
  db: PrismaClient,
  provider: string,
  providerAccountId: string,
): Promise<string | null> {
  const account = await db.account.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId } },
    select: { userId: true },
  });
  return account?.userId ?? null;
}

/**
 * The user signed in in this browser, if their row still exists. Auth.js
 * ignores a session whose user row is gone, so we do too. Deleted users that
 * ShareTab keeps as placeholder rows still count as signed in, which also
 * stops Auth.js linking a new identity to that row.
 */
export async function findSignedInUserId(db: PrismaClient, sessionUserId: string | null): Promise<string | null> {
  if (!sessionUserId) return null;
  const user = await db.user.findUnique({ where: { id: sessionUserId }, select: { id: true } });
  return user?.id ?? null;
}

/**
 * Auth.js would silently link an identity nobody has yet to whoever is signed
 * in in this browser (on a shared device, someone else's account), and refuses
 * one linked to a different signed-in user. ShareTab has no "connect another
 * sign-in" page, so any sign-in that isn't the signed-in user's own is refused.
 */
export function isSessionConflict(facts: { sessionUserId: string | null; linkedUserId: string | null }): boolean {
  return facts.sessionUserId !== null && facts.sessionUserId !== facts.linkedUserId;
}

/**
 * The `email_verified` claim; some IdPs send it as the string "true" or
 * "false". Any other value, "False" included, reads as no claim.
 */
export function readEmailVerified(claims: Record<string, unknown>): boolean | null {
  const value = claims['email_verified'];
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}
