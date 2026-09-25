import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  systemSetting: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  receipt: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  guestSplit: { findUnique: vi.fn(), update: vi.fn() },
  // Interactive transactions run their callback against the same mocks.
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)),
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

  test('rejects an oversized token before it reaches the rate limiter', async () => {
    const api = await caller();
    await expect(api.joinSession({ token: 'x'.repeat(65), name: 'Alice' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(peekRateLimit).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test('opens the transaction when the join is within the limit', async () => {
    mockDb.$transaction.mockRejectedValueOnce(new Error('stop after the rate limit'));
    const api = await caller();
    await expect(api.joinSession({ token: 'share-token', name: 'Alice' })).rejects.toThrow('stop after the rate limit');
    expect(mockDb.$transaction).toHaveBeenCalledOnce();
  });
});

const ALICE_TOKEN = '11111111-1111-4111-8111-111111111111';
const OTHER_TOKEN = '22222222-2222-4222-8222-222222222222';

function claimSession(
  people: { name: string; personToken?: string; groupSize?: number }[],
  overrides: { status?: string; expiresAt?: Date } = {},
) {
  mockDb.guestSplit.findUnique.mockResolvedValue({
    id: 'gs1',
    shareToken: 'share-1',
    status: 'CLAIMING',
    expiresAt: new Date(Date.now() + 60_000),
    receiptId: null,
    receiptData: { subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'USD' },
    items: [],
    people,
    assignments: [],
    summary: null,
    paidByIndex: 0,
    payerVenmoHandle: null,
    userId: null,
    createdAt: new Date(),
    ...overrides,
  });
}

function savedPeople() {
  const call = mockDb.guestSplit.update.mock.calls.at(-1)?.[0] as { data: { people: unknown } } | undefined;
  return call?.data.people;
}

describe('guest.joinSession', () => {
  test('adds a new name with a fresh token', async () => {
    claimSession([{ name: 'Host' }]);
    const joined = await (await caller()).joinSession({ token: 'share-1', name: 'Bob' });
    expect(joined.personIndex).toBe(1);
    expect(joined.personToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(savedPeople()).toEqual([{ name: 'Host' }, { name: 'Bob', personToken: joined.personToken }]);
  });

  test('gives a pre-seeded name nobody has joined as yet to its first joiner', async () => {
    claimSession([{ name: 'Host' }]);
    const joined = await (await caller()).joinSession({ token: 'share-1', name: ' host ' });
    expect(joined.personIndex).toBe(0);
    expect(savedPeople()).toEqual([{ name: 'Host', personToken: joined.personToken }]);
  });

  test("refuses a name someone already joined as when the caller doesn't present that person's token", async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }]);
    const error = await (await caller()).joinSession({ token: 'share-1', name: 'alice' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((error as Error).message).not.toContain(ALICE_TOKEN);
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses a name someone already joined as when the caller presents a different token', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }]);
    const error = await (
      await caller()
    )
      .joinSession({ token: 'share-1', name: 'Alice', personToken: OTHER_TOKEN })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((error as Error).message).not.toContain(ALICE_TOKEN);
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('lets the holder of the token rejoin as that person', async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }]);
    expect(await (await caller()).joinSession({ token: 'share-1', name: 'Alice', personToken: ALICE_TOKEN })).toEqual({
      personIndex: 1,
      personToken: ALICE_TOKEN,
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('updates the group size when the token holder rejoins with a new one', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }]);
    await (await caller()).joinSession({ token: 'share-1', name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2 });
    expect(savedPeople()).toEqual([{ name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2 }]);
  });

  test('ignores a presented token when joining under a new name', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }]);
    const joined = await (await caller()).joinSession({ token: 'share-1', name: 'Bob', personToken: ALICE_TOKEN });
    expect(joined.personIndex).toBe(1);
    expect(joined.personToken).not.toBe(ALICE_TOKEN);
  });
});

describe('guest.resumeSession', () => {
  test('finds the person holding the token, under their current name', async () => {
    // Alice joined, then renamed herself; her device still has her token
    claimSession([{ name: 'Host' }, { name: 'Alice S.', personToken: ALICE_TOKEN }]);
    expect(await (await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).toEqual({
      personIndex: 1,
      name: 'Alice S.',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('returns null when nobody holds the token any more', async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: OTHER_TOKEN }]);
    expect(await (await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).toBeNull();
  });

  test('reports a missing session as NOT_FOUND', async () => {
    mockDb.guestSplit.findUnique.mockResolvedValue(null);
    await expect((await caller()).resumeSession({ token: 'nope', personToken: ALICE_TOKEN })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('reports an expired session as NOT_FOUND', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }], { expiresAt: new Date(Date.now() - 1000) });
    await expect((await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Session expired',
    });
  });

  test('still finds the person once the session is finalized', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }], { status: 'FINALIZED' });
    expect(await (await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).toEqual({
      personIndex: 0,
      name: 'Alice',
    });
  });
});

describe('guest.getSession people', () => {
  test('says which people have joined without exposing their tokens', async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2 }]);
    const session = await (await caller()).getSession({ token: 'share-1' });
    expect(session.people).toEqual([
      { name: 'Host', groupSize: 1, hasJoined: false },
      { name: 'Alice', groupSize: 2, hasJoined: true },
    ]);
    expect(JSON.stringify(session)).not.toContain(ALICE_TOKEN);
  });
});
