import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { auth, stat, readFile } = vi.hoisted(() => ({
  auth: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock('@/server/auth', () => ({ auth }));
vi.mock('fs/promises', () => ({ stat, readFile }));

const mockDb = {
  receipt: { findFirst: vi.fn() },
  guestSplit: { findFirst: vi.fn() },
};
vi.mock('@/server/db', () => ({ db: mockDb }));

const IMAGE = 'receipts/3f2a.jpg';

async function get(path = IMAGE) {
  const { GET } = await import('./route');
  return GET(new NextRequest(`http://localhost/api/uploads/${path}`), {
    params: Promise.resolve({ path: path.split('/') }),
  });
}

function groupReceipt() {
  mockDb.receipt.findFirst.mockResolvedValue({
    id: 'r1',
    imagePath: IMAGE,
    isGuest: false,
    uploadedById: 'owner',
    group: { members: [{ userId: 'owner' }, { userId: 'member' }] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
  stat.mockResolvedValue({});
  readFile.mockResolvedValue(Buffer.from('jpeg'));
  mockDb.guestSplit.findFirst.mockResolvedValue(null);
});

describe('GET /api/uploads/[...path]', () => {
  test("a group's receipt is private: signed out 401, someone outside the group 403, a member 200", async () => {
    groupReceipt();
    expect((await get()).status).toBe(401);
    auth.mockResolvedValue({ user: { id: 'stranger' } });
    expect((await get()).status).toBe(403);
    auth.mockResolvedValue({ user: { id: 'member' } });
    expect((await get()).status).toBe(200);
  });

  // #318: the group scan page's Share Link makes a claim session from a group receipt, and
  // the claim page, open to anyone with the link, shows its photo
  test('a receipt a claim session or Quick Split uses is served to anyone, signed in or not', async () => {
    groupReceipt();
    mockDb.guestSplit.findFirst.mockResolvedValue({ id: 's1' });
    expect((await get()).status).toBe(200);
    auth.mockResolvedValue({ user: { id: 'stranger' } });
    expect((await get()).status).toBe(200);
  });

  // Codex on #319: splits made before #318 took any receipt id without checking the caller,
  // so only one whose creator was checked (receiptShared) counts
  test('only a split that has not expired, and whose creator could see the receipt, counts', async () => {
    groupReceipt();
    const before = Date.now();
    await get();
    expect(mockDb.guestSplit.findFirst).toHaveBeenCalledWith({
      where: { receiptId: 'r1', receiptShared: true, expiresAt: { gt: expect.any(Date) } },
      select: { id: true },
    });
    const { where } = mockDb.guestSplit.findFirst.mock.calls[0]![0] as { where: { expiresAt: { gt: Date } } };
    expect(where.expiresAt.gt.getTime()).toBeGreaterThanOrEqual(before);
  });

  test('a guest upload is served to anyone without looking for a split', async () => {
    mockDb.receipt.findFirst.mockResolvedValue({ id: 'r2', imagePath: IMAGE, isGuest: true, group: null });
    expect((await get()).status).toBe(200);
    expect(mockDb.guestSplit.findFirst).not.toHaveBeenCalled();
  });

  test('a path no receipt has is 404', async () => {
    mockDb.receipt.findFirst.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });
});
