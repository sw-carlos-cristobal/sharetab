import { describe, test, expect, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { GUEST_UPLOADS_SETTING_KEY, canUploadAsGuest, isGuestUploadsEnabled } from './guest-uploads';

function dbWithSetting(value: string | null) {
  const findUnique = vi.fn().mockResolvedValue(value === null ? null : { value });
  return { db: { systemSetting: { findUnique } } as unknown as PrismaClient, findUnique };
}

describe('isGuestUploadsEnabled', () => {
  test('defaults to enabled when the setting has never been saved', async () => {
    const { db, findUnique } = dbWithSetting(null);
    expect(await isGuestUploadsEnabled(db)).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { key: GUEST_UPLOADS_SETTING_KEY }, select: { value: true } });
  });

  test('is enabled when saved as "true"', async () => {
    expect(await isGuestUploadsEnabled(dbWithSetting('true').db)).toBe(true);
  });

  test('is disabled only when saved as "false"', async () => {
    expect(await isGuestUploadsEnabled(dbWithSetting('false').db)).toBe(false);
  });
});

describe('canUploadAsGuest', () => {
  test('anyone may upload while guest uploads are enabled', () => {
    expect(canUploadAsGuest({ enabled: true, signedIn: false })).toBe(true);
    expect(canUploadAsGuest({ enabled: true, signedIn: true })).toBe(true);
  });

  test('signed-in users keep Quick Split when guest uploads are disabled', () => {
    expect(canUploadAsGuest({ enabled: false, signedIn: true })).toBe(true);
  });

  test('anonymous visitors are refused when guest uploads are disabled', () => {
    expect(canUploadAsGuest({ enabled: false, signedIn: false })).toBe(false);
  });
});
