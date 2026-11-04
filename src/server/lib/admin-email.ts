/**
 * Who the admin is: the account `ADMIN_EMAIL` names (#399). The address
 * matches ignoring letter case and spaces around the setting, like every other
 * lookup of "the account for this address" (`user-email.ts`): password
 * sign-ups store the email as typed, while magic link, SSO and Google store it
 * in lowercase.
 */

import type { PrismaClient } from '@/generated/prisma/client';
import { logger } from './logger';
import { AmbiguousEmailError, findUserByEmail } from './user-email';

/** An `ADMIN_EMAIL` value without surrounding spaces, or null when it is unset or blank. */
export function normalizeAdminEmail(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? '';
  return value === '' ? null : value;
}

/**
 * Whether `email` is the address `adminEmail` (an `ADMIN_EMAIL` value) names,
 * ignoring letter case and spaces. Says nothing about which account holds it;
 * use `isAdmin` to grant admin.
 */
export function isAdminEmail(email: string | null | undefined, adminEmail: string | null | undefined): boolean {
  const admin = normalizeAdminEmail(adminEmail);
  if (admin === null || !email) return false;
  return email.trim().toLowerCase() === admin.toLowerCase();
}

/**
 * Whether the user is the admin: the account `ADMIN_EMAIL` refers to, picked
 * as `findUserByEmail` picks it. An account whose email is exactly the setting
 * is the admin with no lookup. One in other letter case is the admin only when
 * no other account has the address: accounts made before email uniqueness
 * ignored case can share it, and then the exact match is the admin, or with
 * none, nobody (logged as `admin.email_ambiguous`).
 */
export async function isAdmin(
  db: PrismaClient,
  user: { id: string; email: string | null | undefined },
): Promise<boolean> {
  const adminEmail = normalizeAdminEmail(process.env.ADMIN_EMAIL);
  if (adminEmail === null || !user.email) return false;
  if (user.email === adminEmail) return true;
  if (!isAdminEmail(user.email, adminEmail)) return false;

  try {
    return (await findUserByEmail(db, adminEmail))?.id === user.id;
  } catch (error) {
    if (!(error instanceof AmbiguousEmailError)) throw error;
    logger.warn('admin.email_ambiguous', {
      reason: 'Several accounts have ADMIN_EMAIL in different letter cases and none matches it exactly',
    });
    return false;
  }
}
