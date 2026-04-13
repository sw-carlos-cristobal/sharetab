import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/server/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("MeridianLoginManager", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env = { ...originalEnv, CLAUDE_DIR: "/tmp/test-claude", NEXTAUTH_URL: "http://localhost:3000" };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("isLoginInProgress returns false initially", async () => {
    const { isLoginInProgress } = await import("./meridian-login");
    expect(isLoginInProgress()).toBe(false);
  });

  test("startLogin returns an OAuth URL with PKCE params", async () => {
    const { startLogin, cancelLogin } = await import("./meridian-login");
    const url = await startLogin();
    expect(url).toContain("https://claude.com/cai/oauth/authorize");
    expect(url).toContain("code_challenge=");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("client_id=");
    expect(url).toContain("response_type=code");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fplatform.claude.com");
    expect(url).not.toContain("code=true");
    cancelLogin();
  });

  test("startLogin sets loginInProgress", async () => {
    const { startLogin, isLoginInProgress, cancelLogin } = await import("./meridian-login");
    await startLogin();
    expect(isLoginInProgress()).toBe(true);
    cancelLogin();
  });

  test("startLogin throws if login already in progress", async () => {
    const { startLogin, cancelLogin } = await import("./meridian-login");
    await startLogin();
    expect(() => startLogin()).toThrow("A login is already in progress");
    cancelLogin();
  });

  test("submitCode exchanges code for tokens and saves credentials", async () => {
    const mockWriteFileSync = vi.fn();
    vi.doMock("fs", () => ({
      unlinkSync: vi.fn(),
      writeFileSync: mockWriteFileSync,
    }));

    const { startLogin, submitCode } = await import("./meridian-login");
    await startLogin();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: "sk-ant-oat01-test-access",
        refresh_token: "sk-ant-ort01-test-refresh",
        expires_in: 3600,
      }), { status: 200 })
    );

    const result = await submitCode("test-auth-code");
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(opts?.method).toBe("POST");
    expect(opts?.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(opts?.body as string);
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("test-auth-code");
    expect(body.code_verifier).toBeDefined();

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.claudeAiOauth.accessToken).toBe("sk-ant-oat01-test-access");
    expect(written.claudeAiOauth.refreshToken).toBe("sk-ant-ort01-test-refresh");
  });

  test("submitCode returns error on token exchange failure", async () => {
    const { startLogin, submitCode, isLoginInProgress } = await import("./meridian-login");
    await startLogin();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("invalid_grant", { status: 400 })
    );

    const result = await submitCode("bad-code");
    expect(result.success).toBe(false);
    expect(result.error).toContain("400");
    expect(isLoginInProgress()).toBe(false);
  });

  test("submitCode throws if no login in progress", async () => {
    const { submitCode } = await import("./meridian-login");
    await expect(submitCode("code")).rejects.toThrow("No login in progress");
  });

  test("cancelLogin clears state", async () => {
    const { startLogin, cancelLogin, isLoginInProgress } = await import("./meridian-login");
    await startLogin();
    expect(isLoginInProgress()).toBe(true);
    cancelLogin();
    expect(isLoginInProgress()).toBe(false);
  });

  test("logout clears pending login and removes credentials", async () => {
    const mockUnlinkSync = vi.fn();
    vi.doMock("fs", () => ({
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: mockUnlinkSync,
    }));

    const { startLogin, isLoginInProgress, logout } = await import("./meridian-login");
    await startLogin();
    expect(isLoginInProgress()).toBe(true);

    const result = logout();
    expect(result.success).toBe(true);
    expect(isLoginInProgress()).toBe(false);
    expect(mockUnlinkSync.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("logout succeeds when credentials file is already absent", async () => {
    vi.doMock("fs", () => ({
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: () => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    }));

    const { logout } = await import("./meridian-login");
    expect(logout()).toEqual({ success: true });
  });

  test("refreshIfNeeded refreshes expired token", async () => {
    const expiredCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "test-refresh-token",
        expiresAt: Date.now() - 1000, // expired
      },
    });

    const mockWriteFileSync = vi.fn();
    vi.doMock("fs", () => ({
      readFileSync: () => expiredCreds,
      writeFileSync: mockWriteFileSync,
      unlinkSync: vi.fn(),
    }));

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }), { status: 200 })
    );

    const { refreshIfNeeded } = await import("./meridian-login");
    const result = await refreshIfNeeded();
    expect(result).toBe(true);

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    const body = JSON.parse(opts?.body as string);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("test-refresh-token");

    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written.claudeAiOauth.accessToken).toBe("new-access");
    expect(written.claudeAiOauth.refreshToken).toBe("new-refresh");
  });

  test("refreshIfNeeded skips if token still valid", async () => {
    const validCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: "valid-access",
        refreshToken: "test-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
      },
    });

    vi.doMock("fs", () => ({
      readFileSync: () => validCreds,
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    const { refreshIfNeeded } = await import("./meridian-login");
    const result = await refreshIfNeeded();
    expect(result).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("refreshIfNeeded returns false with no credentials file", async () => {
    vi.doMock("fs", () => ({
      readFileSync: () => { throw new Error("ENOENT"); },
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));

    const { refreshIfNeeded } = await import("./meridian-login");
    const result = await refreshIfNeeded();
    expect(result).toBe(false);
  });

  test("parseOAuthUrl extracts URL from text", async () => {
    const { parseOAuthUrl } = await import("./meridian-login");
    expect(parseOAuthUrl("visit: https://claude.ai/oauth?foo=bar\n")).toBe("https://claude.ai/oauth?foo=bar");
    expect(parseOAuthUrl("visit: https://claude.com/cai/oauth?x=1")).toBe("https://claude.com/cai/oauth?x=1");
    expect(parseOAuthUrl("visit: https://platform.claude.com/oauth?y=2")).toBe("https://platform.claude.com/oauth?y=2");
    expect(parseOAuthUrl("no url")).toBeNull();
  });
});
