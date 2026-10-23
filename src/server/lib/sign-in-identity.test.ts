import { describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { findLinkedUserId, findSignedInUserId, isSessionConflict, readEmailVerified } from './sign-in-identity';

function mockDb(overrides: {
  account?: { userId: string } | null;
  user?: { id: string; isPlaceholder?: boolean } | null;
}) {
  const db = {
    account: { findUnique: vi.fn().mockResolvedValue(overrides.account ?? null) },
    user: { findUnique: vi.fn().mockResolvedValue(overrides.user ?? null) },
  };
  return { db, client: db as unknown as PrismaClient };
}

describe('findLinkedUserId', () => {
  test('returns the user linked to a (provider, account id) pair', async () => {
    const { db, client } = mockDb({ account: { userId: 'u1' } });
    expect(await findLinkedUserId(client, 'google', 'g-1')).toBe('u1');
    expect(db.account.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_providerAccountId: { provider: 'google', providerAccountId: 'g-1' } },
        // Only the user id: not the stored OAuth tokens.
        select: { userId: true },
      }),
    );
  });

  test('returns null for an identity nobody has', async () => {
    expect(await findLinkedUserId(mockDb({}).client, 'oidc', 'sub-1')).toBeNull();
  });
});

describe('findSignedInUserId', () => {
  test('skips the lookup when nobody is signed in', async () => {
    const { db, client } = mockDb({});
    expect(await findSignedInUserId(client, null)).toBeNull();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  test('keeps a session whose user still exists', async () => {
    const { db, client } = mockDb({ user: { id: 'u9' } });
    expect(await findSignedInUserId(client, 'u9')).toBe('u9');
    expect(db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u9' } }));
  });

  test('keeps a session whose user is now a placeholder (a deleted user), so nothing is linked to that row', async () => {
    const { db, client } = mockDb({ user: { id: 'p1', isPlaceholder: true } });
    expect(await findSignedInUserId(client, 'p1')).toBe('p1');
    // By id alone: a lookup that skipped placeholders would let a new identity be linked to the row.
    expect(db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p1' } }));
  });

  test('ignores a session whose user row is gone, as Auth.js does', async () => {
    expect(await findSignedInUserId(mockDb({ user: null }).client, 'gone')).toBeNull();
  });
});

describe('isSessionConflict', () => {
  test.each([
    [null, null, false],
    [null, 'u1', false],
    ['u1', 'u1', false],
    ['u1', null, true],
    ['u2', 'u1', true],
  ])('signed in as %s, identity linked to %s: conflict %s', (sessionUserId, linkedUserId, conflict) => {
    expect(isSessionConflict({ sessionUserId, linkedUserId })).toBe(conflict);
  });
});

describe('readEmailVerified', () => {
  test('reads a boolean claim', () => {
    expect(readEmailVerified({ email_verified: true })).toBe(true);
    expect(readEmailVerified({ email_verified: false })).toBe(false);
  });

  test('reads the "true" / "false" strings some IdPs send', () => {
    expect(readEmailVerified({ email_verified: 'true' })).toBe(true);
    expect(readEmailVerified({ email_verified: 'false' })).toBe(false);
  });

  test('returns null when the claim is missing, or neither a boolean nor exactly "true" / "false"', () => {
    expect(readEmailVerified({})).toBeNull();
    expect(readEmailVerified({ email_verified: 'yes' })).toBeNull();
    // Only the exact lowercase strings count.
    expect(readEmailVerified({ email_verified: 'False' })).toBeNull();
    expect(readEmailVerified({ email_verified: 'True' })).toBeNull();
    expect(readEmailVerified({ email_verified: 0 })).toBeNull();
    expect(readEmailVerified({ email_verified: 1 })).toBeNull();
  });
});
