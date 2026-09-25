import type { PrismaClient } from '@/generated/prisma/client';

/** SystemSetting key for the admin "guest receipt uploads" toggle. */
export const GUEST_UPLOADS_SETTING_KEY = 'guestUploadsEnabled';

/**
 * Whether anonymous visitors may upload and scan receipts on Quick Split.
 * Defaults to enabled so existing installs keep their behavior until an
 * admin turns it off; only the stored value "false" disables it.
 */
export async function isGuestUploadsEnabled(db: PrismaClient): Promise<boolean> {
  const setting = await db.systemSetting.findUnique({
    where: { key: GUEST_UPLOADS_SETTING_KEY },
    select: { value: true },
  });
  return setting?.value !== 'false';
}

/**
 * Quick Split's upload + AI scan path is shared by anonymous guests and
 * signed-in users. The toggle exists to stop unauthenticated storage and AI
 * spend, so signed-in users keep access when guest uploads are disabled.
 */
export function canUploadAsGuest({ enabled, signedIn }: { enabled: boolean; signedIn: boolean }): boolean {
  return enabled || signedIn;
}
