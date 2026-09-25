import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));

import {
  GUEST_UPLOADS_SETTING_KEY,
  _resetGuestUploadsCache,
  canUseGuestUploads,
  isGuestUploadsEnabled,
  isGuestUploadsForcedOff,
  readGuestUploadsSetting,
  saveGuestUploadsSetting,
} from './guest-uploads';

function mockDb(setting: string | null, user: { suspendedAt: Date | null } | null = null) {
  const db = {
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue(setting === null ? null : { value: setting }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    user: { findUnique: vi.fn().mockResolvedValue(user) },
  };
  return { db, prisma: db as unknown as PrismaClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetGuestUploadsCache();
  vi.stubEnv('DISABLE_GUEST_UPLOADS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('readGuestUploadsSetting', () => {
  test('defaults to enabled when the setting has never been saved', async () => {
    const { db, prisma } = mockDb(null);
    expect(await readGuestUploadsSetting(prisma)).toBe(true);
    expect(db.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: GUEST_UPLOADS_SETTING_KEY },
      select: { value: true },
    });
  });

  test('is disabled only by the stored value "false"', async () => {
    expect(await readGuestUploadsSetting(mockDb('false').prisma)).toBe(false);
    _resetGuestUploadsCache();
    expect(await readGuestUploadsSetting(mockDb('true').prisma)).toBe(true);
    _resetGuestUploadsCache();
    // Only saveGuestUploadsSetting writes this key; anything else keeps the default.
    expect(await readGuestUploadsSetting(mockDb('0').prisma)).toBe(true);
  });

  test('sequential reads within the TTL cost one query', async () => {
    vi.useFakeTimers();
    const { db, prisma } = mockDb('false');
    await readGuestUploadsSetting(prisma);
    await readGuestUploadsSetting(prisma);
    expect(db.systemSetting.findUnique).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);
    await readGuestUploadsSetting(prisma);
    expect(db.systemSetting.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('saveGuestUploadsSetting', () => {
  test('upserts the setting and serves the new value from cache immediately', async () => {
    const { db, prisma } = mockDb(null);
    expect(await readGuestUploadsSetting(prisma)).toBe(true);

    await saveGuestUploadsSetting(prisma, false);

    expect(db.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: GUEST_UPLOADS_SETTING_KEY },
      update: { value: 'false' },
      create: { key: GUEST_UPLOADS_SETTING_KEY, value: 'false' },
    });
    expect(await readGuestUploadsSetting(prisma)).toBe(false);
    expect(db.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('cache vs. a concurrent save', () => {
  test('a read that started before a save cannot put the old value back in the cache', async () => {
    let finishRead: (row: { value: string } | null) => void = () => undefined;
    const { db, prisma } = mockDb(null);
    db.systemSetting.findUnique.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );

    const staleRead = readGuestUploadsSetting(prisma);
    await saveGuestUploadsSetting(prisma, false);
    finishRead({ value: 'true' });
    await staleRead;

    expect(await readGuestUploadsSetting(prisma)).toBe(false);
    expect(db.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('DISABLE_GUEST_UPLOADS', () => {
  test('locks guest uploads off without reading the admin setting', async () => {
    vi.stubEnv('DISABLE_GUEST_UPLOADS', 'true');
    const { db, prisma } = mockDb('true');
    expect(isGuestUploadsForcedOff()).toBe(true);
    expect(await isGuestUploadsEnabled(prisma)).toBe(false);
    expect(db.systemSetting.findUnique).not.toHaveBeenCalled();
  });

  test('accepts the same spellings as the other boolean env vars', () => {
    for (const value of ['1', 'yes', 'ON', ' True ']) {
      vi.stubEnv('DISABLE_GUEST_UPLOADS', value);
      expect(isGuestUploadsForcedOff()).toBe(true);
    }
  });

  test('leaves the admin toggle in charge when unset, false, or unrecognized', async () => {
    for (const value of ['', 'false', 'maybe']) {
      vi.stubEnv('DISABLE_GUEST_UPLOADS', value);
      _resetGuestUploadsCache();
      expect(isGuestUploadsForcedOff()).toBe(false);
      expect(await isGuestUploadsEnabled(mockDb(null).prisma)).toBe(true);
    }
  });

  test('logs a warning once for an unrecognized value, so a typo is visible', () => {
    vi.stubEnv('DISABLE_GUEST_UPLOADS', 'ture');
    isGuestUploadsForcedOff();
    isGuestUploadsForcedOff();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'guestUploads.invalidEnv',
      expect.objectContaining({ value: 'ture', message: expect.stringContaining('yes/no') as unknown }),
    );
  });

  test('does not warn for recognized or empty values', () => {
    for (const value of ['', 'true', 'off']) {
      vi.stubEnv('DISABLE_GUEST_UPLOADS', value);
      isGuestUploadsForcedOff();
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('canUseGuestUploads', () => {
  test('lets anyone in while guest uploads are enabled, without resolving the session', async () => {
    const resolveUserId = vi.fn();
    expect(await canUseGuestUploads(mockDb(null).prisma, resolveUserId)).toBe(true);
    expect(resolveUserId).not.toHaveBeenCalled();
  });

  test('refuses anonymous visitors when guest uploads are disabled', async () => {
    expect(await canUseGuestUploads(mockDb('false').prisma, () => undefined)).toBe(false);
  });

  test('keeps Quick Split for active signed-in users when guest uploads are disabled', async () => {
    const { db, prisma } = mockDb('false', { suspendedAt: null });
    expect(await canUseGuestUploads(prisma, () => Promise.resolve('user-1'))).toBe(true);
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' }, select: { suspendedAt: true } });
  });

  test('treats a suspended account like an anonymous visitor', async () => {
    const { prisma } = mockDb('false', { suspendedAt: new Date() });
    expect(await canUseGuestUploads(prisma, () => 'user-1')).toBe(false);
  });

  test('treats a session for a deleted account like an anonymous visitor', async () => {
    const { prisma } = mockDb('false', null);
    expect(await canUseGuestUploads(prisma, () => 'gone')).toBe(false);
  });

  test('signed-in users keep Quick Split when the env var locks guest uploads off', async () => {
    vi.stubEnv('DISABLE_GUEST_UPLOADS', 'true');
    const { prisma } = mockDb(null, { suspendedAt: null });
    expect(await canUseGuestUploads(prisma, () => 'user-1')).toBe(true);
  });
});
