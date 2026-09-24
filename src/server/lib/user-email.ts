/**
 * Case-insensitive user lookup by email. Auth.js lowercases OAuth and
 * magic-link emails, while password sign-ups store the casing the user typed,
 * so every lookup that should find "the account for this address" ignores
 * case: the Auth.js adapter, password login, registration's duplicate check,
 * and the OIDC sign-in policy.
 */

import type { PrismaClient } from '@/generated/prisma/client';

/** Several accounts share this address ignoring case, and none matches it exactly. */
export class AmbiguousEmailError extends Error {
  constructor() {
    super('Several accounts match this email ignoring case');
    this.name = 'AmbiguousEmailError';
  }
}

/** Users whose email equals `email` ignoring case, oldest first. */
export async function findUsersByEmail(db: PrismaClient, email: string) {
  // lower() = lower() rather than Prisma's `mode: 'insensitive'`, which
  // compiles to ILIKE and treats `_` and `%` in the address as wildcards.
  const rows = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE lower(email) = lower(${email})`;
  if (rows.length === 0) return [];
  return db.user.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: 'asc' } });
}

/**
 * The account an address refers to: the exact match if there is one (what an
 * exact lookup would return), else the only case-insensitive match. Several
 * other-case matches throw rather than guess.
 */
export function pickUserByEmail<T extends { email: string }>(email: string, matches: T[]): T | null {
  const exact = matches.find((m) => m.email === email);
  if (exact) return exact;
  if (matches.length > 1) throw new AmbiguousEmailError();
  return matches[0] ?? null;
}

export async function findUserByEmail(db: PrismaClient, email: string) {
  return pickUserByEmail(email, await findUsersByEmail(db, email));
}
