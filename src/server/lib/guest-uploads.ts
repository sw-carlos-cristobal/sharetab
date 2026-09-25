import type { PrismaClient } from '@/generated/prisma/client';
import { parseBooleanValue } from './env';
import { logger } from './logger';

/** SystemSetting key for the admin "guest receipt uploads" toggle. */
export const GUEST_UPLOADS_SETTING_KEY = 'guestUploadsEnabled';

// The switch is checked before any rate limit, and refused requests never
// consume rate-limit budget, so without a cache every anonymous request —
// including a flood of refused ones — would cost a database query. The value
// is cached for a few seconds; saving through this module updates it at once.
// Kept on globalThis so every route bundle in the process shares one cache
// (and logs the invalid-env warning once).
const CACHE_TTL_MS = 10_000;

interface GuestUploadsState {
  cached?: { enabled: boolean; expiresAt: number };
  // Bumped by every save, so a read that raced a save doesn't cache the old value.
  generation: number;
  warnedInvalidEnv?: boolean;
}

const holder = globalThis as unknown as { guestUploadsState?: GuestUploadsState };

function state(): GuestUploadsState {
  holder.guestUploadsState ??= { generation: 0 };
  return holder.guestUploadsState;
}

/**
 * DISABLE_GUEST_UPLOADS=true locks guest uploads off for the whole deployment,
 * overriding the admin toggle — e.g. before the admin account exists.
 */
export function isGuestUploadsForcedOff(): boolean {
  const raw = process.env.DISABLE_GUEST_UPLOADS;
  const parsed = parseBooleanValue(raw);
  const s = state();
  if (parsed === null && raw?.trim() && !s.warnedInvalidEnv) {
    s.warnedInvalidEnv = true;
    logger.warn('guestUploads.invalidEnv', {
      message:
        'DISABLE_GUEST_UPLOADS must be true/false, 1/0, yes/no or on/off; ignoring it, so the admin toggle applies.',
      value: raw,
    });
  }
  return parsed === true;
}

/**
 * The admin toggle's saved value. Defaults to enabled so existing installs
 * keep their behavior; only the stored value "false" disables it.
 */
export async function readGuestUploadsSetting(db: PrismaClient): Promise<boolean> {
  const s = state();
  if (s.cached && Date.now() < s.cached.expiresAt) return s.cached.enabled;
  const generation = s.generation;
  const setting = await db.systemSetting.findUnique({
    where: { key: GUEST_UPLOADS_SETTING_KEY },
    select: { value: true },
  });
  const enabled = setting?.value !== 'false';
  if (s.generation === generation) s.cached = { enabled, expiresAt: Date.now() + CACHE_TTL_MS };
  return enabled;
}

export async function saveGuestUploadsSetting(db: PrismaClient, enabled: boolean): Promise<void> {
  await db.systemSetting.upsert({
    where: { key: GUEST_UPLOADS_SETTING_KEY },
    update: { value: String(enabled) },
    create: { key: GUEST_UPLOADS_SETTING_KEY, value: String(enabled) },
  });
  const s = state();
  s.generation += 1;
  s.cached = { enabled, expiresAt: Date.now() + CACHE_TTL_MS };
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

/** Clears the cached setting and warning state — for tests only. */
export function _resetGuestUploadsCache(): void {
  delete holder.guestUploadsState;
}
