import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  systemSetting: { findUnique: vi.fn() },
  receipt: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { processReceiptImage, checkRateLimit } = vi.hoisted(() => ({
  processReceiptImage: vi.fn(),
  checkRateLimit: vi.fn(),
}));
vi.mock('@/server/lib/receipt-processor', () => ({ processReceiptImage }));
vi.mock('@/server/lib/rate-limit', () => ({ checkRateLimit, refundRateLimit: vi.fn() }));
vi.mock('@/server/ai/registry', () => ({ getConfiguredProviderPriority: vi.fn().mockReturnValue([]) }));

type Session = { user: { id: string } } | null;

async function caller(session: Session = null) {
  const { guestRouter } = await import('./guest');
  const ctx = { session, db: mockDb, headers: new Headers(), impersonating: null };
  return guestRouter.createCaller(ctx as unknown as Parameters<typeof guestRouter.createCaller>[0]);
}

const signedIn: Session = { user: { id: 'user-1' } };

function guestUploadsSetting(value: 'true' | 'false' | null) {
  mockDb.systemSetting.findUnique.mockResolvedValue(value === null ? null : { key: 'guestUploadsEnabled', value });
}

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
});

describe('guest.getUploadStatus', () => {
  test('allows anonymous uploads by default', async () => {
    guestUploadsSetting(null);
    expect(await (await caller()).getUploadStatus()).toEqual({ allowed: true });
  });

  test('refuses anonymous uploads when an admin disabled them', async () => {
    guestUploadsSetting('false');
    expect(await (await caller()).getUploadStatus()).toEqual({ allowed: false });
  });

  test('still allows signed-in users when guest uploads are disabled', async () => {
    guestUploadsSetting('false');
    expect(await (await caller(signedIn)).getUploadStatus()).toEqual({ allowed: true });
  });
});

describe('guest.processReceipt with guest uploads disabled', () => {
  beforeEach(() => {
    guestUploadsSetting('false');
  });

  test('refuses anonymous callers before touching the receipt or AI quotas', async () => {
    const api = await caller();
    await expect(api.processReceipt({ receiptId: 'r1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.receipt.findUnique).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(processReceiptImage).not.toHaveBeenCalled();
  });

  test('lets signed-in users scan their Quick Split receipt', async () => {
    const receipt = { id: 'r1', isGuest: true };
    mockDb.receipt.findUnique.mockResolvedValue(receipt);
    mockDb.receipt.updateMany.mockResolvedValue({ count: 1 });
    processReceiptImage.mockResolvedValue({ subtotal: 100 });

    const api = await caller(signedIn);
    expect(await api.processReceipt({ receiptId: 'r1' })).toEqual({ subtotal: 100 });
    expect(processReceiptImage).toHaveBeenCalledWith(expect.objectContaining({ receiptId: 'r1', receipt }));
  });
});

describe('guest.processReceipt with guest uploads enabled', () => {
  test('anonymous callers reach the receipt lookup as before', async () => {
    guestUploadsSetting(null);
    mockDb.receipt.findUnique.mockResolvedValue(null);
    const api = await caller();
    await expect(api.processReceipt({ receiptId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
