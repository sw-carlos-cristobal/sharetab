import { type Page, expect, request } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:3001";

// Demo users from seed.ts
export const users = {
  alice: { email: "alice@example.com", password: "password123", name: "Alice Johnson" },
  bob: { email: "bob@example.com", password: "password123", name: "Bob Smith" },
  charlie: { email: "charlie@example.com", password: "password123", name: "Charlie Brown" },
};

/**
 * Login as a user via the UI.
 */
export async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard", { timeout: 15000 });
}

/**
 * Register a new user via the UI.
 */
export async function register(page: Page, name: string, email: string, password: string) {
  await page.goto("/register");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/dashboard", { timeout: 15000 });
}

/**
 * Generate a unique email for test isolation.
 */
export function uniqueEmail(prefix = "test") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
}

/**
 * Get an authenticated API request context for a user.
 */
export async function authedContext(email: string, password: string) {
  const ctx = await request.newContext({ baseURL: BASE });
  const csrfRes = await ctx.get("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  await ctx.post("/api/auth/callback/credentials", {
    form: { email, password, csrfToken },
    maxRedirects: 0,
  });
  return ctx;
}

/**
 * Call a tRPC mutation.
 */
export async function trpcMutation(
  ctx: Awaited<ReturnType<typeof request.newContext>>,
  proc: string,
  input: unknown
) {
  return ctx.post(`/api/trpc/${proc}`, { data: { json: input } });
}

/**
 * Call a tRPC query (batched format).
 */
export async function trpcQuery(
  ctx: Awaited<ReturnType<typeof request.newContext>>,
  proc: string,
  input?: unknown
) {
  const inputStr = input
    ? encodeURIComponent(JSON.stringify({ "0": { json: input } }))
    : encodeURIComponent(
        JSON.stringify({ "0": { json: null, meta: { values: ["undefined"], v: 1 } } })
      );
  return ctx.get(`/api/trpc/${proc}?batch=1&input=${inputStr}`);
}

/**
 * Extract the first result from a tRPC batch response.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function trpcResult(res: { json: () => Promise<any> }): Promise<any> {
  const body = await res.json();
  return body[0]?.result?.data?.json;
}

/**
 * Extract the error from a tRPC response (mutation or batch query).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function trpcError(res: { json: () => Promise<any> }): Promise<any> {
  const body = await res.json();
  // Mutation format
  if (body.error) return body.error.json;
  // Batch query format
  if (body[0]?.error) return body[0].error.json;
  return null;
}

/**
 * Create an isolated group with specified members and return IDs.
 */
export async function createTestGroup(
  ownerEmail: string,
  ownerPassword: string,
  memberEmails: { email: string; password: string }[],
  groupName?: string
) {
  const owner = await authedContext(ownerEmail, ownerPassword);
  const createRes = await trpcMutation(owner, "groups.create", {
    name: groupName ?? `Test-${Date.now()}`,
  });
  const group = (await createRes.json()).result?.data?.json;
  const groupId = group.id;

  const memberContexts: Awaited<ReturnType<typeof authedContext>>[] = [];
  for (const m of memberEmails) {
    const invRes = await trpcMutation(owner, "groups.createInvite", { groupId });
    const token = (await invRes.json()).result?.data?.json?.token;
    const mCtx = await authedContext(m.email, m.password);
    await trpcMutation(mCtx, "groups.joinByInvite", { token });
    memberContexts.push(mCtx);
  }

  // Get member IDs
  const detailRes = await trpcQuery(owner, "groups.get", { groupId });
  const detail = await trpcResult(detailRes);
  const memberIds: Record<string, string> = {};
  for (const m of detail.members) {
    memberIds[m.user.email] = m.user.id;
  }

  return { owner, memberContexts, groupId, memberIds, dispose: async () => {
    await owner.dispose();
    for (const c of memberContexts) await c.dispose();
  }};
}
