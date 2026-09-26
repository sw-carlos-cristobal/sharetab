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
const JOIN_KEY = '44444444-4444-4444-8444-444444444444';
const DAY_MS = 24 * 60 * 60 * 1000;

// A person's record of the join that created them, still within its replay window
function liveJoin(normalizedName: string) {
  return { key: JOIN_KEY, name: normalizedName, expiresAt: Date.now() + 60_000 };
}

function claimSession(
  people: {
    name: string;
    personToken?: string;
    groupSize?: number;
    join?: { key: string; name: string; expiresAt: number };
  }[],
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
    expect(joined.name).toBe('Bob');
    expect(joined.personToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(savedPeople()).toEqual([{ name: 'Host' }, { name: 'Bob', personToken: joined.personToken }]);
  });

  test("mints a new person's token itself and remembers the caller's join key for a day", async () => {
    claimSession([{ name: 'Host' }]);
    const before = Date.now();
    const joined = await (await caller()).joinSession({ token: 'share-1', name: ' Bob ', joinKey: JOIN_KEY });
    expect(joined.personIndex).toBe(1);
    expect(joined.personToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(joined.personToken).not.toBe(JOIN_KEY);
    expect(savedPeople()).toEqual([
      { name: 'Host' },
      {
        name: 'Bob',
        personToken: joined.personToken,
        join: { key: JOIN_KEY, name: 'bob', expiresAt: expect.any(Number) },
      },
    ]);
    const { expiresAt } = (savedPeople() as { join?: { expiresAt: number } }[])[1]!.join!;
    expect(expiresAt - before).toBeGreaterThanOrEqual(DAY_MS);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(DAY_MS);
  });

  test('never gives a presented token that nobody holds to anyone', async () => {
    // e.g. the token of someone who was removed, still stored on their old device or in a leaked link
    claimSession([{ name: 'Host' }]);
    const joined = await (await caller()).joinSession({ token: 'share-1', name: 'Bob', personToken: OTHER_TOKEN });
    expect(joined.personToken).not.toBe(OTHER_TOKEN);
    const seeded = await (await caller()).joinSession({ token: 'share-1', name: 'Host', personToken: OTHER_TOKEN });
    expect(seeded.personToken).not.toBe(OTHER_TOKEN);
  });

  test('gives a pre-seeded name nobody has joined as yet to its first joiner', async () => {
    claimSession([{ name: 'Host' }]);
    const joined = await (await caller()).joinSession({ token: 'share-1', name: ' host ', joinKey: JOIN_KEY });
    expect(joined.personIndex).toBe(0);
    expect(joined.name).toBe('Host');
    expect(savedPeople()).toEqual([
      {
        name: 'Host',
        personToken: joined.personToken,
        join: { key: JOIN_KEY, name: 'host', expiresAt: expect.any(Number) },
      },
    ]);
  });

  test('replaying a join whose response was lost returns the same person, rather than refusing the name', async () => {
    // The first join saved Bob under the caller's join key, but the response never arrived.
    // Someone has renamed Bob since; the replay still matches the name the join was made with.
    claimSession([{ name: 'Host' }, { name: 'Bobby', personToken: OTHER_TOKEN, join: liveJoin('bob') }]);
    expect(
      await (await caller()).joinSession({ token: 'share-1', name: 'BOB', joinKey: JOIN_KEY, groupSize: 3 }),
    ).toEqual({ personIndex: 1, personToken: OTHER_TOKEN, name: 'Bobby' });
    // A replay changes nothing, not even the group size
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses a join key replayed with a different name, without revealing whose it is', async () => {
    claimSession([{ name: 'Host' }, { name: 'Bob', personToken: OTHER_TOKEN, join: liveJoin('bob') }]);
    const error = await (
      await caller()
    )
      .joinSession({ token: 'share-1', name: 'Carol', joinKey: JOIN_KEY })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((error as Error).message).toContain('already used with a different name');
    // Retrying would resend the same key, so the message mustn't suggest it
    expect((error as Error).message).not.toMatch(/try again/i);
    expect((error as Error).message).not.toContain(OTHER_TOKEN);
    expect((error as Error).message).not.toContain('Bob');
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test("a device's stored identity wins over a replayed join key for someone else", async () => {
    // Two tabs: tab A's join as Carol went through with a lost response; tab B then joined as
    // Bob and stored his token; tab A retries Carol, sending Bob's stored token and Carol's key
    claimSession([
      { name: 'Host' },
      { name: 'Carol', personToken: ALICE_TOKEN, join: liveJoin('carol') },
      { name: 'Bob', personToken: OTHER_TOKEN },
    ]);
    expect(
      await (
        await caller()
      ).joinSession({ token: 'share-1', name: 'Carol', joinKey: JOIN_KEY, personToken: OTHER_TOKEN }),
    ).toEqual({ personIndex: 2, personToken: OTHER_TOKEN, name: 'Bob' });
  });

  test('ignores an expired join key', async () => {
    const expired = { key: JOIN_KEY, name: 'bob', expiresAt: Date.now() - 1 };
    claimSession([{ name: 'Host' }, { name: 'Bob', personToken: OTHER_TOKEN, join: expired }]);
    // Same name: now just a taken name
    await expect(
      (await caller()).joinSession({ token: 'share-1', name: 'Bob', joinKey: JOIN_KEY }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Another name: a new person, with a new token
    const joined = await (await caller()).joinSession({ token: 'share-1', name: 'Carol', joinKey: JOIN_KEY });
    expect(joined.personIndex).toBe(2);
    expect(joined.personToken).not.toBe(OTHER_TOKEN);
  });

  test('a caller holding a token joins as that person under their current name, whatever name they typed', async () => {
    // Alice was renamed by someone else, and her device's resume failed, so she typed her old name
    claimSession([{ name: 'Host' }, { name: 'Alice S.', personToken: ALICE_TOKEN }]);
    expect(await (await caller()).joinSession({ token: 'share-1', name: 'Alice', personToken: ALICE_TOKEN })).toEqual({
      personIndex: 1,
      personToken: ALICE_TOKEN,
      name: 'Alice S.',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test("refuses a name someone already joined as when the caller doesn't present that person's token", async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }]);
    const error = await (await caller()).joinSession({ token: 'share-1', name: 'alice' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((error as Error).message).not.toContain(ALICE_TOKEN);
    // The refusal says how to get back in as yourself
    expect((error as Error).message).toContain('personal link');
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
      name: 'Alice',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('updates the group size when the token holder rejoins with a new one', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }]);
    await (await caller()).joinSession({ token: 'share-1', name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2 });
    expect(savedPeople()).toEqual([{ name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2 }]);
  });
});

describe('guest.resumeSession', () => {
  test("refuses with TOO_MANY_REQUESTS once the share token's resume budget is spent", async () => {
    checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30_000 });
    await expect((await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(checkRateLimit).toHaveBeenCalledWith('guest-resume:share-1', 120, 60_000);
    expect(mockDb.guestSplit.findUnique).not.toHaveBeenCalled();
  });

  test('finds the person holding the token, under their current name', async () => {
    // Alice joined, then renamed herself; her device still has her token
    claimSession([{ name: 'Host' }, { name: 'Alice S.', personToken: ALICE_TOKEN }]);
    expect(await (await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN })).toEqual({
      personIndex: 1,
      name: 'Alice S.',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    // Reads only the fields it needs, not the (possibly large) items and assignments
    expect(mockDb.guestSplit.findUnique).toHaveBeenCalledWith({
      where: { shareToken: 'share-1' },
      select: { expiresAt: true, people: true },
    });
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
  test('says which people have joined without exposing their tokens or join keys', async () => {
    claimSession([
      { name: 'Host' },
      { name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2, join: liveJoin('alice') },
    ]);
    const session = await (await caller()).getSession({ token: 'share-1' });
    expect(session.people).toEqual([
      { name: 'Host', groupSize: 1, hasJoined: false },
      { name: 'Alice', groupSize: 2, hasJoined: true },
    ]);
    expect(JSON.stringify(session)).not.toContain(ALICE_TOKEN);
    expect(JSON.stringify(session)).not.toContain(JOIN_KEY);
  });

  test("a finalized split's public result doesn't expose tokens or join keys either", async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN, join: liveJoin('alice') }], {
      status: 'FINALIZED',
    });
    const split = await (await caller()).getSplit({ token: 'share-1' });
    expect(split.people).toEqual([
      { name: 'Host', groupSize: 1, hasJoined: false },
      { name: 'Alice', groupSize: 1, hasJoined: true },
    ]);
    expect(JSON.stringify(split)).not.toContain(ALICE_TOKEN);
    expect(JSON.stringify(split)).not.toContain(JOIN_KEY);
  });
});
