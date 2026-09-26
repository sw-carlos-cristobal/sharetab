import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock next-auth (must come before other imports that transitively import it)
vi.mock('next-auth', () => ({
  default: vi.fn(),
}));
vi.mock('@auth/prisma-adapter', () => ({
  PrismaAdapter: vi.fn(),
}));
vi.mock('next-auth/providers/credentials', () => ({
  default: vi.fn(),
}));
vi.mock('next-auth/providers/google', () => ({
  default: vi.fn(),
}));
vi.mock('next-auth/providers/nodemailer', () => ({
  default: vi.fn(),
}));
vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn() },
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({}),
    }),
  },
}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));

// Mock the auth module directly
vi.mock('@/server/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// Mock Prisma client
const mockDb = {
  $queryRaw: vi.fn(),
  user: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  },
  group: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
  },
  expense: {
    count: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
  },
  settlement: {
    count: vi.fn(),
  },
  receipt: {
    count: vi.fn(),
    findMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
  },
  adminAuditLog: {
    create: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
  },
  systemSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  systemInvite: {
    create: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  activityLog: {
    findMany: vi.fn().mockResolvedValue([]),
  },
};

vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
}));
const mockCreateProviderByName = vi.fn();
vi.mock('@/server/ai/registry', () => ({
  getAIProvider: vi.fn().mockResolvedValue({
    name: 'mock-provider',
    isAvailable: vi.fn().mockResolvedValue(true),
  }),
  createProviderByName: mockCreateProviderByName,
  isProviderConfigured: vi.fn().mockReturnValue(true),
  clearProviderCache: vi.fn(),
}));
const mockStartMeridianProxy = vi.fn();
const mockGetMeridianStartError = vi.fn();
vi.mock('@/server/ai/providers/meridian', () => ({
  startMeridianProxy: mockStartMeridianProxy,
  getMeridianStartError: mockGetMeridianStartError,
}));
const mockCheckMeridianHealth = vi.fn();
const mockInvalidateMeridianHealthCache = vi.fn();
vi.mock('@/server/lib/auth-health-poller', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/lib/auth-health-poller')>()),
  checkMeridianHealth: mockCheckMeridianHealth,
  invalidateMeridianHealthCache: mockInvalidateMeridianHealthCache,
}));
const mockSubmitCode = vi.fn();
vi.mock('@/server/lib/meridian-login', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/lib/meridian-login')>()),
  submitCode: mockSubmitCode,
  isLoginInProgress: vi.fn().mockReturnValue(false),
}));

describe('adminProcedure authorization', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: 'admin@example.com' };
  });

  test('exports adminProcedure', async () => {
    const { adminProcedure } = await import('./admin');
    expect(adminProcedure).toBeDefined();
  });

  test('adminRouter is defined and has procedures', async () => {
    const { adminRouter } = await import('./admin');
    expect(adminRouter).toBeDefined();
    expect(adminRouter._def).toBeDefined();
  });

  test('router exports both adminRouter and adminProcedure', async () => {
    const mod = await import('./admin');
    expect(mod.adminRouter).toBeDefined();
    expect(mod.adminProcedure).toBeDefined();
  });
});

describe('logAdminAction helper', () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.adminAuditLog.create.mockClear();
  });

  test('logAdminAction is exported', async () => {
    const { logAdminAction } = await import('./admin');
    expect(logAdminAction).toBeDefined();
    expect(typeof logAdminAction).toBe('function');
  });

  test('logAdminAction creates an audit log entry', async () => {
    const { logAdminAction } = await import('./admin');
    mockDb.adminAuditLog.create.mockResolvedValue({
      id: 'test-id',
      adminId: 'admin-1',
      action: 'USER_DELETED',
      targetId: 'user-1',
      metadata: { email: 'test@test.com' },
    });

    await logAdminAction(mockDb as never, 'admin-1', 'USER_DELETED' as never, 'user-1', { email: 'test@test.com' });

    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        action: 'USER_DELETED',
        targetId: 'user-1',
        metadata: { email: 'test@test.com' },
      },
    });
  });

  test('logAdminAction handles null metadata', async () => {
    const { logAdminAction } = await import('./admin');
    mockDb.adminAuditLog.create.mockResolvedValue({});

    await logAdminAction(mockDb as never, 'admin-1', 'ORPHANS_CLEANED' as never, null, null);

    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        action: 'ORPHANS_CLEANED',
      },
    });
  });
});

describe('admin router procedures existence', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: 'admin@example.com' };
  });

  test('router has all expected procedures', async () => {
    const { adminRouter } = await import('./admin');
    const procedures = Object.keys(adminRouter._def.procedures);

    // Original procedures
    expect(procedures).toContain('getSystemHealth');
    expect(procedures).toContain('listUsers');
    expect(procedures).toContain('deleteUser');
    expect(procedures).toContain('listGroups');
    expect(procedures).toContain('deleteGroup');
    expect(procedures).toContain('getStorageStats');
    expect(procedures).toContain('cleanupOrphans');

    // New procedures
    expect(procedures).toContain('getAuditLog');
    expect(procedures).toContain('suspendUser');
    expect(procedures).toContain('unsuspendUser');
    expect(procedures).toContain('getRegistrationMode');
    expect(procedures).toContain('setRegistrationMode');
    expect(procedures).toContain('createSystemInvite');
    expect(procedures).toContain('listSystemInvites');
    expect(procedures).toContain('revokeSystemInvite');
    expect(procedures).toContain('getAnnouncement');
    expect(procedures).toContain('setAnnouncement');
    expect(procedures).toContain('getVenmoEnabled');
    expect(procedures).toContain('setVenmoEnabled');
    expect(procedures).toContain('getGlobalActivity');
    expect(procedures).toContain('getAIStats');
    expect(procedures).toContain('sendTestEmail');
    expect(procedures).toContain('getImpersonationStatus');
  });
});

describe('admin formatBytes helper', () => {
  test('admin router initializes without errors', async () => {
    const { adminRouter } = await import('./admin');
    expect(adminRouter).toBeTruthy();
  });
});

describe('listUsers input schema', () => {
  const originalEnv = process.env;
  let inputSchema: { parse: (v: unknown) => unknown };

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: 'admin@example.com' };
    const { adminRouter } = await import('./admin');
    const inputs = (adminRouter._def.procedures.listUsers as { _def: { inputs: { parse: (v: unknown) => unknown }[] } })
      ._def.inputs;
    inputSchema = inputs[0]!;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('accepts valid sortBy values', () => {
    for (const sortBy of ['name', 'email', 'groupCount', 'createdAt']) {
      expect(() => inputSchema.parse({ sortBy })).not.toThrow();
    }
  });

  test('rejects invalid sortBy values', () => {
    expect(() => inputSchema.parse({ sortBy: 'totalAmount' })).toThrow();
    expect(() => inputSchema.parse({ sortBy: 'bogus' })).toThrow();
  });

  test('accepts valid status filters', () => {
    for (const status of ['all', 'active', 'suspended', 'placeholder']) {
      expect(() => inputSchema.parse({ status })).not.toThrow();
    }
  });

  test('defaults to createdAt desc when no sort specified', () => {
    const result = inputSchema.parse({}) as { sortBy: string; sortDirection: string };
    expect(result.sortBy).toBe('createdAt');
    expect(result.sortDirection).toBe('desc');
  });

  test('limits search to 200 characters', () => {
    expect(() => inputSchema.parse({ search: 'a'.repeat(201) })).toThrow();
    expect(() => inputSchema.parse({ search: 'a'.repeat(200) })).not.toThrow();
  });

  test('enforces limit bounds and integer constraint', () => {
    expect(() => inputSchema.parse({ limit: 0 })).toThrow();
    expect(() => inputSchema.parse({ limit: 101 })).toThrow();
    expect(() => inputSchema.parse({ limit: 20.5 })).toThrow();
    expect(() => inputSchema.parse({ limit: 50 })).not.toThrow();
  });
});

describe('listGroups input schema', () => {
  const originalEnv = process.env;
  let inputSchema: { parse: (v: unknown) => unknown };

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: 'admin@example.com' };
    const { adminRouter } = await import('./admin');
    const inputs = (
      adminRouter._def.procedures.listGroups as { _def: { inputs: { parse: (v: unknown) => unknown }[] } }
    )._def.inputs;
    inputSchema = inputs[0]!;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('accepts valid sortBy values', () => {
    for (const sortBy of ['name', 'memberCount', 'expenseCount', 'createdAt']) {
      expect(() => inputSchema.parse({ sortBy })).not.toThrow();
    }
  });

  test('rejects computed column sort keys', () => {
    expect(() => inputSchema.parse({ sortBy: 'totalAmount' })).toThrow();
    expect(() => inputSchema.parse({ sortBy: 'lastActivity' })).toThrow();
  });

  test('accepts valid status filters', () => {
    for (const status of ['all', 'active', 'archived']) {
      expect(() => inputSchema.parse({ status })).not.toThrow();
    }
  });

  test('defaults to createdAt desc when no sort specified', () => {
    const result = inputSchema.parse({}) as { sortBy: string; sortDirection: string };
    expect(result.sortBy).toBe('createdAt');
    expect(result.sortDirection).toBe('desc');
  });
});

const adminSession = { user: { id: 'admin-1', email: 'admin@example.com' } };

async function callerAs(session: { user: { id: string; email: string } }) {
  const { adminRouter } = await import('./admin');
  const ctx = { session, db: mockDb, headers: new Headers(), impersonating: null };
  return adminRouter.createCaller(ctx as unknown as Parameters<typeof adminRouter.createCaller>[0]);
}

describe('guest uploads toggle', () => {
  beforeEach(async () => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.stubEnv('DISABLE_GUEST_UPLOADS', '');
    vi.clearAllMocks();
    const { _resetGuestUploadsCache } = await import('@/server/lib/guest-uploads');
    _resetGuestUploadsCache();
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('reports guest uploads as enabled until an admin saves the setting', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue(null);
    const api = await callerAs(adminSession);
    expect(await api.getGuestUploadsEnabled()).toEqual({ enabled: true, forcedOffByEnv: false });
  });

  test('reports the saved value', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: 'guestUploadsEnabled', value: 'false' });
    const api = await callerAs(adminSession);
    expect(await api.getGuestUploadsEnabled()).toEqual({ enabled: false, forcedOffByEnv: false });
  });

  test('reports when DISABLE_GUEST_UPLOADS overrides the saved value', async () => {
    vi.stubEnv('DISABLE_GUEST_UPLOADS', 'true');
    mockDb.systemSetting.findUnique.mockResolvedValue(null);
    const api = await callerAs(adminSession);
    expect(await api.getGuestUploadsEnabled()).toEqual({ enabled: true, forcedOffByEnv: true });
  });

  test('saving the setting upserts it and writes an audit entry', async () => {
    const api = await callerAs(adminSession);
    expect(await api.setGuestUploadsEnabled({ enabled: false })).toEqual({ enabled: false });
    expect(mockDb.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'guestUploadsEnabled' },
      update: { value: 'false' },
      create: { key: 'guestUploadsEnabled', value: 'false' },
    });
    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'admin-1',
        action: 'GUEST_UPLOADS_SETTING_CHANGED',
        metadata: { enabled: false },
      },
    });
  });

  test('refuses to save while DISABLE_GUEST_UPLOADS locks the setting', async () => {
    vi.stubEnv('DISABLE_GUEST_UPLOADS', 'true');
    const api = await callerAs(adminSession);
    await expect(api.setGuestUploadsEnabled({ enabled: true })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mockDb.systemSetting.upsert).not.toHaveBeenCalled();
    expect(mockDb.adminAuditLog.create).not.toHaveBeenCalled();
  });

  test('non-admins cannot read or change the setting', async () => {
    const api = await callerAs({ user: { id: 'user-2', email: 'someone@example.com' } });
    await expect(api.getGuestUploadsEnabled()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.setGuestUploadsEnabled({ enabled: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.systemSetting.upsert).not.toHaveBeenCalled();
  });
});

describe('testAIProvider', () => {
  const input = { providerName: 'openai-codex', imageBase64: 'aGVsbG8=', mimeType: 'image/png' as const };

  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('reports an extraction failure as 503 with the provider message', async () => {
    // Cloudflare replaces an origin's 502 and 504 bodies with its own HTML
    // page, which hid the provider's message.
    const { getHTTPStatusCodeFromError } = await import('@trpc/server/http');
    mockCreateProviderByName.mockResolvedValue({
      name: 'openai-codex',
      isAvailable: vi.fn().mockResolvedValue(true),
      extractReceipt: vi.fn().mockRejectedValue(new Error('OpenAI Codex request failed (429): usage limit reached')),
    });
    const api = await callerAs(adminSession);

    const error: unknown = await api.testAIProvider(input).catch((err: unknown) => err);

    expect(error).toMatchObject({ message: 'OpenAI Codex request failed (429): usage limit reached' });
    expect(getHTTPStatusCodeFromError(error as Parameters<typeof getHTTPStatusCodeFromError>[0])).toBe(503);
  });

  test('records the failure in the audit log', async () => {
    mockCreateProviderByName.mockResolvedValue({
      name: 'openai-codex',
      isAvailable: vi.fn().mockResolvedValue(true),
      extractReceipt: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const api = await callerAs(adminSession);

    await api.testAIProvider(input).catch(() => undefined);

    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'AI_PROVIDER_TESTED',
        metadata: expect.objectContaining({ provider: 'openai-codex', success: false, error: 'boom' }),
      }),
    });
  });
});

describe('Meridian login and status', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
    mockGetMeridianStartError.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('a successful login starts the proxy before the status is re-read', async () => {
    // The health check caches "not running" for 15s, so the page's status
    // refetch after the login must not land before the proxy is up.
    mockSubmitCode.mockResolvedValue({ success: true });
    let started = false;
    mockStartMeridianProxy.mockImplementation(async () => {
      await Promise.resolve();
      started = true;
    });
    const startedWhenInvalidated: boolean[] = [];
    mockInvalidateMeridianHealthCache.mockImplementation(() => startedWhenInvalidated.push(started));
    const api = await callerAs(adminSession);

    await api.completeMeridianLogin({ code: 'abc#state' });

    expect(mockStartMeridianProxy).toHaveBeenCalledTimes(1);
    expect(startedWhenInvalidated.at(-1)).toBe(true);
  });

  test('a login reports why the proxy did not start', async () => {
    mockSubmitCode.mockResolvedValue({ success: true });
    mockStartMeridianProxy.mockResolvedValue(undefined);
    mockGetMeridianStartError.mockReturnValue('Meridian proxy did not answer on port 3457');
    const api = await callerAs(adminSession);

    const result = await api.completeMeridianLogin({ code: 'abc#state' });

    expect(result).toMatchObject({ success: true, proxyError: 'Meridian proxy did not answer on port 3457' });
    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'MERIDIAN_LOGIN_COMPLETED',
        metadata: expect.objectContaining({ proxyError: 'Meridian proxy did not answer on port 3457' }),
      }),
    });
  });

  test('a login does not wait forever for a proxy start that hangs', async () => {
    vi.useFakeTimers();
    try {
      mockSubmitCode.mockResolvedValue({ success: true });
      mockStartMeridianProxy.mockReturnValue(new Promise(() => undefined));
      const api = await callerAs(adminSession);

      const login = api.completeMeridianLogin({ code: 'abc#state' });
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(login).resolves.toMatchObject({ success: true });
      expect(mockInvalidateMeridianHealthCache).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failed login does not start the proxy', async () => {
    mockSubmitCode.mockResolvedValue({ success: false, error: 'invalid code' });
    const api = await callerAs(adminSession);

    await api.completeMeridianLogin({ code: 'abc#state' });

    expect(mockStartMeridianProxy).not.toHaveBeenCalled();
  });

  test('the status shows why the proxy is not running', async () => {
    mockCheckMeridianHealth.mockResolvedValue({ status: 'not_running' });
    mockGetMeridianStartError.mockReturnValue("Cannot find module '@libsql/linux-x64-musl'");
    const api = await callerAs(adminSession);

    expect(await api.getMeridianAuthStatus()).toMatchObject({
      status: 'not_running',
      error: "Cannot find module '@libsql/linux-x64-musl'",
    });
  });

  test('the status leaves a running proxy alone', async () => {
    mockCheckMeridianHealth.mockResolvedValue({ status: 'healthy', email: 'me@example.com' });
    mockGetMeridianStartError.mockReturnValue('an old failure');
    const api = await callerAs(adminSession);

    const status = await api.getMeridianAuthStatus();

    expect(status).toMatchObject({ status: 'healthy', email: 'me@example.com' });
    expect(status).not.toHaveProperty('error');
  });
});
