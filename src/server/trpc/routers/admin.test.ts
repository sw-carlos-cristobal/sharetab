import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock next-auth (must come before other imports that transitively import it)
vi.mock("next-auth", () => ({
  default: vi.fn(),
}));
vi.mock("@auth/prisma-adapter", () => ({
  PrismaAdapter: vi.fn(),
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn(),
}));
vi.mock("next-auth/providers/google", () => ({
  default: vi.fn(),
}));
vi.mock("next-auth/providers/nodemailer", () => ({
  default: vi.fn(),
}));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn() },
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({}),
    }),
  },
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));

// Mock the auth module directly
vi.mock("@/server/auth", () => ({
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

vi.mock("@/server/db", () => ({ db: mockDb }));
vi.mock("@/server/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/server/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
}));
vi.mock("@/server/ai/registry", () => ({
  getAIProvider: vi.fn().mockResolvedValue({
    name: "mock-provider",
    isAvailable: vi.fn().mockResolvedValue(true),
  }),
}));

describe("adminProcedure authorization", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: "admin@example.com" };
  });

  test("exports adminProcedure", async () => {
    const { adminProcedure } = await import("./admin");
    expect(adminProcedure).toBeDefined();
  });

  test("adminRouter is defined and has procedures", async () => {
    const { adminRouter } = await import("./admin");
    expect(adminRouter).toBeDefined();
    expect(adminRouter._def).toBeDefined();
  });

  test("router exports both adminRouter and adminProcedure", async () => {
    const mod = await import("./admin");
    expect(mod.adminRouter).toBeDefined();
    expect(mod.adminProcedure).toBeDefined();
  });
});

describe("logAdminAction helper", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.adminAuditLog.create.mockClear();
  });

  test("logAdminAction is exported", async () => {
    const { logAdminAction } = await import("./admin");
    expect(logAdminAction).toBeDefined();
    expect(typeof logAdminAction).toBe("function");
  });

  test("logAdminAction creates an audit log entry", async () => {
    const { logAdminAction } = await import("./admin");
    mockDb.adminAuditLog.create.mockResolvedValue({
      id: "test-id",
      adminId: "admin-1",
      action: "USER_DELETED",
      targetId: "user-1",
      metadata: { email: "test@test.com" },
    });

    await logAdminAction(
      mockDb as never,
      "admin-1",
      "USER_DELETED" as never,
      "user-1",
      { email: "test@test.com" }
    );

    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: "admin-1",
        action: "USER_DELETED",
        targetId: "user-1",
        metadata: { email: "test@test.com" },
      },
    });
  });

  test("logAdminAction handles null metadata", async () => {
    const { logAdminAction } = await import("./admin");
    mockDb.adminAuditLog.create.mockResolvedValue({});

    await logAdminAction(
      mockDb as never,
      "admin-1",
      "ORPHANS_CLEANED" as never,
      null,
      null
    );

    expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: "admin-1",
        action: "ORPHANS_CLEANED",
      },
    });
  });
});

describe("admin router procedures existence", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: "admin@example.com" };
  });

  test("router has all expected procedures", async () => {
    const { adminRouter } = await import("./admin");
    const procedures = Object.keys(adminRouter._def.procedures);

    // Original procedures
    expect(procedures).toContain("getSystemHealth");
    expect(procedures).toContain("listUsers");
    expect(procedures).toContain("deleteUser");
    expect(procedures).toContain("listGroups");
    expect(procedures).toContain("deleteGroup");
    expect(procedures).toContain("getStorageStats");
    expect(procedures).toContain("cleanupOrphans");

    // New procedures
    expect(procedures).toContain("getAuditLog");
    expect(procedures).toContain("suspendUser");
    expect(procedures).toContain("unsuspendUser");
    expect(procedures).toContain("getRegistrationMode");
    expect(procedures).toContain("setRegistrationMode");
    expect(procedures).toContain("createSystemInvite");
    expect(procedures).toContain("listSystemInvites");
    expect(procedures).toContain("revokeSystemInvite");
    expect(procedures).toContain("getAnnouncement");
    expect(procedures).toContain("setAnnouncement");
    expect(procedures).toContain("getGlobalActivity");
    expect(procedures).toContain("getAIStats");
    expect(procedures).toContain("sendTestEmail");
    expect(procedures).toContain("getImpersonationStatus");
  });
});

describe("admin formatBytes helper", () => {
  test("admin router initializes without errors", async () => {
    const { adminRouter } = await import("./admin");
    expect(adminRouter).toBeTruthy();
  });
});

describe("listUsers input schema", () => {
  const originalEnv = process.env;
  let inputSchema: { parse: (v: unknown) => unknown };

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: "admin@example.com" };
    const { adminRouter } = await import("./admin");
    const inputs = (adminRouter._def.procedures.listUsers as { _def: { inputs: { parse: (v: unknown) => unknown }[] } })._def.inputs;
    inputSchema = inputs[0];
  });

  test("accepts valid sortBy values", () => {
    for (const sortBy of ["name", "email", "groupCount", "createdAt"]) {
      expect(() => inputSchema.parse({ sortBy })).not.toThrow();
    }
  });

  test("rejects invalid sortBy values", () => {
    expect(() => inputSchema.parse({ sortBy: "totalAmount" })).toThrow();
    expect(() => inputSchema.parse({ sortBy: "bogus" })).toThrow();
  });

  test("accepts valid status filters", () => {
    for (const status of ["all", "active", "suspended", "placeholder"]) {
      expect(() => inputSchema.parse({ status })).not.toThrow();
    }
  });

  test("defaults to createdAt desc when no sort specified", () => {
    const result = inputSchema.parse({}) as { sortBy: string; sortDirection: string };
    expect(result.sortBy).toBe("createdAt");
    expect(result.sortDirection).toBe("desc");
  });

  test("limits search to 200 characters", () => {
    expect(() => inputSchema.parse({ search: "a".repeat(201) })).toThrow();
    expect(() => inputSchema.parse({ search: "a".repeat(200) })).not.toThrow();
  });

  test("enforces limit bounds", () => {
    expect(() => inputSchema.parse({ limit: 0 })).toThrow();
    expect(() => inputSchema.parse({ limit: 101 })).toThrow();
    expect(() => inputSchema.parse({ limit: 50 })).not.toThrow();
  });
});

describe("listGroups input schema", () => {
  const originalEnv = process.env;
  let inputSchema: { parse: (v: unknown) => unknown };

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv, ADMIN_EMAIL: "admin@example.com" };
    const { adminRouter } = await import("./admin");
    const inputs = (adminRouter._def.procedures.listGroups as { _def: { inputs: { parse: (v: unknown) => unknown }[] } })._def.inputs;
    inputSchema = inputs[0];
  });

  test("accepts valid sortBy values", () => {
    for (const sortBy of ["name", "memberCount", "expenseCount", "createdAt"]) {
      expect(() => inputSchema.parse({ sortBy })).not.toThrow();
    }
  });

  test("rejects computed column sort keys", () => {
    expect(() => inputSchema.parse({ sortBy: "totalAmount" })).toThrow();
    expect(() => inputSchema.parse({ sortBy: "lastActivity" })).toThrow();
  });

  test("accepts valid status filters", () => {
    for (const status of ["all", "active", "archived"]) {
      expect(() => inputSchema.parse({ status })).not.toThrow();
    }
  });

  test("defaults to createdAt desc when no sort specified", () => {
    const result = inputSchema.parse({}) as { sortBy: string; sortDirection: string };
    expect(result.sortBy).toBe("createdAt");
    expect(result.sortDirection).toBe("desc");
  });
});
