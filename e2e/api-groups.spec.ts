import { test, expect, request } from "@playwright/test";
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, deleteTestGroup } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const createdGroupIds: string[] = [];

test.afterAll(async () => {
  const ctx = await authedContext(users.alice.email, users.alice.password);
  for (const id of createdGroupIds) await deleteTestGroup(ctx, id);
  await ctx.dispose();
});

test.describe("Groups API", () => {
  test("2.1.3 — create group without auth returns UNAUTHORIZED", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await trpcMutation(ctx, "groups.create", { name: "Nope" });
    const body = await res.json();
    expect(body.error?.json?.data?.code).toBe("UNAUTHORIZED");
    await ctx.dispose();
  });

  test("2.1.4 — create group with empty name fails validation", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const res = await trpcMutation(ctx, "groups.create", { name: "" });
    const body = await res.json();
    expect(body.error).toBeDefined();
    await ctx.dispose();
  });

  test("2.2.1 — list user's groups", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const res = await trpcQuery(ctx, "groups.list");
    const body = await res.json();
    const groups = body[0]?.result?.data?.json;
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThanOrEqual(2); // Apartment + Japan Trip from seed
    await ctx.dispose();
  });

  test("2.2.3 — get group as non-member returns FORBIDDEN", async () => {
    // Create a group as Alice
    const alice = await authedContext(users.alice.email, users.alice.password);
    const createRes = await trpcMutation(alice, "groups.create", { name: "Private Group" });
    const createBody = await createRes.json();
    const groupId = createBody.result?.data?.json?.id;
    createdGroupIds.push(groupId);

    // Try to access as Charlie (who is not a member of this new group)
    const charlie = await authedContext("charlie@example.com", "password123");
    const res = await trpcQuery(charlie, "groups.get", { groupId });
    const body = await res.json();
    expect(body[0]?.error?.json?.data?.code).toBe("FORBIDDEN");

    await alice.dispose();
    await charlie.dispose();
  });

  test("2.3.2 — member tries update returns FORBIDDEN", async () => {
    // Bob is a MEMBER in Apartment, not OWNER/ADMIN
    const bob = await authedContext(users.bob.email, users.bob.password);
    // Get the apartment group ID from listing
    const listRes = await trpcQuery(bob, "groups.list");
    const listBody = await listRes.json();
    const apartment = listBody[0]?.result?.data?.json?.find((g: { name: string }) => g.name === "Apartment");

    if (apartment) {
      const res = await trpcMutation(bob, "groups.update", { groupId: apartment.id, name: "Hacked" });
      const body = await res.json();
      expect(body.error?.json?.data?.code).toBe("FORBIDDEN");
    }
    await bob.dispose();
  });

  test("2.3.3 — owner deletes group", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    // Create a throwaway group to delete
    const createRes = await trpcMutation(alice, "groups.create", { name: "Delete Me API" });
    const groupId = (await createRes.json()).result?.data?.json?.id;

    const res = await trpcMutation(alice, "groups.delete", { groupId });
    const body = await res.json();
    expect(body.result?.data?.json?.success).toBe(true);
    await alice.dispose();
  });

  test("2.3.4 — non-owner delete returns FORBIDDEN", async () => {
    const bob = await authedContext(users.bob.email, users.bob.password);
    const listRes = await trpcQuery(bob, "groups.list");
    const listBody = await listRes.json();
    const apartment = listBody[0]?.result?.data?.json?.find((g: { name: string }) => g.name === "Apartment");

    if (apartment) {
      const res = await trpcMutation(bob, "groups.delete", { groupId: apartment.id });
      const body = await res.json();
      expect(body.error?.json?.data?.code).toBe("FORBIDDEN");
    }
    await bob.dispose();
  });

  test("2.4.6 — join invite without auth returns UNAUTHORIZED", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await trpcMutation(ctx, "groups.joinByInvite", { token: "fake-token" });
    const body = await res.json();
    expect(body.error?.json?.data?.code).toBe("UNAUTHORIZED");
    await ctx.dispose();
  });
});
