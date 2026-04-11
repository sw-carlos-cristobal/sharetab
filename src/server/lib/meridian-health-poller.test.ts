import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Mock nodemailer before any imports
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({}),
    }),
  },
}));

// Mock db
const mockDb = {
  systemSetting: {
    findUnique: vi.fn().mockResolvedValue(null),
  },
};
vi.mock("@/server/db", () => ({ db: mockDb }));
vi.mock("@/server/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import nodemailer from "nodemailer";

describe("MeridianHealthPoller", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env = {
      ...originalEnv,
      AI_PROVIDER: "meridian",
      MERIDIAN_PORT: "3457",
      ADMIN_EMAIL: "admin@test.com",
      EMAIL_SERVER_HOST: "smtp.test.com",
      EMAIL_SERVER_PORT: "587",
      EMAIL_FROM: "noreply@test.com",
      NEXTAUTH_URL: "http://localhost:3000",
    };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("checkMeridianHealth returns healthy status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: "healthy",
        auth: { loggedIn: true, email: "user@test.com" },
      }), { status: 200 })
    );

    const { checkMeridianHealth } = await import("./meridian-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("healthy");
    expect(result.email).toBe("user@test.com");
  });

  test("checkMeridianHealth returns unhealthy when not logged in", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: "unhealthy",
        error: "Not logged in. Run: claude login",
      }), { status: 503 })
    );

    const { checkMeridianHealth } = await import("./meridian-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("unhealthy");
    expect(result.error).toBe("Not logged in. Run: claude login");
  });

  test("checkMeridianHealth returns not_running on fetch error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const { checkMeridianHealth } = await import("./meridian-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("not_running");
  });

  test("sendAuthExpiryEmail sends email with correct content", async () => {
    const mockSendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: mockSendMail } as any);

    const { sendAuthExpiryEmail } = await import("./meridian-health-poller");
    await sendAuthExpiryEmail("Not logged in. Run: claude login");

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe("admin@test.com");
    expect(call.subject).toContain("Claude AI authentication expired");
  });

  test("sendAuthExpiryEmail skips when email is not configured", async () => {
    delete process.env.EMAIL_SERVER_HOST;
    const mockSendMail = vi.fn();
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: mockSendMail } as any);

    const { sendAuthExpiryEmail } = await import("./meridian-health-poller");
    await sendAuthExpiryEmail("error");

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("shouldSendEmail returns true on first unhealthy with 'once' interval", async () => {
    const { shouldSendEmail } = await import("./meridian-health-poller");
    const result = await shouldSendEmail(null, "once");
    expect(result).toBe(true);
  });

  test("shouldSendEmail returns false on second unhealthy with 'once' interval", async () => {
    const { shouldSendEmail } = await import("./meridian-health-poller");
    const now = Date.now();
    const result = await shouldSendEmail(now - 60_000, "once");
    expect(result).toBe(false);
  });

  test("shouldSendEmail returns true when interval has elapsed", async () => {
    const { shouldSendEmail } = await import("./meridian-health-poller");
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const result = await shouldSendEmail(twoHoursAgo, "1h");
    expect(result).toBe(true);
  });

  test("shouldSendEmail returns false when interval has not elapsed", async () => {
    const { shouldSendEmail } = await import("./meridian-health-poller");
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    const result = await shouldSendEmail(thirtyMinutesAgo, "1h");
    expect(result).toBe(false);
  });
});
