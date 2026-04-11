import { test, expect, type Page, type Route } from "@playwright/test";
import {
  users,
  login,
  authedContext,
  trpcQuery,
  trpcMutation,
  trpcResult,
} from "./helpers";

// ─── Mock helpers ─────────────────────────────────────────
// tRPC batches multiple queries into a single HTTP request with a URL like:
//   /api/trpc/admin.getSystemHealth,admin.getMeridianAuthStatus,...?batch=1
// We intercept ALL /api/trpc/* requests and inject mock responses for the
// Meridian procedures, letting all other procedures pass through to the server.

type MockResponses = Record<string, unknown>;

/**
 * Intercept tRPC batch requests and replace specific procedure responses.
 * Non-mocked procedures in the same batch pass through to the real server.
 */
async function mockTrpcProcedures(page: Page, mocks: MockResponses) {
  await page.route("**/api/trpc/**", async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();

    // Extract procedure names from the URL path
    // URL format: /api/trpc/proc1,proc2,proc3?batch=1&input=...
    const pathMatch = url.match(/\/api\/trpc\/([^?]+)/);
    if (!pathMatch) {
      await route.continue();
      return;
    }

    const procedures = pathMatch[1].split(",");

    // Check if any mocked procedure is in this batch
    const hasMock = procedures.some((p) => p in mocks);
    if (!hasMock) {
      await route.continue();
      return;
    }

    // For mutations (POST without batch), handle directly
    if (method === "POST" && !url.includes("batch=")) {
      const proc = procedures[0];
      if (proc in mocks) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            result: { data: { json: mocks[proc] } },
          }),
        });
        return;
      }
      await route.continue();
      return;
    }

    // For batched GET queries, fetch the real response first then splice in mocks
    const response = await route.fetch();
    const body = await response.json();

    // body is an array matching the procedure order
    const modified = procedures.map((proc, i) => {
      if (proc in mocks) {
        return { result: { data: { json: mocks[proc] } } };
      }
      return body[i];
    });

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(modified),
    });
  });
}

/** Mock Meridian as unhealthy */
async function mockMeridianUnhealthy(page: Page) {
  await mockTrpcProcedures(page, {
    "admin.getMeridianAuthStatus": {
      status: "unhealthy",
      error: "Not logged in. Run: claude login",
      loginInProgress: false,
    },
    "admin.getMeridianNotifyPreference": { interval: "once" },
  });
}

/** Mock Meridian as healthy */
async function mockMeridianHealthy(page: Page) {
  await mockTrpcProcedures(page, {
    "admin.getMeridianAuthStatus": {
      status: "healthy",
      email: "user@claude.ai",
      loginInProgress: false,
    },
    "admin.getMeridianNotifyPreference": { interval: "once" },
  });
}

/** Mock Meridian as not_running */
async function mockMeridianNotRunning(page: Page) {
  await mockTrpcProcedures(page, {
    "admin.getMeridianAuthStatus": {
      status: "not_running",
      loginInProgress: false,
    },
    "admin.getMeridianNotifyPreference": { interval: "once" },
  });
}

// ─── Tests ────────────────────────────────────────────────

test.describe("Meridian auth section — unhealthy", () => {
  test.beforeEach(async ({ page }) => {
    await mockMeridianUnhealthy(page);
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");
  });

  test("shows Meridian Authentication section with unhealthy status", async ({
    page,
  }) => {
    await expect(
      page.getByRole("heading", { name: "Meridian Authentication" })
    ).toBeVisible();

    // Status card
    await expect(page.getByText("Claude OAuth Status")).toBeVisible();
    await expect(page.getByText("Authentication expired")).toBeVisible();

    // Error message from the mock
    await expect(
      page.getByText("Not logged in. Run: claude login")
    ).toBeVisible();
  });

  test("shows Re-authenticate button when unhealthy", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: "Re-authenticate" })
    ).toBeVisible();
  });

  test("shows notification preferences card", async ({ page }) => {
    await expect(
      page.getByText("Auth Expiry Notifications")
    ).toBeVisible();

    await expect(
      page.getByText("How often to receive email alerts")
    ).toBeVisible();

    // Select trigger should be present
    await expect(
      page.locator("[data-slot='select-trigger']").last()
    ).toBeVisible();
  });

  test("re-authenticate button triggers login flow UI", async ({ page }) => {
    // Add mock for startMeridianLogin mutation
    await page.route("**/api/trpc/admin.startMeridianLogin*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: {
            data: {
              json: {
                url: "https://claude.ai/oauth/authorize?code=test123",
              },
            },
          },
        }),
      });
    });

    await page.getByRole("button", { name: "Re-authenticate" }).click();

    // Should show the login flow with steps
    await expect(
      page.getByText("Step 1: Open this link and sign in")
    ).toBeVisible();
    await expect(
      page.getByText("Step 2: Paste the code you receive")
    ).toBeVisible();

    // Should show the auth link
    await expect(
      page.getByRole("link", { name: "Open authentication page" })
    ).toBeVisible();

    // Should show the code input
    await expect(
      page.getByPlaceholder("Paste authorization code...")
    ).toBeVisible();

    // Submit button should be disabled when code is empty
    await expect(
      page.getByRole("button", { name: "Submit" })
    ).toBeDisabled();

    // Should show cancel button
    await expect(
      page.getByRole("button", { name: "Cancel" })
    ).toBeVisible();
  });

  test("submit button enables when code is entered", async ({ page }) => {
    // Mock start login
    await page.route("**/api/trpc/admin.startMeridianLogin*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: {
            data: { json: { url: "https://claude.ai/oauth/authorize?code=test" } },
          },
        }),
      });
    });

    await page.getByRole("button", { name: "Re-authenticate" }).click();
    await expect(
      page.getByPlaceholder("Paste authorization code...")
    ).toBeVisible();

    // Type a code
    await page
      .getByPlaceholder("Paste authorization code...")
      .fill("abc123");

    // Submit should now be enabled
    await expect(
      page.getByRole("button", { name: "Submit" })
    ).toBeEnabled();
  });

  test("successful login shows success message", async ({ page }) => {
    // Mock start login
    await page.route("**/api/trpc/admin.startMeridianLogin*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: {
            data: { json: { url: "https://claude.ai/oauth/authorize?code=test" } },
          },
        }),
      });
    });

    // Mock complete login — success
    await page.route("**/api/trpc/admin.completeMeridianLogin*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: {
            data: { json: { success: true } },
          },
        }),
      });
    });

    await page.getByRole("button", { name: "Re-authenticate" }).click();
    await page
      .getByPlaceholder("Paste authorization code...")
      .fill("valid-code-123");
    await page.getByRole("button", { name: "Submit" }).click();

    // Should show success
    await expect(
      page.getByText("Login successful! Authentication restored.")
    ).toBeVisible();

    // Dismiss button should be available
    await expect(
      page.getByRole("button", { name: "Dismiss" })
    ).toBeVisible();
  });

  test("failed login shows error with retry option", async ({ page }) => {
    // Mock start login
    await page.route("**/api/trpc/admin.startMeridianLogin*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: {
            data: { json: { url: "https://claude.ai/oauth/authorize?code=test" } },
          },
        }),
      });
    });

    // Mock complete login — failure
    await page.route("**/api/trpc/admin.completeMeridianLogin*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: {
            data: { json: { success: false, error: "Invalid authorization code" } },
          },
        }),
      });
    });

    await page.getByRole("button", { name: "Re-authenticate" }).click();
    await page
      .getByPlaceholder("Paste authorization code...")
      .fill("bad-code");
    await page.getByRole("button", { name: "Submit" }).click();

    // Should show error
    await expect(
      page.getByText("Invalid authorization code")
    ).toBeVisible();

    // Should show try again button
    await expect(
      page.getByRole("button", { name: "Try again" })
    ).toBeVisible();
  });

  test("cancel button resets login flow", async ({ page }) => {
    // Mock start login
    await page.route("**/api/trpc/admin.startMeridianLogin*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: {
            data: { json: { url: "https://claude.ai/oauth/authorize?code=test" } },
          },
        }),
      });
    });

    // Mock cancel login
    await page.route("**/api/trpc/admin.cancelMeridianLogin*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: { data: { json: { cancelled: true } } },
        }),
      });
    });

    await page.getByRole("button", { name: "Re-authenticate" }).click();
    await expect(
      page.getByText("Step 1: Open this link and sign in")
    ).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();

    // Should return to idle state — Re-authenticate button visible again
    await expect(
      page.getByRole("button", { name: "Re-authenticate" })
    ).toBeVisible();
  });

  test("notification preference dropdown has all options", async ({
    page,
  }) => {
    // Click the select trigger to open the dropdown
    const trigger = page.locator("[data-slot='select-trigger']").last();
    await trigger.click();

    // All options should be visible
    await expect(page.getByText("Once per incident")).toBeVisible();
    await expect(page.getByText("Every hour")).toBeVisible();
    await expect(page.getByText("Every 6 hours")).toBeVisible();
    await expect(page.getByText("Every 24 hours")).toBeVisible();
  });
});

test.describe("Meridian auth section — healthy", () => {
  test("shows Authenticated status with email", async ({ page }) => {
    await mockMeridianHealthy(page);
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Meridian Authentication" })
    ).toBeVisible();
    await expect(page.getByText("Authenticated")).toBeVisible();
    await expect(page.getByText("user@claude.ai")).toBeVisible();

    // Re-authenticate button should NOT appear when healthy
    await expect(
      page.getByRole("button", { name: "Re-authenticate" })
    ).not.toBeVisible();
  });
});

test.describe("Meridian auth section — not running", () => {
  test("shows Proxy not running status", async ({ page }) => {
    await mockMeridianNotRunning(page);
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Meridian Authentication" })
    ).toBeVisible();
    await expect(page.getByText("Proxy not running")).toBeVisible();
  });
});

test.describe("Meridian auth section — not applicable", () => {
  test("section is hidden when AI provider is not meridian", async ({
    page,
  }) => {
    // Don't mock — the real server returns "not_applicable" unless AI_PROVIDER=meridian
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    // The section should not be rendered
    await expect(page.getByText("Meridian Authentication")).not.toBeVisible();
  });
});

test.describe("Meridian notify preference — API", () => {
  test("get and set notification preference via API", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Get current preference
    const getData = await trpcResult(
      await trpcQuery(ctx, "admin.getMeridianNotifyPreference")
    );
    const original = getData.interval;

    // Set to "6h"
    const setRes = await trpcMutation(
      ctx,
      "admin.setMeridianNotifyPreference",
      { interval: "6h" }
    );
    const setBody = await setRes.json();
    expect(setBody.result.data.json.interval).toBe("6h");

    // Verify
    const verify = await trpcResult(
      await trpcQuery(ctx, "admin.getMeridianNotifyPreference")
    );
    expect(verify.interval).toBe("6h");

    // Restore original
    await trpcMutation(ctx, "admin.setMeridianNotifyPreference", {
      interval: original,
    });

    await ctx.dispose();
  });

  test("non-admin user cannot access notify preference", async () => {
    const ctx = await authedContext(users.bob.email, users.bob.password);
    const res = await trpcQuery(ctx, "admin.getMeridianNotifyPreference");
    const body = await res.json();
    const code =
      body[0]?.error?.json?.data?.code ?? body[0]?.error?.data?.code;
    expect(code).toBe("FORBIDDEN");
    await ctx.dispose();
  });
});
