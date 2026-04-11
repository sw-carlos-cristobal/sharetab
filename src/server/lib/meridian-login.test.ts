import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("MeridianLoginManager", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("isLoginInProgress returns false initially", async () => {
    const { isLoginInProgress } = await import("./meridian-login");
    expect(isLoginInProgress()).toBe(false);
  });

  test("parseOAuthUrl extracts URL from stdout", async () => {
    const { parseOAuthUrl } = await import("./meridian-login");
    const stdout = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.ai/oauth/authorize?code=true&client_id=abc\n';
    const url = parseOAuthUrl(stdout);
    expect(url).toBe("https://claude.ai/oauth/authorize?code=true&client_id=abc");
  });

  test("parseOAuthUrl extracts platform.claude.com URL", async () => {
    const { parseOAuthUrl } = await import("./meridian-login");
    const stdout = "visit: https://platform.claude.com/oauth/authorize?foo=bar\nmore text";
    const url = parseOAuthUrl(stdout);
    expect(url).toBe("https://platform.claude.com/oauth/authorize?foo=bar");
  });

  test("parseOAuthUrl returns null when no URL found", async () => {
    const { parseOAuthUrl } = await import("./meridian-login");
    const url = parseOAuthUrl("no url here");
    expect(url).toBeNull();
  });

  test("cancelLogin clears state", async () => {
    const { cancelLogin, isLoginInProgress } = await import("./meridian-login");
    cancelLogin();
    expect(isLoginInProgress()).toBe(false);
  });
});
