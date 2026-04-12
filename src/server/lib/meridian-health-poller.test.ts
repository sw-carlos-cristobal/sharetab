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
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: mockSendMail } as ReturnType<typeof nodemailer.createTransport>);

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
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: mockSendMail } as ReturnType<typeof nodemailer.createTransport>);

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

  test("sendAuthExpiryEmail includes login URL in email when provided", async () => {
    const mockSendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: mockSendMail } as ReturnType<typeof nodemailer.createTransport>);

    const { sendAuthExpiryEmail } = await import("./meridian-health-poller");
    await sendAuthExpiryEmail("Auth expired", "https://claude.ai/oauth/authorize?code=true");

    const call = mockSendMail.mock.calls[0][0];
    expect(call.text).toContain("https://claude.ai/oauth/authorize?code=true");
    expect(call.html).toContain("https://claude.ai/oauth/authorize?code=true");
  });

  test("sendAuthExpiryEmail skips when ADMIN_EMAIL is not set", async () => {
    delete process.env.ADMIN_EMAIL;
    const mockSendMail = vi.fn();
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: mockSendMail } as ReturnType<typeof nodemailer.createTransport>);

    const { sendAuthExpiryEmail } = await import("./meridian-health-poller");
    const sent = await sendAuthExpiryEmail("error");

    expect(sent).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("checkMeridianHealth returns degraded status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: "degraded",
        error: "Could not verify auth status",
      }), { status: 200 })
    );

    const { checkMeridianHealth } = await import("./meridian-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("degraded");
    expect(result.error).toBe("Could not verify auth status");
  });
});

// ─── Poll lifecycle (state machine) tests ─────────────────

describe("MeridianHealthPoller - poll lifecycle", () => {
  const originalEnv = process.env;
  let mockSendMail: ReturnType<typeof vi.fn>;

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
    mockSendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: mockSendMail } as ReturnType<typeof nodemailer.createTransport>);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mockHealthy() {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: "healthy",
        auth: { loggedIn: true, email: "user@test.com" },
      }), { status: 200 })
    );
  }

  function mockUnhealthy(error = "Not logged in. Run: claude login") {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: "unhealthy",
        error,
      }), { status: 503 })
    );
  }

  function mockNotRunning() {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
  }

  test("sends email on first unhealthy even if never seen healthy (auth expired on startup)", async () => {
    const { _pollTick, _resetPollerState } = await import("./meridian-health-poller");
    _resetPollerState();

    // First tick: proxy is running but auth is expired — should alert immediately
    mockUnhealthy();
    await _pollTick();

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][0].subject).toContain("Claude AI authentication expired");
  });

  test("does not send email on first not_running (startup grace period)", async () => {
    const { _pollTick, _resetPollerState } = await import("./meridian-health-poller");
    _resetPollerState();

    // First tick: proxy not running yet (still booting) — no alert
    mockNotRunning();
    await _pollTick();

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("sends email on transition from healthy to unhealthy", async () => {
    const { _pollTick, _resetPollerState } = await import("./meridian-health-poller");
    _resetPollerState();

    // Tick 1: healthy (establishes baseline)
    mockHealthy();
    await _pollTick();
    expect(mockSendMail).not.toHaveBeenCalled();

    // Tick 2: unhealthy — should send email
    mockUnhealthy();
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][0].subject).toContain("Claude AI authentication expired");
  });

  test("does not send duplicate email with 'once' interval", async () => {
    const { _pollTick, _resetPollerState } = await import("./meridian-health-poller");
    _resetPollerState();

    // Tick 1: healthy
    mockHealthy();
    await _pollTick();

    // Tick 2: unhealthy — sends email
    mockUnhealthy();
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Tick 3: still unhealthy — should NOT send again (default is "once")
    mockUnhealthy();
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  test("sends reminder email when interval elapses with '1h' setting", async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: "meridianNotifyInterval", value: "1h" });

    const { _pollTick, _resetPollerState } = await import("./meridian-health-poller");
    _resetPollerState();

    // Tick 1: healthy
    mockHealthy();
    await _pollTick();

    // Tick 2: unhealthy — sends first email
    mockUnhealthy();
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Tick 3: still unhealthy, but only 5 min later — should NOT send
    vi.advanceTimersByTime(5 * 60 * 1000);
    mockUnhealthy();
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Tick 4: still unhealthy, 1 hour later — should send reminder
    vi.advanceTimersByTime(55 * 60 * 1000); // total 60 min
    mockUnhealthy();
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  test("resets email state on recovery, sends again on next incident", async () => {
    const { _pollTick, _resetPollerState } = await import("./meridian-health-poller");
    _resetPollerState();

    // Tick 1: healthy
    mockHealthy();
    await _pollTick();

    // Tick 2: unhealthy — sends email
    mockUnhealthy();
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Tick 3: recovered — resets incident
    mockHealthy();
    await _pollTick();

    // Tick 4: unhealthy again — should send a NEW email
    mockUnhealthy("Token revoked");
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(mockSendMail.mock.calls[1][0].text).toContain("Token revoked");
  });

  test("does not send email when Meridian is not_running after healthy", async () => {
    const { _pollTick, _resetPollerState } = await import("./meridian-health-poller");
    _resetPollerState();

    // Tick 1: healthy
    mockHealthy();
    await _pollTick();

    // Tick 2: not_running (connection refused) — not "unhealthy", no email
    mockNotRunning();
    await _pollTick();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("startPoller does nothing when AI_PROVIDER is not meridian", async () => {
    process.env.AI_PROVIDER = "openai";
    const { startPoller, stopPoller } = await import("./meridian-health-poller");

    startPoller();
    // No tick should happen — advance time past the 30s delay + poll interval
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(fetch).not.toHaveBeenCalled();

    stopPoller();
  });

  test("startPoller does not fetch before 30s delay", async () => {
    const { startPoller, stopPoller } = await import("./meridian-health-poller");

    startPoller();

    // Before 30s — no fetch should have happened
    vi.advanceTimersByTime(20_000);
    expect(fetch).not.toHaveBeenCalled();

    stopPoller();
  });

  test("stopPoller prevents future ticks", async () => {
    const { startPoller, stopPoller } = await import("./meridian-health-poller");

    startPoller();
    stopPoller();

    // Advance well past all timeouts and intervals
    vi.advanceTimersByTime(10 * 60 * 1000);
    // The setTimeout may still fire (already scheduled), but the interval should not repeat
    // The key assertion is no unhandled fetch after stop
    // Since we stopped before the 30s delay, no fetch at all
    expect(fetch).not.toHaveBeenCalled();
  });
});
