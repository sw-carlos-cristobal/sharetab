import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { auth, logAdminAction, mockDb } = vi.hoisted(() => {
  const models = new Map<string, { findMany: ReturnType<typeof vi.fn> }>();
  const queryRaw = vi.fn();
  // Every model the export reads answers findMany with no rows.
  const mockDb = new Proxy({} as Record<string, unknown>, {
    get(_, key) {
      if (typeof key !== 'string') return undefined;
      if (key === '$queryRaw') return queryRaw;
      if (!models.has(key)) models.set(key, { findMany: vi.fn().mockResolvedValue([]) });
      return models.get(key);
    },
  });
  return { auth: vi.fn(), logAdminAction: vi.fn(), mockDb };
});
vi.mock('@/server/auth', () => ({ auth }));
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/trpc/routers/admin', () => ({ logAdminAction }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { GET } from './route';

type Mocked = { findMany: ReturnType<typeof vi.fn> };
const queryRaw = mockDb['$queryRaw'] as ReturnType<typeof vi.fn>;
const users = mockDb['user'] as Mocked;

/** The accounts the case-insensitive lookup of ADMIN_EMAIL finds. */
function accountsWithAdminEmail(rows: { id: string; email: string }[]) {
  queryRaw.mockResolvedValueOnce(rows.map(({ id }) => ({ id })));
  users.findMany.mockResolvedValueOnce(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/admin/export: who counts as the admin (#399)', () => {
  test('exports for the admin', async () => {
    auth.mockResolvedValue({ user: { id: 'admin-1', email: 'admin@example.com' } });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(mockDb, 'admin-1', 'EXPORT_CREATED', null, expect.any(Object));
  });

  test('exports for an admin who registered the address in other letter case', async () => {
    vi.stubEnv('ADMIN_EMAIL', ' admin@example.com ');
    accountsWithAdminEmail([{ id: 'admin-1', email: 'Admin@Example.com' }]);
    auth.mockResolvedValue({ user: { id: 'admin-1', email: 'Admin@Example.com' } });
    expect((await GET()).status).toBe(200);
  });

  test('refuses a case variant while another account has the address exactly', async () => {
    accountsWithAdminEmail([
      { id: 'other', email: 'Admin@example.com' },
      { id: 'admin-1', email: 'admin@example.com' },
    ]);
    auth.mockResolvedValue({ user: { id: 'other', email: 'Admin@example.com' } });
    expect((await GET()).status).toBe(403);
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  test('refuses anyone else, and a signed-out request', async () => {
    auth.mockResolvedValue({ user: { id: 'user-1', email: 'user@example.com' } });
    expect((await GET()).status).toBe(403);
    auth.mockResolvedValue(null);
    expect((await GET()).status).toBe(403);
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});
