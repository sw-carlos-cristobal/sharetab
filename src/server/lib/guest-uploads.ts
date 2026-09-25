import type { PrismaClient } from '@/generated/prisma/client';
import { parseBooleanValue } from './auth-config';

/** SystemSetting key for the admin "guest receipt uploads" toggle. */
export const GUEST_UPLOADS_SETTING_KEY = 'guestUploadsEnabled';

// Anonymous upload floods read the setting on every request, so it is cached
// briefly instead of costing a query each time. Saving through this module
// updates the cache at once; another instance sharing the database picks the
// change up within the TTL. Kept on globalThis so every route bundle in the
// process shares one cache.
const CACHE_TTL_MS = 10_000;
const cacheHolder = globalThis as unknown as { guestUploadsSetting?: { enabled: boolean; expiresAt: number } };

/**
 * DISABLE_GUEST_UPLOADS=true locks guest uploads off for the whole deployment,
 * overriding the admin toggle — e.g. before the admin account exists.
 */
export function isGuestUploadsForcedOff(): boolean {
  return parseBooleanValue(process.env.DISABLE_GUEST_UPLOADS) === true;
}

/**
 * The admin toggle's saved value. Defaults to enabled so existing installs
 * keep their behavior; only the stored value "false" disables it.
 */
export async function readGuestUploadsSetting(db: PrismaClient): Promise<boolean> {
  const cached = cacheHolder.guestUploadsSetting;
  if (cached && Date.now() < cached.expiresAt) return cached.enabled;
  const setting = await db.systemSetting.findUnique({
    where: { key: GUEST_UPLOADS_SETTING_KEY },
    select: { value: true },
  });
  const enabled = setting?.value !== 'false';
  cacheHolder.guestUploadsSetting = { enabled, expiresAt: Date.now() + CACHE_TTL_MS };
  return enabled;
}

export async function saveGuestUploadsSetting(db: PrismaClient, enabled: boolean): Promise<void> {
  await db.systemSetting.upsert({
    where: { key: GUEST_UPLOADS_SETTING_KEY },
    update: { value: String(enabled) },
    create: { key: GUEST_UPLOADS_SETTING_KEY, value: String(enabled) },
  });
  cacheHolder.guestUploadsSetting = { enabled, expiresAt: Date.now() + CACHE_TTL_MS };
}

/** Whether anonymous visitors may upload and scan receipts on Quick Split. */
export async function isGuestUploadsEnabled(db: PrismaClient): Promise<boolean> {
  return !isGuestUploadsForcedOff() && (await readGuestUploadsSetting(db));
}

/**
 * Quick Split's upload + AI scan path is shared by anonymous guests and
 * signed-in users. Turning guest uploads off stops unauthenticated storage and
 * AI spend; users with an active (not suspended) account keep access.
 * `resolveUserId` is only called when guest uploads are off.
 */
export async function canUseGuestUploads(
  db: PrismaClient,
  resolveUserId: () => Promise<string | undefined> | string | undefined,
): Promise<boolean> {
  if (await isGuestUploadsEnabled(db)) return true;
  const userId = await resolveUserId();
  if (!userId) return false;
  // Sessions are JWTs, so a suspended user's session stays valid until it expires.
  const user = await db.user.findUnique({ where: { id: userId }, select: { suspendedAt: true } });
  return user !== null && user.suspendedAt === null;
}

/** Clears the cached setting — for tests only. */
export function _resetGuestUploadsCache(): void {
  delete cacheHolder.guestUploadsSetting;
}
