import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  systemSetting: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  receipt: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { processReceiptImage, checkRateLimit, peekRateLimit } = vi.hoisted(() => ({
  processReceiptImage: vi.fn(),
  checkRateLimit: vi.fn(),
  peekRateLimit: vi.fn(),
}));
vi.mock('@/server/lib/receipt-processor', () => ({ processReceiptImage }));
vi.mock('@/server/lib/rate-limit', () => ({ checkRateLimit, peekRateLimit, refundRateLimit: vi.fn() }));
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

beforeEach(async () => {
  vi.clearAllMocks();
  const { _resetGuestUploadsCache } = await import('@/server/lib/guest-uploads');
  _resetGuestUploadsCache();
  checkRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
  peekRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
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

  test('refuses suspended users when guest uploads are disabled', async () => {
    guestUploadsSetting('false');
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: new Date() });
    expect(await (await caller(signedIn)).getUploadStatus()).toEqual({ allowed: false });
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

  test('refuses suspended users the same way', async () => {
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: new Date() });
    const api = await caller(signedIn);
    await expect(api.processReceipt({ receiptId: 'r1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(processReceiptImage).not.toHaveBeenCalled();
  });

  test('lets signed-in users scan a Quick Split receipt', async () => {
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

describe('guest.joinSession rate limit', () => {
  test('refuses with TOO_MANY_REQUESTS before opening a transaction', async () => {
    checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30_000 });
    const api = await caller();
    await expect(api.joinSession({ token: 'share-token', name: 'Alice', groupSize: 2 })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test('opens the transaction when the join is within the limit', async () => {
    mockDb.$transaction.mockRejectedValue(new Error('stop after the rate limit'));
    const api = await caller();
    await expect(api.joinSession({ token: 'share-token', name: 'Alice' })).rejects.toThrow('stop after the rate limit');
    expect(mockDb.$transaction).toHaveBeenCalledOnce();
  });
});
