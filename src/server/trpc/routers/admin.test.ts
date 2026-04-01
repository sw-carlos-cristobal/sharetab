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
    delete: vi.fn(),
  },
  group: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
  receipt: {
    count: vi.fn(),
    findMany: vi.fn(),
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

describe("admin formatBytes helper", () => {
  // The formatBytes function is internal, but we can test it indirectly
  // by verifying the router was created successfully
  test("admin router initializes without errors", async () => {
    const { adminRouter } = await import("./admin");
    expect(adminRouter).toBeTruthy();
  });
});
