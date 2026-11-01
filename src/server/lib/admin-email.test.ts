import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));

import { isAdmin, isAdminEmail, normalizeAdminEmail } from './admin-email';

type Row = { id: string; email: string };

function mockDb(rows: Row[]) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue(rows.map(({ id }) => ({ id }))),
    user: { findMany: vi.fn().mockResolvedValue(rows) },
  };
  return { db, client: db as unknown as PrismaClient };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('normalizeAdminEmail', () => {
  test('trims the setting', () => {
    expect(normalizeAdminEmail('  Carlos@Example.com \n')).toBe('Carlos@Example.com');
  });

  test('unset or blank means no admin', () => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    expect(normalizeAdminEmail(undefined)).toBeNull();
    expect(normalizeAdminEmail(null)).toBeNull();
    expect(normalizeAdminEmail('')).toBeNull();
    expect(normalizeAdminEmail('   ')).toBeNull();
  });
});

describe('isAdminEmail', () => {
  test('ignores letter case on both sides and spaces around the setting', () => {
    expect(isAdminEmail('Carlos@example.com', 'carlos@example.com')).toBe(true);
    expect(isAdminEmail('carlos@example.com', ' CARLOS@Example.COM ')).toBe(true);
  });

  test('another address, or no address, is not the admin', () => {
    expect(isAdminEmail('carla@example.com', 'carlos@example.com')).toBe(false);
    expect(isAdminEmail(null, 'carlos@example.com')).toBe(false);
    expect(isAdminEmail(undefined, 'carlos@example.com')).toBe(false);
    expect(isAdminEmail('', 'carlos@example.com')).toBe(false);
  });

  test('nobody is the admin while the setting is unset or blank, whatever ADMIN_EMAIL holds', () => {
    vi.stubEnv('ADMIN_EMAIL', 'carlos@example.com');
    expect(isAdminEmail('carlos@example.com', undefined)).toBe(false);
    expect(isAdminEmail('carlos@example.com', null)).toBe(false);
    expect(isAdminEmail('', '')).toBe(false);
    expect(isAdminEmail(' ', '  ')).toBe(false);
  });
});

describe('isAdmin', () => {
  test('an exact match is the admin without a lookup', async () => {
    vi.stubEnv('ADMIN_EMAIL', 'carlos@example.com');
    const { db, client } = mockDb([]);
    await expect(isAdmin(client, { id: 'u1', email: 'carlos@example.com' })).resolves.toBe(true);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  test('spaces around ADMIN_EMAIL are ignored', async () => {
    vi.stubEnv('ADMIN_EMAIL', '  carlos@example.com  ');
    const { client } = mockDb([]);
    await expect(isAdmin(client, { id: 'u1', email: 'carlos@example.com' })).resolves.toBe(true);
  });

  test('an account registered in other letter case is the admin when it is the only one with the address', async () => {
    vi.stubEnv('ADMIN_EMAIL', 'carlos@example.com');
    const { db, client } = mockDb([{ id: 'u1', email: 'Carlos@example.com' }]);
    await expect(isAdmin(client, { id: 'u1', email: 'Carlos@example.com' })).resolves.toBe(true);
    const [, ...values] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(values).toEqual(['carlos@example.com']);
  });

  test('ADMIN_EMAIL in other letter case than the account still finds it', async () => {
    vi.stubEnv('ADMIN_EMAIL', ' Carlos@Example.com ');
    const { client } = mockDb([{ id: 'u1', email: 'carlos@example.com' }]);
    await expect(isAdmin(client, { id: 'u1', email: 'carlos@example.com' })).resolves.toBe(true);
  });

  // Accounts from before case-insensitive uniqueness can share an address in
  // different letter cases; admin must not spread to all of them.
  test('when another account has the address exactly, only that one is the admin', async () => {
    vi.stubEnv('ADMIN_EMAIL', 'carlos@example.com');
    const { client } = mockDb([
      { id: 'u1', email: 'Carlos@example.com' },
      { id: 'u2', email: 'carlos@example.com' },
    ]);
    await expect(isAdmin(client, { id: 'u1', email: 'Carlos@example.com' })).resolves.toBe(false);
    await expect(isAdmin(client, { id: 'u2', email: 'carlos@example.com' })).resolves.toBe(true);
  });

  test('several accounts in other letter cases and none exact: nobody is the admin, and it is logged', async () => {
    vi.stubEnv('ADMIN_EMAIL', 'carlos@example.com');
    const { client } = mockDb([
      { id: 'u1', email: 'Carlos@example.com' },
      { id: 'u2', email: 'CARLOS@example.com' },
    ]);
    await expect(isAdmin(client, { id: 'u1', email: 'Carlos@example.com' })).resolves.toBe(false);
    await expect(isAdmin(client, { id: 'u2', email: 'CARLOS@example.com' })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('admin.email_ambiguous', expect.any(Object));
  });

  test('another address is not the admin, without a lookup', async () => {
    vi.stubEnv('ADMIN_EMAIL', 'carlos@example.com');
    const { db, client } = mockDb([]);
    await expect(isAdmin(client, { id: 'u2', email: 'carla@example.com' })).resolves.toBe(false);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('nobody is the admin while ADMIN_EMAIL is %s', async (_, value) => {
    vi.stubEnv('ADMIN_EMAIL', value);
    const { db, client } = mockDb([{ id: 'u1', email: 'carlos@example.com' }]);
    await expect(isAdmin(client, { id: 'u1', email: 'carlos@example.com' })).resolves.toBe(false);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  test('a user with no email is not the admin', async () => {
    vi.stubEnv('ADMIN_EMAIL', 'carlos@example.com');
    const { client } = mockDb([]);
    await expect(isAdmin(client, { id: 'u1', email: null })).resolves.toBe(false);
    await expect(isAdmin(client, { id: 'u1', email: undefined })).resolves.toBe(false);
  });

  test('a lookup error is not swallowed', async () => {
    vi.stubEnv('ADMIN_EMAIL', 'carlos@example.com');
    const { db, client } = mockDb([]);
    db.$queryRaw.mockRejectedValue(new Error('connection refused'));
    await expect(isAdmin(client, { id: 'u1', email: 'Carlos@example.com' })).rejects.toThrow('connection refused');
  });
});
