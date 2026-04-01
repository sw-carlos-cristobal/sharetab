import { test, expect } from "@playwright/test";
import { users, login, authedContext, trpcQuery, trpcError } from "./helpers";

test.describe("Admin page access control", () => {
  test("non-admin user gets FORBIDDEN when calling admin API", async () => {
    // Bob is not the admin user
    const ctx = await authedContext(users.bob.email, users.bob.password);
    const res = await trpcQuery(ctx, "admin.getSystemHealth");
    const error = await trpcError(res);
    expect(error).toBeTruthy();
    expect(error.data?.code).toBe("FORBIDDEN");
    await ctx.dispose();
  });

  test("unauthenticated request gets error when calling admin API", async ({ request }) => {
    const res = await request.get(
      `/api/trpc/admin.getSystemHealth?batch=1&input=${encodeURIComponent(
        JSON.stringify({ "0": { json: null, meta: { values: ["undefined"], v: 1 } } })
      )}`
    );
    const body = await res.json();
    // Unauthenticated requests get UNAUTHORIZED or FORBIDDEN depending on middleware
    expect(body[0]?.error).toBeTruthy();
    // tRPC with superjson wraps errors in .json — check both shapes for resilience
    const code = body[0].error.json?.data?.code ?? body[0].error.data?.code;
    expect(["UNAUTHORIZED", "FORBIDDEN"]).toContain(code);
  });
});

test.describe("Admin page UI", () => {
  // These tests only run when ADMIN_EMAIL matches alice
  // The dev environment should have ADMIN_EMAIL=alice@example.com for these to pass

  test("admin user can view the admin page with system health section", async ({
    page,
  }) => {
    // Set up: alice should be the admin user (ADMIN_EMAIL=alice@example.com)
    await login(page, users.alice.email, users.alice.password);

    await page.goto("/admin");

    // Should see the admin dashboard heading
    await expect(
      page.getByRole("heading", { name: "Admin Dashboard" })
    ).toBeVisible();

    // Should see system health section
    await expect(
      page.getByRole("heading", { name: "System Health" })
    ).toBeVisible();

    // Should see database status
    await expect(page.getByText("Database").first()).toBeVisible();

    // Should see AI provider info
    await expect(page.getByText("AI Provider")).toBeVisible();

    // Should see version info
    await expect(page.getByText("Version")).toBeVisible();

    // Should see uptime info
    await expect(page.getByText("Uptime")).toBeVisible();
  });

  test("admin page shows user management section", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "User Management" })
    ).toBeVisible();

    // Should show users table with at least alice's email
    await expect(page.getByText("alice@example.com")).toBeVisible();
  });

  test("admin page shows group overview section", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Group Overview" })
    ).toBeVisible();
  });

  test("admin page shows storage stats section", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Storage Stats" })
    ).toBeVisible();

    // Should show receipt count
    await expect(page.getByText("Receipts")).toBeVisible();

    // Should show disk usage
    await expect(page.getByText("Disk Usage")).toBeVisible();
  });

  test("admin link visible in sidebar for admin user", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/dashboard");

    // Check sidebar has admin link (only visible on desktop)
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator("aside").getByText("Admin")).toBeVisible();
  });
});
