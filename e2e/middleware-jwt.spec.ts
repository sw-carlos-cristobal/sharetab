import { test, expect, request } from "@playwright/test";

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";

test.describe("Middleware JWT validation", () => {
  test("forged session cookie does not grant access to /dashboard", async () => {
    const ctx = await request.newContext({ baseURL: BASE_URL });

    // Set a forged session cookie — valid cookie name but garbage JWT value
    await ctx.storageState();
    const res = await ctx.get("/en/dashboard", {
      maxRedirects: 0,
      headers: {
        Cookie: "authjs.session-token=forged-jwt-value-that-is-not-valid",
      },
    });

    // Should redirect to /login since the JWT is invalid
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/login");
    await ctx.dispose();
  });

  test("forged __Secure- session cookie does not grant access", async () => {
    const ctx = await request.newContext({ baseURL: BASE_URL });

    const res = await ctx.get("/en/groups", {
      maxRedirects: 0,
      headers: {
        Cookie: "__Secure-authjs.session-token=totally-fake-token-123",
      },
    });

    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/login");
    await ctx.dispose();
  });

  test("expired-looking JWT does not grant access", async () => {
    const ctx = await request.newContext({ baseURL: BASE_URL });

    // A base64-encoded JWT-like string with an expired timestamp
    // This is structurally a JWT but not signed with the server's secret
    const fakeJwt =
      "eyJhbGciOiJIUzI1NiJ9." +
      Buffer.from(
        JSON.stringify({ sub: "fake-user-id", exp: 1000000000, iat: 999999000 })
      ).toString("base64url") +
      ".invalid-signature";

    const res = await ctx.get("/en/settings", {
      maxRedirects: 0,
      headers: {
        Cookie: `authjs.session-token=${fakeJwt}`,
      },
    });

    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/login");
    await ctx.dispose();
  });

  test("no cookie at all redirects to login", async () => {
    const ctx = await request.newContext({ baseURL: BASE_URL });

    const res = await ctx.get("/en/dashboard", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/login");
    await ctx.dispose();
  });

  test("public routes remain accessible without auth", async () => {
    const ctx = await request.newContext({ baseURL: BASE_URL });

    // /login should not redirect
    const loginRes = await ctx.get("/login");
    expect(loginRes.ok()).toBe(true);

    // /split should not redirect (guest feature)
    const splitRes = await ctx.get("/split");
    expect(splitRes.ok()).toBe(true);

    // /api/health should work
    const healthRes = await ctx.get("/api/health");
    expect(healthRes.ok()).toBe(true);

    await ctx.dispose();
  });
});
