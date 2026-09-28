import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  systemSetting: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  receipt: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  guestSplit: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
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
// The token store's functions share the main ones' mocks: these tests check which key and limit a
// procedure uses, not which store it lands in (rate-limit.test.ts covers that)
vi.mock('@/server/lib/rate-limit', () => ({
  checkRateLimit,
  peekRateLimit,
  refundRateLimit: vi.fn(),
  checkTokenRateLimit: checkRateLimit,
  peekTokenRateLimit: peekRateLimit,
}));
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

describe('share tokens longer than any real one (#208)', () => {
  // Share tokens are 25-character cuids; 64 leaves room and bounds the limiter keys built from them
  const long = 'x'.repeat(65);
  const personToken = '11111111-1111-4111-8111-111111111111';
  const calls: [string, (api: Awaited<ReturnType<typeof caller>>) => Promise<unknown>][] = [
    ['getSession', (api) => api.getSession({ token: long })],
    ['getSplit', (api) => api.getSplit({ token: long })],
    ['resumeSession', (api) => api.resumeSession({ token: long, personToken })],
    ['editPersonName', (api) => api.editPersonName({ token: long, personToken, targetIndex: 0, newName: 'X' })],
    ['removePerson', (api) => api.removePerson({ token: long, personToken, targetIndex: 0 })],
    ['splitClaimItem', (api) => api.splitClaimItem({ token: long, personToken, itemIndex: 0, splitQuantity: 1 })],
    ['claimItems', (api) => api.claimItems({ token: long, personToken, personIndex: 0, claimedItemIndices: [] })],
    ['finalizeSession', (api) => api.finalizeSession({ token: long, personToken, personIndex: 0 })],
  ];

  test.each(calls)('%s refuses it before any rate limit or database read', async (_name, call) => {
    await expect(call(await caller())).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(peekRateLimit).not.toHaveBeenCalled();
    expect(mockDb.guestSplit.findUnique).not.toHaveBeenCalled();
  });

  test('getReceiptItems and processReceipt refuse an oversized receipt id the same way', async () => {
    const api = await caller(signedIn);
    await expect(api.getReceiptItems({ receiptId: long })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.processReceipt({ receiptId: long })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(mockDb.receipt.findUnique).not.toHaveBeenCalled();
  });

  test('a signed-in caller gets the same for expireSession and setPayerVenmoHandle', async () => {
    const api = await caller(signedIn);
    await expect(api.expireSession({ token: long })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.setPayerVenmoHandle({ token: long, handle: 'someone' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(checkRateLimit).not.toHaveBeenCalled();
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The stable id claimSession gives the person at this index (see withIds)
function pid(index: number) {
  return `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

type TestPerson = {
  id?: string;
  name: string;
  personToken?: string;
  groupSize?: number;
  join?: { key: string; name: string; expiresAt: number };
};

// People as saved since person ids exist: anyone without an id gets pid(their index)
function withIds(people: TestPerson[]) {
  return people.map((p, i) => ({ id: pid(i), ...p }));
}

// A person's record of the join that created them, still within its replay window
function liveJoin(normalizedName: string) {
  return { key: JOIN_KEY, name: normalizedName, expiresAt: Date.now() + 60_000 };
}

// A claim session whose people get ids (withIds), unless `legacy` asks for them as saved
// before person ids existed
function claimSession(
  people: TestPerson[],
  {
    legacy = false,
    ...overrides
  }: {
    status?: string;
    expiresAt?: Date;
    assignments?: { itemIndex: number; personIndices: number[] }[];
    items?: { name: string; quantity: number; unitPrice: number; totalPrice: number }[];
    legacy?: boolean;
  } = {},
) {
  mockDb.guestSplit.findUnique.mockResolvedValue({
    id: 'gs1',
    shareToken: 'share-1',
    status: 'CLAIMING',
    expiresAt: new Date(Date.now() + 60_000),
    receiptId: null,
    receiptData: { subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'USD' },
    items: [],
    people: legacy ? people : withIds(people),
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
    expect(joined.personId).toMatch(UUID);
    expect(joined.personId).not.toBe(pid(0));
    expect(savedPeople()).toEqual([
      { id: pid(0), name: 'Host' },
      { id: joined.personId, name: 'Bob', personToken: joined.personToken },
    ]);
  });

  test("mints a new person's token itself and remembers the caller's join key for a day", async () => {
    claimSession([{ name: 'Host' }]);
    const before = Date.now();
    const joined = await (await caller()).joinSession({ token: 'share-1', name: ' Bob ', joinKey: JOIN_KEY });
    expect(joined.personIndex).toBe(1);
    expect(joined.personToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(joined.personToken).not.toBe(JOIN_KEY);
    expect(savedPeople()).toEqual([
      { id: pid(0), name: 'Host' },
      {
        id: joined.personId,
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
    // The seeded person keeps the id they already had
    expect(joined.personId).toBe(pid(0));
    expect(savedPeople()).toEqual([
      {
        id: pid(0),
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
    ).toEqual({ personIndex: 1, personId: pid(1), personToken: OTHER_TOKEN, name: 'Bobby' });
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
    ).toEqual({ personIndex: 2, personId: pid(2), personToken: OTHER_TOKEN, name: 'Bob' });
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
      personId: pid(1),
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
      personId: pid(1),
      personToken: ALICE_TOKEN,
      name: 'Alice',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('updates the group size when the token holder rejoins with a new one', async () => {
    claimSession([{ name: 'Alice', personToken: ALICE_TOKEN }]);
    await (await caller()).joinSession({ token: 'share-1', name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2 });
    expect(savedPeople()).toEqual([{ id: pid(0), name: 'Alice', personToken: ALICE_TOKEN, groupSize: 2 }]);
  });

  test('a replayed join on people saved before person ids existed saves their ids too', async () => {
    claimSession([{ name: 'Host' }, { name: 'Bob', personToken: OTHER_TOKEN, join: liveJoin('bob') }], {
      legacy: true,
    });
    const joined = await (await caller()).joinSession({ token: 'share-1', name: 'Bob', joinKey: JOIN_KEY });
    const saved = savedPeople() as { id: string }[];
    expect(saved.map((p) => p.id)).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
    expect(joined).toEqual({ personIndex: 1, personId: saved[1]!.id, personToken: OTHER_TOKEN, name: 'Bob' });
  });

  test("gives people saved before person ids existed their ids, and returns the caller's", async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }], { legacy: true });
    const joined = await (await caller()).joinSession({ token: 'share-1', name: 'Alice', personToken: ALICE_TOKEN });
    const saved = savedPeople() as { id: string }[];
    expect(saved).toEqual([
      { id: expect.stringMatching(UUID), name: 'Host' },
      { id: expect.stringMatching(UUID), name: 'Alice', personToken: ALICE_TOKEN },
    ]);
    expect(joined).toEqual({ personIndex: 1, personId: saved[1]!.id, personToken: ALICE_TOKEN, name: 'Alice' });
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
      personId: pid(1),
      name: 'Alice S.',
    });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    // Reads only the fields it needs, not the (possibly large) items and assignments
    expect(mockDb.guestSplit.findUnique).toHaveBeenCalledWith({
      where: { shareToken: 'share-1' },
      select: { id: true, expiresAt: true, people: true },
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
      personId: pid(0),
      name: 'Alice',
    });
  });

  test("gives people saved before person ids existed their ids, and returns the caller's", async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }], { legacy: true });
    const resumed = await (await caller()).resumeSession({ token: 'share-1', personToken: ALICE_TOKEN });
    const saved = savedPeople() as { id: string }[];
    expect(saved.map((p) => p.id)).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
    expect(resumed).toEqual({ personIndex: 1, personId: saved[1]!.id, name: 'Alice' });
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
      { id: pid(0), name: 'Host', groupSize: 1, hasJoined: false },
      { id: pid(1), name: 'Alice', groupSize: 2, hasJoined: true },
    ]);
    expect(JSON.stringify(session)).not.toContain(ALICE_TOKEN);
    expect(JSON.stringify(session)).not.toContain(JOIN_KEY);
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('gives people saved before person ids existed their ids once, and lists the saved ids', async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }], { legacy: true });
    const session = await (await caller()).getSession({ token: 'share-1' });
    expect(mockDb.guestSplit.update).toHaveBeenCalledOnce();
    const saved = savedPeople() as { id: string }[];
    expect(saved).toEqual([
      { id: expect.stringMatching(UUID), name: 'Host' },
      { id: expect.stringMatching(UUID), name: 'Alice', personToken: ALICE_TOKEN },
    ]);
    expect(session.people.map((p) => p.id)).toEqual(saved.map((p) => p.id));
  });

  test('gives ids to the people of a finalized split saved before person ids existed', async () => {
    claimSession([{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }], {
      legacy: true,
      status: 'FINALIZED',
    });
    const session = await (await caller()).getSession({ token: 'share-1' });
    const saved = savedPeople() as { id: string }[];
    expect(saved.map((p) => p.id)).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
    expect(session.people.map((p) => p.id)).toEqual(saved.map((p) => p.id));
  });

  test('keeps the ids another request saved first', async () => {
    // The first read has no ids; by the time the transaction reads again, another request gave them
    const legacy = [{ name: 'Host' }, { name: 'Alice', personToken: ALICE_TOKEN }];
    claimSession(legacy, { legacy: true });
    const stored: unknown = await mockDb.guestSplit.findUnique();
    mockDb.guestSplit.findUnique.mockClear();
    mockDb.guestSplit.findUnique
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce({ ...(stored as object), people: withIds(legacy) });
    const session = await (await caller()).getSession({ token: 'share-1' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
    expect(session.people.map((p) => p.id)).toEqual([pid(0), pid(1)]);
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

describe('guest.createClaimSession', () => {
  test('gives the creator and the payer ids', async () => {
    mockDb.guestSplit.create.mockResolvedValue({ id: 'gs1', shareToken: 'share-token-123' });
    mockDb.guestSplit.deleteMany.mockResolvedValue({ count: 0 });
    await (
      await caller()
    ).createClaimSession({
      receiptData: { subtotal: 100, tax: 0, tip: 0, total: 100, currency: 'USD' },
      items: [{ name: 'Tea', quantity: 1, unitPrice: 100, totalPrice: 100 }],
      creatorName: 'Host',
      paidByName: 'Payer',
    });
    const { people } = (mockDb.guestSplit.create.mock.calls[0]![0] as { data: { people: { id: string }[] } }).data;
    expect(people).toEqual([
      { id: expect.stringMatching(UUID), name: 'Host' },
      { id: expect.stringMatching(UUID), name: 'Payer' },
    ]);
    expect(people[0]!.id).not.toBe(people[1]!.id);
  });
});

function savedAssignments() {
  const call = mockDb.guestSplit.update.mock.calls.at(-1)?.[0] as { data: { assignments: unknown } } | undefined;
  return call?.data.assignments;
}

const D_TOKEN = '33333333-3333-4333-8333-333333333333';

function items(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `Item ${i}`, quantity: 1, unitPrice: 100, totalPrice: 100 }));
}

// Issue #205: B (index 1) was removed on another device, so C moved from index 2 to 1 and D
// from 3 to 2. C's page still had the old indexes. D has claimed item 1.
function sessionAfterBWasRemoved() {
  claimSession(
    [
      { id: pid(0), name: 'A', personToken: ALICE_TOKEN },
      { id: pid(2), name: 'C', personToken: OTHER_TOKEN },
      { id: pid(3), name: 'D', personToken: D_TOKEN },
    ],
    { items: items(3), assignments: [{ itemIndex: 1, personIndices: [2] }] },
  );
}

describe('claim-session write limits (#204)', () => {
  const writes = [
    {
      action: 'claim',
      call: (api: Awaited<ReturnType<typeof caller>>) =>
        api.claimItems({ token: 'share-1', personToken: ALICE_TOKEN, personId: pid(1), claimedItemIndices: [0] }),
    },
    {
      action: 'edit-name',
      call: (api: Awaited<ReturnType<typeof caller>>) =>
        api.editPersonName({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(1), newName: 'X' }),
    },
    {
      action: 'remove-person',
      call: (api: Awaited<ReturnType<typeof caller>>) =>
        api.removePerson({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(1) }),
    },
    {
      action: 'split-item',
      call: (api: Awaited<ReturnType<typeof caller>>) =>
        api.splitClaimItem({ token: 'share-1', personToken: ALICE_TOKEN, itemIndex: 0, splitQuantity: 1 }),
    },
  ];

  test.each(writes)(
    "$action: refuses with TOO_MANY_REQUESTS once the caller's own budget is spent",
    async ({ action, call }) => {
      checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30_000 });
      await expect(call(await caller())).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      expect(checkRateLimit).toHaveBeenCalledWith(
        `guest-${action}-person:${JSON.stringify(['share-1', ALICE_TOKEN])}`,
        30,
        60_000,
      );
      expect(mockDb.$transaction).not.toHaveBeenCalled();
    },
  );

  test.each(writes)(
    "$action: refuses with TOO_MANY_REQUESTS once the share token's budget is spent, spending nothing",
    async ({ action, call }) => {
      peekRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30_000 });
      await expect(call(await caller())).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      expect(peekRateLimit).toHaveBeenCalledWith(`guest-${action}:share-1`, 300);
      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(mockDb.$transaction).not.toHaveBeenCalled();
    },
  );
});

describe('guest.getSession read limit (#204)', () => {
  test("refuses with TOO_MANY_REQUESTS once the share token's read budget is spent", async () => {
    checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30_000 });
    await expect((await caller()).getSession({ token: 'share-1' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(checkRateLimit).toHaveBeenCalledWith('guest-session-read:share-1', 3000, 60_000);
    expect(mockDb.guestSplit.findUnique).not.toHaveBeenCalled();
  });
});

describe('claim-session transactions when the database is busy (#203)', () => {
  test('a mutation answers SERVICE_UNAVAILABLE when no pool connection frees up in time', async () => {
    const busy = Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), {
      name: 'TransactionManagerError',
      code: 'P2028',
    });
    mockDb.$transaction.mockRejectedValueOnce(busy);
    await expect(
      (await caller()).claimItems({
        token: 'share-1',
        personToken: ALICE_TOKEN,
        personId: pid(1),
        claimedItemIndices: [0],
      }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'ShareTab is busy right now. Please try again in a moment.',
    });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('guest.claimItems', () => {
  test("saves claims for the person the id names, wherever they are now, leaving others' alone", async () => {
    sessionAfterBWasRemoved();
    await (
      await caller()
    ).claimItems({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(2), claimedItemIndices: [0] });
    expect(savedAssignments()).toEqual([
      { itemIndex: 1, personIndices: [2] },
      { itemIndex: 0, personIndices: [1] },
    ]);
  });

  test('refuses an id nobody has any more with CONFLICT, and saves nothing', async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller()).claimItems({
        token: 'share-1',
        personToken: OTHER_TOKEN,
        personId: pid(1),
        claimedItemIndices: [0],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('still takes a person index (older clients)', async () => {
    sessionAfterBWasRemoved();
    await (
      await caller()
    ).claimItems({ token: 'share-1', personToken: OTHER_TOKEN, personIndex: 1, claimedItemIndices: [0] });
    expect(savedAssignments()).toEqual([
      { itemIndex: 1, personIndices: [2] },
      { itemIndex: 0, personIndices: [1] },
    ]);
  });

  test('refuses a request that names the person both ways, or neither', async () => {
    sessionAfterBWasRemoved();
    const api = await caller();
    await expect(
      api.claimItems({
        token: 'share-1',
        personToken: OTHER_TOKEN,
        personIndex: 1,
        personId: pid(2),
        claimedItemIndices: [],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      api.claimItems({ token: 'share-1', personToken: OTHER_TOKEN, claimedItemIndices: [] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

describe('guest.removePerson', () => {
  test('removes the person the id names, wherever they are now', async () => {
    sessionAfterBWasRemoved();
    await (await caller()).removePerson({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(2) });
    expect((savedPeople() as { id: string }[]).map((p) => p.id)).toEqual([pid(0), pid(3)]);
    // D's claim moves down with D
    expect(savedAssignments()).toEqual([{ itemIndex: 1, personIndices: [1] }]);
  });

  test('refuses an id nobody has any more with CONFLICT, and removes nobody', async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller()).removePerson({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(1) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('refuses a request that names the person both ways', async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller()).removePerson({ token: 'share-1', personToken: ALICE_TOKEN, targetIndex: 1, targetId: pid(2) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

describe('guest.editPersonName', () => {
  test('renames the person the id names, wherever they are now', async () => {
    sessionAfterBWasRemoved();
    await (
      await caller()
    ).editPersonName({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(2), newName: 'Cee' });
    expect((savedPeople() as { name: string }[]).map((p) => p.name)).toEqual(['A', 'Cee', 'D']);
  });

  test('refuses an id nobody has any more with CONFLICT, and renames nobody', async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller()).editPersonName({ token: 'share-1', personToken: ALICE_TOKEN, targetId: pid(1), newName: 'X' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

// The issue's three-person case: A, B, C joined and B was removed, so C is second and the old
// index 2 is past the end
function sessionAfterBWasRemovedFromThree() {
  claimSession(
    [
      { id: pid(0), name: 'A', personToken: ALICE_TOKEN },
      { id: pid(2), name: 'C', personToken: OTHER_TOKEN },
    ],
    { items: items(2) },
  );
}

describe('guest.claimItems with three people', () => {
  test('an id still finds the person whose old index is now past the end', async () => {
    sessionAfterBWasRemovedFromThree();
    await (
      await caller()
    ).claimItems({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(2), claimedItemIndices: [0] });
    expect(savedAssignments()).toEqual([{ itemIndex: 0, personIndices: [1] }]);
  });

  test('the old index is refused as out of range', async () => {
    sessionAfterBWasRemovedFromThree();
    await expect(
      (await caller()).claimItems({
        token: 'share-1',
        personToken: OTHER_TOKEN,
        personIndex: 2,
        claimedItemIndices: [0],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid person index' });
  });
});

describe('guest.removePerson and guest.editPersonName by index (older clients)', () => {
  test('removePerson still takes an index', async () => {
    sessionAfterBWasRemoved();
    await (await caller()).removePerson({ token: 'share-1', personToken: ALICE_TOKEN, targetIndex: 1 });
    expect((savedPeople() as { id: string }[]).map((p) => p.id)).toEqual([pid(0), pid(3)]);
  });

  test('editPersonName still takes an index', async () => {
    sessionAfterBWasRemoved();
    await (
      await caller()
    ).editPersonName({ token: 'share-1', personToken: ALICE_TOKEN, targetIndex: 1, newName: 'Cee' });
    expect((savedPeople() as { name: string }[]).map((p) => p.name)).toEqual(['A', 'Cee', 'D']);
  });

  test('both refuse a request that names the person both ways, or neither', async () => {
    sessionAfterBWasRemoved();
    const api = await caller();
    const base = { token: 'share-1', personToken: ALICE_TOKEN };
    await expect(api.removePerson(base)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.editPersonName({ ...base, newName: 'X' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.editPersonName({ ...base, targetIndex: 1, targetId: pid(2), newName: 'X' })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' },
    );
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });
});

describe('guest.finalizeSession', () => {
  function savedStatus() {
    const call = mockDb.guestSplit.update.mock.calls.at(-1)?.[0] as { data: { status?: string } } | undefined;
    return call?.data.status;
  }

  test('finalizes as the person the id names, wherever they are now', async () => {
    sessionAfterBWasRemoved();
    await (await caller()).finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(2) });
    expect(savedStatus()).toBe('FINALIZED');
  });

  test('refuses an id nobody has any more with CONFLICT', async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller()).finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(1) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test("refuses someone else's id with the caller's token", async () => {
    sessionAfterBWasRemoved();
    await expect(
      (await caller()).finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personId: pid(3) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.guestSplit.update).not.toHaveBeenCalled();
  });

  test('still takes an index (older clients), and refuses both or neither', async () => {
    sessionAfterBWasRemoved();
    const api = await caller();
    await expect(
      api.finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personIndex: 1, personId: pid(2) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await api.finalizeSession({ token: 'share-1', personToken: OTHER_TOKEN, personIndex: 1 });
    expect(savedStatus()).toBe('FINALIZED');
  });
});
