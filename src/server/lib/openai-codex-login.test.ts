import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/server/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("OpenAICodexLogin", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env = { ...originalEnv, OPENAI_CODEX_DIR: "/tmp/test-chatgpt" };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("startLogin returns an OAuth URL with Codex params", async () => {
    const { startLogin, cancelLogin } = await import("./openai-codex-login");
    const url = await startLogin();
    expect(url).toContain("https://auth.openai.com/oauth/authorize");
    expect(url).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url).toContain("code_challenge=");
    expect(url).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback");
    expect(url).toContain("codex_cli_simplified_flow=true");
    cancelLogin();
  });

  test("submitCode exchanges code and saves auth file", async () => {
    const mockWriteFileSync = vi.fn();
    vi.doMock("fs", () => ({
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: mockWriteFileSync,
      unlinkSync: vi.fn(),
    }));

    const { startLogin, submitCode } = await import("./openai-codex-login");
    await startLogin();

    const jwt = [
      "header",
      Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/profile": { email: "test@example.com" },
        "https://api.openai.com/auth": {
          chatgpt_plan_type: "plus",
          chatgpt_account_id: "acct_123",
        },
      })).toString("base64url"),
      "sig",
    ].join(".");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        id_token: jwt,
        access_token: jwt,
        refresh_token: "refresh-123",
      }), { status: 200 })
    );

    const result = await submitCode("abc");
    expect(result.success).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(saved.auth_mode).toBe("Chatgpt");
    expect(saved.tokens.account_id).toBe("acct_123");
  });

  test("refreshIfNeeded refreshes expired auth", async () => {
    const expired = [
      "header",
      Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) - 60,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
      })).toString("base64url"),
      "sig",
    ].join(".");
    const fresh = [
      "header",
      Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
      })).toString("base64url"),
      "sig",
    ].join(".");

    const mockWriteFileSync = vi.fn();
    vi.doMock("fs", () => ({
      mkdirSync: vi.fn(),
      readFileSync: () => JSON.stringify({
        auth_mode: "Chatgpt",
        tokens: {
          id_token: expired,
          access_token: expired,
          refresh_token: "refresh-old",
          account_id: "acct_123",
        },
      }),
      writeFileSync: mockWriteFileSync,
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        id_token: fresh,
        access_token: fresh,
        refresh_token: "refresh-new",
      }), { status: 200 })
    );

    const { refreshIfNeeded } = await import("./openai-codex-login");
    expect(await refreshIfNeeded()).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
      originator: "codex_cli_rs",
    });
    expect(init?.body).toBeInstanceOf(URLSearchParams);
  });

  test("checkOpenAICodexHealth returns degraded for backend outages", async () => {
    const jwt = [
      "header",
      Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
      })).toString("base64url"),
      "sig",
    ].join(".");

    vi.doMock("fs", () => ({
      mkdirSync: vi.fn(),
      readFileSync: () => JSON.stringify({
        auth_mode: "Chatgpt",
        tokens: {
          id_token: jwt,
          access_token: jwt,
          refresh_token: "refresh-token",
          account_id: "acct_123",
        },
      }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const { checkOpenAICodexHealth } = await import("./openai-codex-login");
    await expect(checkOpenAICodexHealth()).resolves.toMatchObject({
      status: "degraded",
      error: "connect ECONNREFUSED",
      accountId: "acct_123",
    });
  });

  test("checkOpenAICodexHealth caches healthy result for four hours on long-lived tokens", async () => {
    const jwt = [
      "header",
      Buffer.from(JSON.stringify({
        exp: Math.floor((Date.now() + 12 * 60 * 60 * 1000) / 1000),
        "https://api.openai.com/profile": { email: "test@example.com" },
        "https://api.openai.com/auth": {
          chatgpt_plan_type: "plus",
          chatgpt_account_id: "acct_123",
        },
      })).toString("base64url"),
      "sig",
    ].join(".");

    vi.doMock("fs", () => ({
      mkdirSync: vi.fn(),
      readFileSync: () => JSON.stringify({
        auth_mode: "Chatgpt",
        tokens: {
          id_token: jwt,
          access_token: jwt,
          refresh_token: "refresh-token",
          account_id: "acct_123",
        },
      }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch).mockResolvedValueOnce(new Response("[]", { status: 200 }));

    const { checkOpenAICodexHealth } = await import("./openai-codex-login");
    await checkOpenAICodexHealth();
    vi.advanceTimersByTime(3 * 60 * 60 * 1000 + 59 * 60 * 1000);
    await checkOpenAICodexHealth();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("checkOpenAICodexHealth refreshes cache every five minutes when token is near expiry", async () => {
    const jwt = [
      "header",
      Buffer.from(JSON.stringify({
        exp: Math.floor((Date.now() + 10 * 60 * 1000) / 1000),
        "https://api.openai.com/profile": { email: "test@example.com" },
        "https://api.openai.com/auth": {
          chatgpt_plan_type: "plus",
          chatgpt_account_id: "acct_123",
        },
      })).toString("base64url"),
      "sig",
    ].join(".");

    vi.doMock("fs", () => ({
      mkdirSync: vi.fn(),
      readFileSync: () => JSON.stringify({
        auth_mode: "Chatgpt",
        tokens: {
          id_token: jwt,
          access_token: jwt,
          refresh_token: "refresh-token",
          account_id: "acct_123",
        },
      }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));

    const { checkOpenAICodexHealth } = await import("./openai-codex-login");
    await checkOpenAICodexHealth();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await checkOpenAICodexHealth();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("checkOpenAICodexHealth force option bypasses cache", async () => {
    const jwt = [
      "header",
      Buffer.from(JSON.stringify({
        exp: Math.floor((Date.now() + 12 * 60 * 60 * 1000) / 1000),
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
      })).toString("base64url"),
      "sig",
    ].join(".");

    vi.doMock("fs", () => ({
      mkdirSync: vi.fn(),
      readFileSync: () => JSON.stringify({
        auth_mode: "Chatgpt",
        tokens: {
          id_token: jwt,
          access_token: jwt,
          refresh_token: "refresh-token",
          account_id: "acct_123",
        },
      }),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));

    const { checkOpenAICodexHealth } = await import("./openai-codex-login");
    await checkOpenAICodexHealth();
    await checkOpenAICodexHealth({ force: true });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("logout clears pending login and removes auth file", async () => {
    const mockUnlinkSync = vi.fn();
    vi.doMock("fs", () => ({
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: mockUnlinkSync,
    }));

    const { startLogin, isLoginInProgress, logout } = await import("./openai-codex-login");
    await startLogin();
    expect(isLoginInProgress()).toBe(true);

    const result = logout();
    expect(result.success).toBe(true);
    expect(isLoginInProgress()).toBe(false);
    expect(mockUnlinkSync.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("logout succeeds when auth file is missing", async () => {
    vi.doMock("fs", () => ({
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: () => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    }));

    const { logout } = await import("./openai-codex-login");
    expect(logout()).toEqual({ success: true });
  });
});
