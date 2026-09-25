import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

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

function uploadRequest(ip: string) {
  const form = new FormData();
  form.append('file', new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }));
  return new NextRequest('http://localhost/api/upload?guest=true', {
    method: 'POST',
    body: form,
    headers: { 'x-real-ip': ip },
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
