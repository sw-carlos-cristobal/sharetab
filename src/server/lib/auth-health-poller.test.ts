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

const mockCheckOpenAICodexHealth = vi.fn();
vi.mock("./openai-codex-login", () => ({
  checkOpenAICodexHealth: mockCheckOpenAICodexHealth,
}));

const mockGetStoredMeridianTokenExpiry = vi.fn();
const mockRefreshIfNeeded = vi.fn();
vi.mock("./meridian-login", () => ({
  getStoredMeridianTokenExpiry: mockGetStoredMeridianTokenExpiry,
  refreshIfNeeded: mockRefreshIfNeeded,
}));

import nodemailer from "nodemailer";

function mockTransporter(sendMail: ReturnType<typeof vi.fn>) {
  return {
    sendMail,
  } as unknown as ReturnType<typeof nodemailer.createTransport>;
}

describe("MeridianHealthPoller", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env = {
      ...originalEnv,
      AI_PROVIDER_PRIORITY: "meridian,ocr",
      MERIDIAN_PORT: "3457",
      ADMIN_EMAIL: "admin@test.com",
      EMAIL_SERVER_HOST: "smtp.test.com",
      EMAIL_SERVER_PORT: "587",
      EMAIL_FROM: "noreply@test.com",
      NEXTAUTH_URL: "http://localhost:3000",
    };
    vi.stubGlobal("fetch", vi.fn());
    mockCheckOpenAICodexHealth.mockReset();
    mockCheckOpenAICodexHealth.mockResolvedValue({ status: "not_authenticated" });
    mockGetStoredMeridianTokenExpiry.mockReset();
    mockGetStoredMeridianTokenExpiry.mockReturnValue(null);
    mockRefreshIfNeeded.mockReset();
    mockRefreshIfNeeded.mockResolvedValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("checkMeridianHealth returns healthy when health + probe succeed", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_1", content: [] }), { status: 200 })
      );

    const { checkMeridianHealth } = await import("./auth-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("healthy");
    expect(result.email).toBe("user@test.com");
  });

  test("checkMeridianHealth returns unhealthy when health reports unhealthy", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: "unhealthy",
        error: "Not logged in. Run: claude login",
      }), { status: 503 })
    );

    const { checkMeridianHealth } = await import("./auth-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("unhealthy");
    expect(result.error).toBe("Not logged in. Run: claude login");
  });

  test("checkMeridianHealth returns unhealthy when health is ok but probe gets auth error", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "Claude authentication expired" },
        }), { status: 401 })
      );

    const { checkMeridianHealth } = await import("./auth-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("unhealthy");
    expect(result.error).toBe("Claude authentication expired");
  });

  test("checkMeridianHealth returns healthy on non-auth API errors (rate limit, etc.)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Too many requests" },
        }), { status: 429 })
      );

    const { checkMeridianHealth } = await import("./auth-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("healthy");
  });

  test("checkMeridianHealth returns not_running on fetch error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const { checkMeridianHealth } = await import("./auth-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("not_running");
  });

  test("checkMeridianHealth returns degraded when probe times out", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockRejectedValueOnce(new Error("AbortError: signal timed out"));

    const { checkMeridianHealth } = await import("./auth-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("degraded");
    expect(result.error).toBe("Auth verification probe timed out");
  });

  test("checkMeridianHealth caches healthy probe results for repeated callers", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_1", content: [] }), { status: 200 })
      );

    const { checkMeridianHealth } = await import("./auth-health-poller");
    const first = await checkMeridianHealth();
    const second = await checkMeridianHealth();

    expect(first.status).toBe("healthy");
    expect(second.status).toBe("healthy");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("checkMeridianHealth force option bypasses cache", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_1", content: [] }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_2", content: [] }), { status: 200 })
      );

    const { checkMeridianHealth } = await import("./auth-health-poller");
    await checkMeridianHealth();
    await checkMeridianHealth({ force: true });

    expect(fetch).toHaveBeenCalledTimes(4);
  });

  test("checkMeridianHealth keeps healthy result cached for four hours when token expiry is far away", async () => {
    mockGetStoredMeridianTokenExpiry.mockReturnValue(Date.now() + 12 * 60 * 60 * 1000);

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_1", content: [] }), { status: 200 })
      );

    const { checkMeridianHealth } = await import("./auth-health-poller");
    await checkMeridianHealth();
    vi.advanceTimersByTime(3 * 60 * 60 * 1000 + 59 * 60 * 1000);
    await checkMeridianHealth();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("checkMeridianHealth refreshes healthy result every five minutes when token is near expiry", async () => {
    mockGetStoredMeridianTokenExpiry.mockReturnValue(Date.now() + 10 * 60 * 1000);

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_1", content: [] }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_2", content: [] }), { status: 200 })
      );

    const { checkMeridianHealth } = await import("./auth-health-poller");
    await checkMeridianHealth();
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    await checkMeridianHealth();

    expect(fetch).toHaveBeenCalledTimes(4);
  });

  test("sendAuthExpiryEmail sends email with correct content", async () => {
    const mockSendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue(mockTransporter(mockSendMail));

    const { sendAuthExpiryEmail } = await import("./auth-health-poller");
    await sendAuthExpiryEmail("Not logged in. Run: claude login");

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe("admin@test.com");
    expect(call.subject).toContain("Claude AI authentication expired");
  });

  test("sendAuthExpiryEmail skips when email is not configured", async () => {
    delete process.env.EMAIL_SERVER_HOST;
    const mockSendMail = vi.fn();
    vi.mocked(nodemailer.createTransport).mockReturnValue(mockTransporter(mockSendMail));

    const { sendAuthExpiryEmail } = await import("./auth-health-poller");
    await sendAuthExpiryEmail("error");

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("shouldSendEmail returns true on first unhealthy with 'once' interval", async () => {
    const { shouldSendEmail } = await import("./auth-health-poller");
    const result = await shouldSendEmail(null, "once");
    expect(result).toBe(true);
  });

  test("shouldSendEmail returns false on second unhealthy with 'once' interval", async () => {
    const { shouldSendEmail } = await import("./auth-health-poller");
    const now = Date.now();
    const result = await shouldSendEmail(now - 60_000, "once");
    expect(result).toBe(false);
  });

  test("shouldSendEmail returns true when interval has elapsed", async () => {
    const { shouldSendEmail } = await import("./auth-health-poller");
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const result = await shouldSendEmail(twoHoursAgo, "1h");
    expect(result).toBe(true);
  });

  test("shouldSendEmail returns false when interval has not elapsed", async () => {
    const { shouldSendEmail } = await import("./auth-health-poller");
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    const result = await shouldSendEmail(thirtyMinutesAgo, "1h");
    expect(result).toBe(false);
  });

  test("sendAuthExpiryEmail includes login URL in email when provided", async () => {
    const mockSendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue(mockTransporter(mockSendMail));

    const { sendAuthExpiryEmail } = await import("./auth-health-poller");
    await sendAuthExpiryEmail("Auth expired", "https://claude.ai/oauth/authorize?code=true");

    const call = mockSendMail.mock.calls[0][0];
    expect(call.text).toContain("https://claude.ai/oauth/authorize?code=true");
    expect(call.html).toContain("https://claude.ai/oauth/authorize?code=true");
  });

  test("sendAuthExpiryEmail skips when ADMIN_EMAIL is not set", async () => {
    delete process.env.ADMIN_EMAIL;
    const mockSendMail = vi.fn();
    vi.mocked(nodemailer.createTransport).mockReturnValue(mockTransporter(mockSendMail));

    const { sendAuthExpiryEmail } = await import("./auth-health-poller");
    const sent = await sendAuthExpiryEmail("error");

    expect(sent).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("checkMeridianHealth returns degraded when health reports degraded and probe succeeds", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "degraded",
          error: "Could not verify auth status",
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_1", content: [] }), { status: 200 })
      );

    const { checkMeridianHealth } = await import("./auth-health-poller");
    const result = await checkMeridianHealth();
    // Probe succeeded so auth is fine, but health said degraded — trust the healthy probe
    expect(result.status).toBe("healthy");
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
      AI_PROVIDER_PRIORITY: "meridian,ocr",
      MERIDIAN_PORT: "3457",
      ADMIN_EMAIL: "admin@test.com",
      EMAIL_SERVER_HOST: "smtp.test.com",
      EMAIL_SERVER_PORT: "587",
      EMAIL_FROM: "noreply@test.com",
      NEXTAUTH_URL: "http://localhost:3000",
    };
    vi.stubGlobal("fetch", vi.fn());
    mockCheckOpenAICodexHealth.mockReset();
    mockCheckOpenAICodexHealth.mockResolvedValue({ status: "not_authenticated" });
    mockGetStoredMeridianTokenExpiry.mockReset();
    mockGetStoredMeridianTokenExpiry.mockReturnValue(null);
    mockRefreshIfNeeded.mockReset();
    mockRefreshIfNeeded.mockResolvedValue(false);
    mockSendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue(mockTransporter(mockSendMail));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mockHealthy() {
    // /health reports healthy + probe succeeds
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_1", content: [] }), { status: 200 })
      );
  }

  function mockUnhealthy(error = "Not logged in. Run: claude login") {
    // /health reports healthy but probe returns auth error
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: error },
        }), { status: 401 })
      );
  }

  function mockNotRunning() {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
  }

  test("sends email on first unhealthy even if never seen healthy (auth expired on startup)", async () => {
    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    // First tick: proxy is running but auth is expired — should alert immediately
    mockUnhealthy();
    mockUnhealthy(); // re-check after refresh attempt
    await _pollTick();

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][0].subject).toContain("Claude AI authentication expired");
  });

  test("does not send email on first not_running (startup grace period)", async () => {
    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    // First tick: proxy not running yet (still booting) — no alert
    mockNotRunning();
    await _pollTick();

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("sends email on transition from healthy to unhealthy", async () => {
    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    // Tick 1: healthy (establishes baseline)
    mockHealthy();
    await _pollTick();
    expect(mockSendMail).not.toHaveBeenCalled();

    // Tick 2: unhealthy — should send email
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    mockUnhealthy();
    mockUnhealthy(); // re-check after refresh attempt
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][0].subject).toContain("Claude AI authentication expired");
  });

  test("does not send duplicate email with 'once' interval", async () => {
    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    // Tick 1: healthy
    mockHealthy();
    await _pollTick();

    // Tick 2: unhealthy — sends email
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    mockUnhealthy();
    mockUnhealthy(); // re-check
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Tick 3: still unhealthy — should NOT send again (default is "once")
    mockUnhealthy();
    mockUnhealthy(); // re-check
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  test("sends reminder email when interval elapses with '1h' setting", async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: "meridianNotifyInterval", value: "1h" });

    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    // Tick 1: healthy
    mockHealthy();
    await _pollTick();

    // Tick 2: unhealthy — sends first email
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    mockUnhealthy();
    mockUnhealthy(); // re-check
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Tick 3: still unhealthy, but only 5 min later — should NOT send
    vi.advanceTimersByTime(5 * 60 * 1000);
    mockUnhealthy();
    mockUnhealthy(); // re-check
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Tick 4: still unhealthy, 1 hour later — should send reminder
    vi.advanceTimersByTime(55 * 60 * 1000); // total 60 min
    mockUnhealthy();
    mockUnhealthy(); // re-check
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  test("resets email state on recovery, sends again on next incident", async () => {
    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    // Tick 1: healthy
    mockHealthy();
    await _pollTick();

    // Tick 2: unhealthy — sends email
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    mockUnhealthy();
    mockUnhealthy(); // re-check
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Tick 3: recovered — resets incident
    vi.advanceTimersByTime(30 * 1000 + 1);
    mockHealthy();
    await _pollTick();

    // Tick 4: unhealthy again — should send a NEW email
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    mockUnhealthy("Token revoked");
    mockUnhealthy("Token revoked"); // re-check
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(mockSendMail.mock.calls[1][0].text).toContain("Token revoked");
  });

  test("does not send email when Meridian is not_running after healthy", async () => {
    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    // Tick 1: healthy
    mockHealthy();
    await _pollTick();

    // Tick 2: not_running (connection refused) — not "unhealthy", no email
    mockNotRunning();
    await _pollTick();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("startPoller does nothing when meridian is not configured", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai,ocr";
    const { startPoller, stopPoller } = await import("./auth-health-poller");

    startPoller();
    // No tick should happen — advance time past the 30s delay + poll interval
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(fetch).not.toHaveBeenCalled();

    stopPoller();
  });

  test("startPoller runs when meridian is configured in AI_PROVIDER_PRIORITY", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai-codex,meridian,ocr";
    const { startPoller, stopPoller } = await import("./auth-health-poller");

    // first delayed tick after 30s, then poll interval continues
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_1", content: [] }), { status: 200 })
      );

    startPoller();
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();

    expect(fetch).toHaveBeenCalled();

    stopPoller();
  });

  test("poller reuses a warm healthy Meridian result when token expiry is far away", async () => {
    mockGetStoredMeridianTokenExpiry.mockReturnValue(Date.now() + 12 * 60 * 60 * 1000);

    const { checkMeridianHealth, _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_1", content: [] }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: "healthy",
          auth: { loggedIn: true, email: "user@test.com" },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg_2", content: [] }), { status: 200 })
      );

    await checkMeridianHealth();
    await _pollTick();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("sends auth expiry email when openai-codex token expires", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai-codex,ocr";
    mockCheckOpenAICodexHealth.mockResolvedValueOnce({
      status: "auth_expired",
      email: "user@test.com",
      planType: "plus",
      accountId: "acc_123",
      error: "Stored ChatGPT OAuth token expired and refresh failed.",
    });

    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();
    await _pollTick();

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.subject).toContain("ChatGPT OAuth (OpenAI Codex) authentication expired");
  });

  test("does not send openai-codex email before first healthy state", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai-codex,ocr";
    mockCheckOpenAICodexHealth.mockResolvedValueOnce({
      status: "not_authenticated",
    });

    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();
    await _pollTick();

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("does not send openai-codex email for degraded backend status", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai-codex,ocr";
    mockCheckOpenAICodexHealth.mockResolvedValueOnce({
      status: "degraded",
      error: "Codex backend returned HTTP 503.",
    });

    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();
    await _pollTick();

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("startPoller does not fetch before 30s delay", async () => {
    const { startPoller, stopPoller } = await import("./auth-health-poller");

    startPoller();

    // Before 30s — no fetch should have happened
    vi.advanceTimersByTime(20_000);
    expect(fetch).not.toHaveBeenCalled();

    stopPoller();
  });

  test("stopPoller prevents future ticks", async () => {
    const { startPoller, stopPoller } = await import("./auth-health-poller");

    startPoller();
    stopPoller();

    // Advance well past all timeouts and intervals
    vi.advanceTimersByTime(10 * 60 * 1000);
    // The setTimeout may still fire (already scheduled), but the interval should not repeat
    // The key assertion is no unhandled fetch after stop
    // Since we stopped before the 30s delay, no fetch at all
    expect(fetch).not.toHaveBeenCalled();
  });

  test("auto-refreshes on unhealthy, re-verifies health, and skips email if recovered", async () => {
    mockRefreshIfNeeded.mockResolvedValue(true);

    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    // Tick 1: healthy (establishes baseline)
    mockHealthy();
    await _pollTick();

    // Tick 2: unhealthy — force-refresh + re-check returns healthy
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    mockUnhealthy();
    mockHealthy(); // re-check after refresh succeeds
    await _pollTick();

    expect(mockRefreshIfNeeded).toHaveBeenCalledWith({ force: true });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("sends email when re-check still unhealthy after refresh", async () => {
    mockRefreshIfNeeded.mockResolvedValue(false);

    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    // Tick 1: healthy
    mockHealthy();
    await _pollTick();

    // Tick 2: unhealthy — refresh + re-check still unhealthy
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    mockUnhealthy();
    mockUnhealthy(); // re-check also unhealthy
    await _pollTick();

    expect(mockRefreshIfNeeded).toHaveBeenCalledWith({ force: true });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  test("clears email suppression state after successful auto-refresh recovery", async () => {
    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    // Tick 1: healthy baseline
    mockHealthy();
    await _pollTick();

    // Tick 2: unhealthy — refresh fails, sends first email
    mockRefreshIfNeeded.mockResolvedValue(false);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    mockUnhealthy();
    mockUnhealthy(); // re-check still unhealthy
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Tick 3: unhealthy — refresh succeeds, re-check healthy, clears suppression
    mockRefreshIfNeeded.mockResolvedValue(true);
    vi.advanceTimersByTime(30 * 1000 + 1);
    mockUnhealthy();
    mockHealthy(); // re-check now healthy
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    // Tick 4: unhealthy again — refresh fails, should send email again
    // Advance past healthy cache TTL (15 min) so checkMeridianHealth re-fetches
    mockRefreshIfNeeded.mockResolvedValue(false);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    mockUnhealthy();
    mockUnhealthy(); // re-check still unhealthy
    await _pollTick();
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });

  test("proactively force-refreshes token when healthy but near expiry", async () => {
    mockRefreshIfNeeded.mockResolvedValue(true);
    mockGetStoredMeridianTokenExpiry.mockReturnValue(Date.now() + 10 * 60 * 1000);

    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    mockHealthy();
    await _pollTick();

    expect(mockRefreshIfNeeded).toHaveBeenCalledWith({ force: true });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("does not proactively refresh when token expiry is far away", async () => {
    mockGetStoredMeridianTokenExpiry.mockReturnValue(Date.now() + 12 * 60 * 60 * 1000);

    const { _pollTick, _resetPollerState } = await import("./auth-health-poller");
    _resetPollerState();

    mockHealthy();
    await _pollTick();

    expect(mockRefreshIfNeeded).not.toHaveBeenCalled();
  });
});
