import { describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { AmbiguousEmailError, findUserByEmail, findUsersByEmail, pickUserByEmail } from './user-email';

type Row = { id: string; email: string };

function mockDb(rows: Row[]) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue(rows.map(({ id }) => ({ id }))),
    user: { findMany: vi.fn().mockResolvedValue(rows) },
  };
  return { db, client: db as unknown as PrismaClient };
}

describe('findUsersByEmail', () => {
  test('matches with lower() = lower() in SQL, not a LIKE pattern, then loads the rows oldest first', async () => {
    const { db, client } = mockDb([{ id: 'u1', email: 'Alice@example.com' }]);
    await expect(findUsersByEmail(client, 'a_ice@example.com')).resolves.toEqual([
      { id: 'u1', email: 'Alice@example.com' },
    ]);
    const [strings, ...values] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toMatch(/lower\(email\)\s*=\s*lower\(\?\)/i);
    expect(strings.join('?')).not.toMatch(/like/i);
    expect(values).toEqual(['a_ice@example.com']);
    expect(db.user.findMany).toHaveBeenCalledWith({ where: { id: { in: ['u1'] } }, orderBy: { createdAt: 'asc' } });
  });

  test('skips the row load when nothing matches', async () => {
    const { db, client } = mockDb([]);
    await expect(findUsersByEmail(client, 'nobody@example.com')).resolves.toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});

describe('pickUserByEmail', () => {
  const user = (id: string, email: string) => ({ id, email });

  test('no matches means no user', () => {
    expect(pickUserByEmail('alice@example.com', [])).toBeNull();
  });

  test('returns the single match regardless of case', () => {
    expect(pickUserByEmail('alice@example.com', [user('u1', 'Alice@Example.com')])).toEqual(
      user('u1', 'Alice@Example.com'),
    );
  });

  test('prefers the exact match when several casings exist', () => {
    expect(
      pickUserByEmail('alice@example.com', [user('u1', 'Alice@example.com'), user('u2', 'alice@example.com')]),
    ).toEqual(user('u2', 'alice@example.com'));
  });

  test('throws AmbiguousEmailError instead of guessing when several other casings exist', () => {
    expect(() =>
      pickUserByEmail('alice@example.com', [user('u1', 'Alice@example.com'), user('u2', 'ALICE@example.com')]),
    ).toThrow(AmbiguousEmailError);
  });
});

describe('findUserByEmail', () => {
  test('looks up case-insensitively and picks the match', async () => {
    const { client } = mockDb([{ id: 'u1', email: 'Bob@example.com' }]);
    await expect(findUserByEmail(client, 'bob@example.com')).resolves.toEqual({ id: 'u1', email: 'Bob@example.com' });
  });

  test('propagates AmbiguousEmailError', async () => {
    const { client } = mockDb([
      { id: 'u1', email: 'Bob@example.com' },
      { id: 'u2', email: 'BOB@example.com' },
    ]);
    await expect(findUserByEmail(client, 'bob@example.com')).rejects.toBeInstanceOf(AmbiguousEmailError);
  });
});
