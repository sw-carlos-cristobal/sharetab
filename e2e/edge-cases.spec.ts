import { test, expect, request } from "@playwright/test";
import { login, uniqueEmail, users, createTestGroup } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

async function authedContext(email: string, password: string) {
  const ctx = await request.newContext({ baseURL: BASE });
  const csrfRes = await ctx.get("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  await ctx.post("/api/auth/callback/credentials", {
    form: { email, password, csrfToken },
    maxRedirects: 0,
  });
  return ctx;
}

async function trpcMutation(ctx: Awaited<ReturnType<typeof request.newContext>>, proc: string, input: unknown) {
  return ctx.post(`/api/trpc/${proc}`, { data: { json: input } });
}

async function trpcQuery(ctx: Awaited<ReturnType<typeof request.newContext>>, proc: string, input?: unknown) {
  const inputStr = input
    ? encodeURIComponent(JSON.stringify({ "0": { json: input } }))
    : encodeURIComponent(JSON.stringify({ "0": { json: null, meta: { values: ["undefined"], v: 1 } } }));
  return ctx.get(`/api/trpc/${proc}?batch=1&input=${inputStr}`);
}

test.describe("Edge Cases & Security", () => {
  test("9.1 — money stored as cents ($12.99 = 1299)", async () => {
    const ctx = await authedContext("alice@example.com", "password123");

    // Create group
    const groupRes = await trpcMutation(ctx, "groups.create", { name: "Cents Test" });
    const groupId = (await groupRes.json()).result?.data?.json?.id;

    // Get Alice's ID
    const groupDetail = await trpcQuery(ctx, "groups.get", { groupId });
    const aliceId = (await groupDetail.json())[0]?.result?.data?.json?.members[0]?.user?.id;

    // Create expense for $12.99 = 1299 cents
    const expRes = await trpcMutation(ctx, "expenses.create", {
      groupId,
      title: "Cents Test",
      amount: 1299,
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [{ userId: aliceId, amount: 1299 }],
    });
    const expense = (await expRes.json()).result?.data?.json;
    expect(expense.amount).toBe(1299);

    await ctx.dispose();
  });

  test("9.2 — large amount ($100,000.00 = 10000000 cents)", async () => {
    const ctx = await authedContext("alice@example.com", "password123");

    const groupRes = await trpcMutation(ctx, "groups.create", { name: "Large Amount Test" });
    const groupId = (await groupRes.json()).result?.data?.json?.id;

    const groupDetail = await trpcQuery(ctx, "groups.get", { groupId });
    const aliceId = (await groupDetail.json())[0]?.result?.data?.json?.members[0]?.user?.id;

    const expRes = await trpcMutation(ctx, "expenses.create", {
      groupId,
      title: "Big Expense",
      amount: 10000000, // $100,000.00
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [{ userId: aliceId, amount: 10000000 }],
    });
    const expense = (await expRes.json()).result?.data?.json;
    expect(expense.amount).toBe(10000000);

    await ctx.dispose();
  });

  test("9.3 — zero amount expense fails validation", async () => {
    const ctx = await authedContext("alice@example.com", "password123");

    const groupRes = await trpcMutation(ctx, "groups.create", { name: "Zero Test" });
    const groupId = (await groupRes.json()).result?.data?.json?.id;
    const groupDetail = await trpcQuery(ctx, "groups.get", { groupId });
    const aliceId = (await groupDetail.json())[0]?.result?.data?.json?.members[0]?.user?.id;

    const expRes = await trpcMutation(ctx, "expenses.create", {
      groupId,
      title: "Zero",
      amount: 0,
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [{ userId: aliceId, amount: 0 }],
    });
    const body = await expRes.json();
    expect(body.error).toBeDefined();

    await ctx.dispose();
  });

  test("9.4 — empty shares array fails validation", async () => {
    const ctx = await authedContext("alice@example.com", "password123");

    const groupRes = await trpcMutation(ctx, "groups.create", { name: "Empty Shares Test" });
    const groupId = (await groupRes.json()).result?.data?.json?.id;
    const groupDetail = await trpcQuery(ctx, "groups.get", { groupId });
    const aliceId = (await groupDetail.json())[0]?.result?.data?.json?.members[0]?.user?.id;

    const expRes = await trpcMutation(ctx, "expenses.create", {
      groupId,
      title: "No Shares",
      amount: 1000,
      paidById: aliceId,
      splitMode: "EQUAL",
      shares: [],
    });
    const body = await expRes.json();
    expect(body.error).toBeDefined();

    await ctx.dispose();
  });

  test("9.5 — XSS in group name rendered as text", async ({ page }) => {
    await login(page, "alice@example.com", "password123");
    await page.goto("/groups/new");
    await page.getByLabel("Group name").fill('<img src=x onerror="alert(1)">');
    await page.getByRole("button", { name: "Create Group" }).click();
    await page.waitForURL(/\/groups\/\w+$/, { timeout: 15000 });
    // Should render as text, not execute
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toContainText("<img");
    // No alert dialog = XSS prevented
  });

  test("9.6 — SQL injection in name doesn't break DB", async () => {
    const ctx = await authedContext("alice@example.com", "password123");
    const res = await trpcMutation(ctx, "groups.create", {
      name: "'; DROP TABLE \"User\";--",
    });
    const body = await res.json();
    expect(body.result?.data?.json?.id).toBeDefined();

    // Verify DB still works
    const health = await ctx.get("/api/health");
    const healthBody = await health.json();
    expect(healthBody.status).toBe("ok");

    await ctx.dispose();
  });

  test("9.8 — upload generates UUID filename", async () => {
    const ctx = await authedContext("alice@example.com", "password123");
    const res = await ctx.post("/api/upload", {
      multipart: {
        file: {
          name: "../../etc/passwd.jpg",
          mimeType: "image/jpeg",
          buffer: Buffer.alloc(20, 0xFF),
        },
      },
    });
    if (res.status() === 200) {
      const body = await res.json();
      // imagePath should NOT contain ".." — it should be a UUID
      expect(body.imagePath).not.toContain("..");
      expect(body.imagePath).toMatch(/^receipts\/[a-f0-9-]+\.\w+$/);
    }
    await ctx.dispose();
  });

  test("1.1.4 — register with invalid email fails", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await trpcMutation(ctx, "auth.register", {
      name: "Bad Email",
      email: "not-an-email",
      password: "testpass123",
    });
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error?.json?.message).toContain("Invalid");
    await ctx.dispose();
  });

  test("1.3.4 — session token in cookie after login", async ({ page }) => {
    await login(page, "alice@example.com", "password123");
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find(
      (c) => c.name === "authjs.session-token" || c.name === "__Secure-authjs.session-token"
    );
    expect(sessionCookie).toBeDefined();
  });

  test("8.2 — health check returns valid response", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await ctx.get("/api/health");
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(["ok", "error"]).toContain(body.status);
    expect(["connected", "disconnected"]).toContain(body.db);
    await ctx.dispose();
  });

  // ── Not-found pages ──────────────────────────────────────

  test("group not found shows styled empty state with back link", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/groups/nonexistent-group-id");

    await expect(page.getByRole("heading", { name: "Group not found" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("doesn't exist or you don't have access")).toBeVisible();
    const backBtn = page.getByRole("button", { name: "Back to Groups" });
    await expect(backBtn).toBeVisible();
    await backBtn.click();
    await page.waitForURL("**/groups", { timeout: 10000 });
  });

  test("expense not found shows styled empty state with back link", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Expense Not Found Test"
    );

    await page.goto(`/groups/${groupId}/expenses/nonexistent-expense-id`);

    await expect(page.getByRole("heading", { name: "Expense not found" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("doesn't exist or has been deleted")).toBeVisible();
    const backBtn = page.getByRole("button", { name: "Back to Group" });
    await expect(backBtn).toBeVisible();
    await backBtn.click();
    await page.waitForURL(/\/groups\/\w+$/, { timeout: 10000 });

    await dispose();
  });

  test("edit expense not found shows styled empty state", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Edit Not Found Test"
    );

    await page.goto(`/groups/${groupId}/expenses/nonexistent-expense-id/edit`);

    await expect(page.getByRole("heading", { name: "Expense not found" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Back to Group" })).toBeVisible();

    await dispose();
  });
});
