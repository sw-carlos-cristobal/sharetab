import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { auth, logAdminAction, cookieStore, mockDb } = vi.hoisted(() => ({
  auth: vi.fn(),
  logAdminAction: vi.fn(),
  cookieStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
  mockDb: {
    $queryRaw: vi.fn(),
    user: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock('@/server/auth', () => ({ auth }));
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/trpc/routers/admin', () => ({ logAdminAction }));
vi.mock('next/headers', () => ({ cookies: vi.fn().mockResolvedValue(cookieStore) }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DELETE, POST } from './route';

/** The accounts the case-insensitive lookup of ADMIN_EMAIL finds. */
function accountsWithAdminEmail(rows: { id: string; email: string }[]) {
  mockDb.$queryRaw.mockResolvedValueOnce(rows.map(({ id }) => ({ id })));
  mockDb.user.findMany.mockResolvedValueOnce(rows);
}

function startRequest(userId: string) {
  return new Request('http://localhost/api/admin/impersonate', {
    method: 'POST',
    body: JSON.stringify({ userId }),
    headers: { 'content-type': 'application/json' },
  });
}

const capitalizedAdmin = { user: { id: 'admin-1', email: 'Admin@Example.com' } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
  vi.stubEnv('AUTH_SECRET', 'test-secret-for-impersonation-cookie');
  cookieStore.get.mockReturnValue(undefined);
  mockDb.user.findUnique.mockResolvedValue({ id: 'user-1', name: 'User', email: 'user@example.com' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/admin/impersonate: who counts as the admin (#399)', () => {
  test('starts impersonating for an admin who registered the address in other letter case', async () => {
    accountsWithAdminEmail([{ id: 'admin-1', email: 'Admin@Example.com' }]);
    auth.mockResolvedValue(capitalizedAdmin);
    const res = await POST(startRequest('user-1'));
    expect(res.status).toBe(200);
    expect(cookieStore.set).toHaveBeenCalledWith('sharetab-impersonate', expect.any(String), expect.any(Object));
    expect(logAdminAction).toHaveBeenCalledWith(
      mockDb,
      'admin-1',
      'IMPERSONATION_STARTED',
      'user-1',
      expect.any(Object),
    );
  });

  test('ignores letter case and spaces in ADMIN_EMAIL', async () => {
    vi.stubEnv('ADMIN_EMAIL', '  ADMIN@example.com ');
    accountsWithAdminEmail([{ id: 'admin-1', email: 'admin@example.com' }]);
    auth.mockResolvedValue({ user: { id: 'admin-1', email: 'admin@example.com' } });
    expect((await POST(startRequest('user-1'))).status).toBe(200);
  });

  test('refuses a case variant while another account has the address exactly', async () => {
    accountsWithAdminEmail([
      { id: 'admin-1', email: 'Admin@Example.com' },
      { id: 'admin-2', email: 'admin@example.com' },
    ]);
    auth.mockResolvedValue(capitalizedAdmin);
    expect((await POST(startRequest('user-1'))).status).toBe(403);
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  test('refuses anyone else', async () => {
    auth.mockResolvedValue({ user: { id: 'user-2', email: 'user2@example.com' } });
    expect((await POST(startRequest('user-1'))).status).toBe(403);
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/impersonate: who counts as the admin (#399)', () => {
  test('stops impersonating for an admin who registered the address in other letter case', async () => {
    accountsWithAdminEmail([{ id: 'admin-1', email: 'Admin@Example.com' }]);
    auth.mockResolvedValue(capitalizedAdmin);
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(cookieStore.delete).toHaveBeenCalledWith('sharetab-impersonate');
  });

  test('refuses a case variant while another account has the address exactly', async () => {
    accountsWithAdminEmail([
      { id: 'admin-1', email: 'Admin@Example.com' },
      { id: 'admin-2', email: 'admin@example.com' },
    ]);
    auth.mockResolvedValue(capitalizedAdmin);
    expect((await DELETE()).status).toBe(403);
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });

  test('refuses anyone else', async () => {
    auth.mockResolvedValue({ user: { id: 'user-2', email: 'user2@example.com' } });
    expect((await DELETE()).status).toBe(403);
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });
});
