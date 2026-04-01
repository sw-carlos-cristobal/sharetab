import { test, expect } from "@playwright/test";
import {
  users,
  login,
  authedContext,
  trpcQuery,
  trpcMutation,
  trpcResult,
} from "./helpers";

test.describe("Admin audit log", () => {
  test("admin can view audit log section", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Audit Log" })
    ).toBeVisible();
  });

  test("audit log API returns entries", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const res = await trpcQuery(ctx, "admin.getAuditLog", { limit: 10 });
    const data = await trpcResult(res);
    expect(data).toBeDefined();
    expect(data.items).toBeInstanceOf(Array);
    await ctx.dispose();
  });
});

test.describe("User suspend/unsuspend", () => {
  test("admin page shows suspend button for non-admin users", async ({
    page,
  }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    // Look in the User Management section specifically
    const userSection = page.locator("section", {
      has: page.getByRole("heading", { name: "User Management" }),
    });
    const bobRow = userSection.locator("tr", {
      hasText: "bob@example.com",
    });
    await expect(bobRow).toBeVisible();
    // Should have either suspend or unsuspend button
    const hasSuspend = await bobRow.getByTitle("Suspend user").isVisible().catch(() => false);
    const hasUnsuspend = await bobRow.getByTitle("Unsuspend user").isVisible().catch(() => false);
    expect(hasSuspend || hasUnsuspend).toBe(true);
  });

  test("suspend and unsuspend user via API", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Get Bob's user ID
    const listData = await trpcResult(
      await trpcQuery(ctx, "admin.listUsers")
    );
    const bob = listData.users.find(
      (u: { email: string }) => u.email === "bob@example.com"
    );
    expect(bob).toBeDefined();

    // Ensure Bob is not suspended (unsuspend if needed)
    if (bob.isSuspended) {
      const unsRes = await trpcMutation(ctx, "admin.unsuspendUser", {
        userId: bob.id,
      });
      const unsBody = await unsRes.json();
      expect(unsBody.result.data.json.unsuspended).toBe(true);
    }

    // Suspend Bob
    const suspendRes = await trpcMutation(ctx, "admin.suspendUser", {
      userId: bob.id,
    });
    const suspendBody = await suspendRes.json();
    expect(suspendBody.result.data.json.suspended).toBe(true);

    // Verify Bob is now suspended
    const listData2 = await trpcResult(
      await trpcQuery(ctx, "admin.listUsers")
    );
    const bob2 = listData2.users.find(
      (u: { email: string }) => u.email === "bob@example.com"
    );
    expect(bob2.isSuspended).toBe(true);

    // Unsuspend Bob
    const unsuspendRes = await trpcMutation(ctx, "admin.unsuspendUser", {
      userId: bob.id,
    });
    const unsuspendBody = await unsuspendRes.json();
    expect(unsuspendBody.result.data.json.unsuspended).toBe(true);

    await ctx.dispose();
  });
});

test.describe("Registration control", () => {
  test("admin page shows registration control section", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Registration Control" })
    ).toBeVisible();
  });

  test("get and set registration mode via API", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Get current mode
    const getData = await trpcResult(
      await trpcQuery(ctx, "admin.getRegistrationMode")
    );
    const currentMode = getData.mode;

    // Set to invite-only
    const setRes = await trpcMutation(ctx, "admin.setRegistrationMode", {
      mode: "invite-only",
    });
    const setBody = await setRes.json();
    expect(setBody.result.data.json.mode).toBe("invite-only");

    // Restore original mode
    await trpcMutation(ctx, "admin.setRegistrationMode", {
      mode: currentMode,
    });

    await ctx.dispose();
  });

  test("create and revoke system invite via API", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Create invite
    const createRes = await trpcMutation(ctx, "admin.createSystemInvite", {
      label: "Test invite",
      expiresInDays: 7,
    });
    const createBody = await createRes.json();
    const invite = createBody.result.data.json;
    expect(invite.code).toBeDefined();
    expect(invite.label).toBe("Test invite");

    // List invites
    const invites = await trpcResult(
      await trpcQuery(ctx, "admin.listSystemInvites")
    );
    expect(invites.length).toBeGreaterThan(0);

    // Revoke the invite
    const revokeRes = await trpcMutation(ctx, "admin.revokeSystemInvite", {
      inviteId: invite.id,
    });
    const revokeBody = await revokeRes.json();
    expect(revokeBody.result.data.json.revoked).toBe(true);

    await ctx.dispose();
  });
});

test.describe("Announcement banner", () => {
  test("admin page shows announcement section", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Announcement Banner" })
    ).toBeVisible();
  });

  test("set and clear announcement via API", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Set announcement
    const setRes = await trpcMutation(ctx, "admin.setAnnouncement", {
      message: "Test announcement from e2e",
    });
    const setBody = await setRes.json();
    expect(setBody.result.data.json.success).toBe(true);

    // Get announcement
    const getData = await trpcResult(
      await trpcQuery(ctx, "admin.getAnnouncement")
    );
    expect(getData.message).toBe("Test announcement from e2e");

    // Clear announcement
    await trpcMutation(ctx, "admin.setAnnouncement", { message: "" });

    await ctx.dispose();
  });
});

test.describe("Global activity feed", () => {
  test("admin page shows activity feed section", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Global Activity Feed" })
    ).toBeVisible();
  });

  test("global activity API returns data", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const data = await trpcResult(
      await trpcQuery(ctx, "admin.getGlobalActivity", { limit: 5 })
    );
    expect(data.items).toBeInstanceOf(Array);
    await ctx.dispose();
  });
});

test.describe("AI usage statistics", () => {
  test("admin page shows AI usage section", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "AI Usage" })
    ).toBeVisible();
  });

  test("AI stats API returns data", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const stats = await trpcResult(
      await trpcQuery(ctx, "admin.getAIStats")
    );
    expect(stats.total).toBeDefined();
    expect(stats.byStatus).toBeDefined();
    expect(stats.byProvider).toBeDefined();
    expect(stats.last7Days).toBeDefined();
    expect(stats.last30Days).toBeDefined();
    await ctx.dispose();
  });
});

test.describe("Admin tools", () => {
  test("admin page shows tools section with export and email buttons", async ({
    page,
  }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Admin Tools" })
    ).toBeVisible();
    await expect(page.getByText("Data Export")).toBeVisible();
    await expect(page.getByText("Email Configuration")).toBeVisible();
  });

  test("data export API returns JSON file", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const res = await ctx.get("/api/admin/export");
    expect(res.ok()).toBe(true);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers()["content-disposition"]).toContain(
      "sharetab-export"
    );
    const body = await res.json();
    expect(body.exportedAt).toBeDefined();
    expect(body.data).toBeDefined();
    expect(body.data.users).toBeInstanceOf(Array);
    expect(body.data.groups).toBeInstanceOf(Array);
    // Password hashes should not be present
    for (const user of body.data.users) {
      expect(user.passwordHash).toBeUndefined();
    }
    await ctx.dispose();
  });

  test("export API rejects non-admin users", async () => {
    const ctx = await authedContext(users.bob.email, users.bob.password);
    const res = await ctx.get("/api/admin/export");
    expect(res.status()).toBe(403);
    await ctx.dispose();
  });
});

test.describe("Server logs", () => {
  test("admin page shows server logs section", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Server Logs" })
    ).toBeVisible();

    // Should show the log viewer with level filter buttons
    await expect(page.getByRole("button", { name: "debug" })).toBeVisible();
    await expect(page.getByRole("button", { name: "info" })).toBeVisible();
    await expect(page.getByRole("button", { name: "warn" })).toBeVisible();
    await expect(page.getByRole("button", { name: "error" })).toBeVisible();
  });

  test("server logs API returns entries", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const data = await trpcResult(
      await trpcQuery(ctx, "admin.getLogs", { limit: 50 })
    );
    expect(data.entries).toBeInstanceOf(Array);
    expect(typeof data.latestId).toBe("number");
    await ctx.dispose();
  });

  test("server logs API supports level filtering", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const data = await trpcResult(
      await trpcQuery(ctx, "admin.getLogs", { minLevel: "warn", limit: 50 })
    );
    expect(data.entries).toBeInstanceOf(Array);
    // All entries should be warn or error level
    for (const entry of data.entries) {
      expect(["warn", "error"]).toContain(entry.level);
    }
    await ctx.dispose();
  });
});

test.describe("User impersonation", () => {
  test("admin page shows impersonate button for non-admin users", async ({
    page,
  }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    // Use User Management section to avoid strict mode violations with other tables
    const userSection = page.locator("section", {
      has: page.getByRole("heading", { name: "User Management" }),
    });
    const bobRow = userSection
      .locator("table")
      .first()
      .locator("tr", { hasText: "bob@example.com" });
    await expect(bobRow).toBeVisible();
    await expect(bobRow.getByTitle("Impersonate user")).toBeVisible();
  });

  test("impersonation API start and stop", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Get Bob's user ID
    const listData = await trpcResult(
      await trpcQuery(ctx, "admin.listUsers")
    );
    const bob = listData.users.find(
      (u: { email: string }) => u.email === "bob@example.com"
    );

    // Start impersonation
    const startRes = await ctx.post("/api/admin/impersonate", {
      data: { userId: bob.id },
    });
    expect(startRes.ok()).toBe(true);
    const startBody = await startRes.json();
    expect(startBody.success).toBe(true);
    expect(startBody.impersonating.email).toBe("bob@example.com");

    // Check impersonation status
    const statusData = await trpcResult(
      await trpcQuery(ctx, "admin.getImpersonationStatus")
    );
    expect(statusData.isImpersonating).toBe(true);

    // Stop impersonation
    const stopRes = await ctx.delete("/api/admin/impersonate");
    expect(stopRes.ok()).toBe(true);

    await ctx.dispose();
  });

  test("impersonation API rejects non-admin users", async () => {
    const ctx = await authedContext(users.bob.email, users.bob.password);
    const res = await ctx.post("/api/admin/impersonate", {
      data: { userId: "some-id" },
    });
    expect(res.status()).toBe(403);
    await ctx.dispose();
  });
});
