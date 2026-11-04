import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import en from '../../../../messages/en/errors.json';
import de from '../../../../messages/de/errors.json';

const { auth, writeFile, mkdir } = vi.hoisted(() => ({
  auth: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock('@/server/auth', () => ({ auth }));
vi.mock('fs/promises', () => ({ writeFile, mkdir, unlink: vi.fn() }));

const mockDb = {
  systemSetting: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  receipt: { create: vi.fn() },
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// A tiny buffer that passes the JPEG magic-byte check (FF D8 FF, >= 12 bytes).
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]);

function uploadRequest(
  ip: string,
  headers: Record<string, string> = {},
  file = new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }),
) {
  const form = new FormData();
  form.append('file', file);
  return new NextRequest('http://localhost/api/upload?guest=true', {
    method: 'POST',
    body: form,
    headers: { 'x-real-ip': ip, ...headers },
  });
}

function guestUploadsSetting(value: 'false' | null) {
  mockDb.systemSetting.findUnique.mockResolvedValue(value === null ? null : { key: 'guestUploadsEnabled', value });
}

beforeEach(async () => {
  vi.clearAllMocks();
  // Fresh route module per test so its in-memory rate-limit buckets don't carry over.
  vi.resetModules();
  const { _resetGuestUploadsCache } = await import('@/server/lib/guest-uploads');
  _resetGuestUploadsCache();
  vi.stubEnv('DISABLE_GUEST_UPLOADS', '');
  auth.mockResolvedValue(null);
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  mockDb.receipt.create.mockResolvedValue({ id: 'r1', imagePath: 'receipts/r1.jpg' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/upload?guest=true', () => {
  test('refuses anonymous uploads with 403 when guest uploads are disabled, writing nothing', async () => {
    guestUploadsSetting('false');
    const { POST } = await import('./route');

    const res = await POST(uploadRequest('203.0.113.1'));

    expect(res.status).toBe(403);
    expect(writeFile).not.toHaveBeenCalled();
    expect(mockDb.receipt.create).not.toHaveBeenCalled();
  });

  test('still accepts signed-in Quick Split uploads when guest uploads are disabled', async () => {
    guestUploadsSetting('false');
    auth.mockResolvedValue({ user: { id: 'user-1' } });
    const { POST } = await import('./route');

    const res = await POST(uploadRequest('203.0.113.2'));

    expect(res.status).toBe(200);
    expect(mockDb.receipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ isGuest: true }) as unknown,
    });
  });

  test("refuses a suspended user's session when guest uploads are disabled", async () => {
    guestUploadsSetting('false');
    auth.mockResolvedValue({ user: { id: 'user-1' } });
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: new Date() });
    const { POST } = await import('./route');

    const res = await POST(uploadRequest('203.0.113.4'));

    expect(res.status).toBe(403);
    expect(writeFile).not.toHaveBeenCalled();
  });

  test('refuses anonymous uploads when DISABLE_GUEST_UPLOADS is set, whatever the admin toggle says', async () => {
    guestUploadsSetting(null);
    vi.stubEnv('DISABLE_GUEST_UPLOADS', 'true');
    const { POST } = await import('./route');

    const res = await POST(uploadRequest('203.0.113.5'));

    expect(res.status).toBe(403);
    expect(mockDb.systemSetting.findUnique).not.toHaveBeenCalled();
  });

  test('accepts anonymous uploads while guest uploads are enabled (default)', async () => {
    guestUploadsSetting(null);
    const { POST } = await import('./route');

    const res = await POST(uploadRequest('203.0.113.3'));

    expect(res.status).toBe(200);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(auth).not.toHaveBeenCalled();
  });
});

// #266: the upload's errors were English in every locale
describe('POST /api/upload errors', () => {
  test('come back in the language the page sends, and in English when it sends none', async () => {
    guestUploadsSetting('false');
    const { POST } = await import('./route');

    const german = await POST(uploadRequest('203.0.113.6', { 'x-locale': 'de' }));
    expect(german.status).toBe(403);
    expect(await german.json()).toEqual({ error: de.guestUploadsDisabled });

    const english = await POST(uploadRequest('203.0.113.7'));
    expect(await english.json()).toEqual({ error: en.guestUploadsDisabled });
  });

  test('fill in their details', async () => {
    guestUploadsSetting(null);
    const { POST } = await import('./route');

    const res = await POST(
      uploadRequest(
        '203.0.113.8',
        { 'x-locale': 'de' },
        new File(['%PDF'], 'receipt.pdf', { type: 'application/pdf' }),
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: de.invalidFileType.replace('{types}', 'image/jpeg, image/png, image/webp, image/heic'),
    });
  });
});

// #434: an upload from a signed-in user only checked the session, so one account could store
// receipt images without end
describe('POST /api/upload for a signed-in user (#434)', () => {
  function signedInUpload(
    headers: Record<string, string> = {},
    file = new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }),
  ) {
    const form = new FormData();
    form.append('file', file);
    return new NextRequest('http://localhost/api/upload', { method: 'POST', body: form, headers });
  }

  beforeEach(() => {
    auth.mockResolvedValue({ user: { id: 'user-1' } });
    vi.stubEnv('USER_UPLOAD_LIMIT', '2');
  });

  test('allows USER_UPLOAD_LIMIT uploads an hour, then refuses with 429, storing nothing', async () => {
    const { POST } = await import('./route');

    expect((await POST(signedInUpload())).status).toBe(200);
    expect((await POST(signedInUpload())).status).toBe(200);
    const refused = await POST(signedInUpload());

    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: en.uploadsRateLimited });
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(mockDb.receipt.create).toHaveBeenCalledTimes(2);
  });

  test('says so in the language the page sends', async () => {
    const { POST } = await import('./route');
    await POST(signedInUpload());
    await POST(signedInUpload());

    const refused = await POST(signedInUpload({ 'x-locale': 'de' }));
    expect(await refused.json()).toEqual({ error: de.uploadsRateLimited });
  });

  test('counts each account separately', async () => {
    const { POST } = await import('./route');
    await POST(signedInUpload());
    await POST(signedInUpload());
    expect((await POST(signedInUpload())).status).toBe(429);

    auth.mockResolvedValue({ user: { id: 'user-2' } });
    expect((await POST(signedInUpload())).status).toBe(200);
  });

  test('an upload refused for its file spends nothing', async () => {
    const { POST } = await import('./route');
    const pdf = () => new File(['%PDF'], 'receipt.pdf', { type: 'application/pdf' });
    for (let i = 0; i < 3; i++) {
      expect((await POST(signedInUpload({}, pdf()))).status).toBe(400);
    }

    expect((await POST(signedInUpload())).status).toBe(200);
    expect((await POST(signedInUpload())).status).toBe(200);
  });

  test("doesn't spend the guest upload budget", async () => {
    vi.stubEnv('USER_UPLOAD_LIMIT', '50');
    vi.stubEnv('GUEST_UPLOAD_GLOBAL_LIMIT', '1');
    const { POST } = await import('./route');
    for (let i = 0; i < 3; i++) {
      expect((await POST(signedInUpload())).status).toBe(200);
    }
    auth.mockResolvedValue(null);
    expect((await POST(uploadRequest('203.0.113.20'))).status).toBe(200);
  });
});
