import { test, expect } from "@playwright/test";
import {
  users,
  login,
  authedContext,
  trpcQuery,
  trpcMutation,
  trpcResult,
} from "./helpers";
import { MockProvider } from "./mock-provider";

// ─── Meridian auth section — unhealthy (read-only UI) ─────

test.describe("Meridian auth section — unhealthy", () => {
  test.beforeEach(async ({ page }) => {
    const mock = new MockProvider(page).usePreset("meridianUnhealthy");
    await mock.install();
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");
  });

  test("shows Meridian Authentication section with unhealthy status", async ({
    page,
  }) => {
    await expect(
      page.getByRole("heading", { name: "Meridian Authentication" })
    ).toBeVisible();
    await expect(page.getByText("Claude OAuth Status")).toBeVisible();
    await expect(
      page.getByText(/Authentication expired|Proxy not running/i)
    ).toBeVisible();
  });

  test("shows Authenticate with Claude button when unhealthy", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: "Authenticate with Claude" })
    ).toBeVisible();
  });

  test("shows notification preferences card", async ({ page }) => {
    await expect(
      page.getByText("Auth Expiry Notifications")
    ).toBeVisible();
    await expect(
      page.getByText("How often to receive email alerts")
    ).toBeVisible();
    await expect(
      page.locator("[data-slot='select-trigger']").last()
    ).toBeVisible();
  });

  test("notification preference dropdown has all options", async ({
    page,
  }) => {
    const trigger = page.locator("[data-slot='select-trigger']").last();
    await trigger.click();

    await expect(page.getByText("Once per incident")).toBeVisible();
    await expect(page.getByText("Every hour")).toBeVisible();
    await expect(page.getByText("Every 6 hours")).toBeVisible();
    await expect(page.getByText("Every 24 hours")).toBeVisible();
  });
});

// ─── Meridian login flow (mutation interactions) ──────────

test.describe("Meridian login flow", () => {
  test("authenticate button triggers login flow UI", async ({ page }) => {
    const mock = new MockProvider(page)
      .usePreset("meridianUnhealthy")
      .setMeridianLoginResult({ url: "https://claude.ai/oauth/authorize?code=test123" });
    await mock.install();
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await page.getByRole("button", { name: "Authenticate with Claude" }).click();

    await expect(
      page.getByText("Click the link below to sign in with Claude.")
    ).toBeVisible();
    await expect(
      page.getByText("After authorizing, copy the")
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open authentication page" })
    ).toBeVisible();
    await expect(
      page.getByPlaceholder("https://platform.claude.com/oauth/code/callback?code=...")
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Submit" })
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Cancel" })
    ).toBeVisible();
  });

  test("submit button enables when code is entered", async ({ page }) => {
    const mock = new MockProvider(page)
      .usePreset("meridianUnhealthy")
      .setMeridianLoginResult({ url: "https://claude.ai/oauth/authorize?code=test" });
    await mock.install();
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await page.getByRole("button", { name: "Authenticate with Claude" }).click();
    await page
      .getByPlaceholder("https://platform.claude.com/oauth/code/callback?code=...")
      .fill("abc123");

    await expect(
      page.getByRole("button", { name: "Submit" })
    ).toBeEnabled();
  });

  test("successful login shows success message", async ({ page }) => {
    const mock = new MockProvider(page)
      .usePreset("meridianUnhealthy")
      .setMeridianLoginResult({ url: "https://claude.ai/oauth/authorize?code=test" })
      .setMeridianCompleteResult({ success: true });
    await mock.install();
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await page.getByRole("button", { name: "Authenticate with Claude" }).click();
    await page
      .getByPlaceholder("https://platform.claude.com/oauth/code/callback?code=...")
      .fill("valid-code-123");
    await page.getByRole("button", { name: "Submit" }).click();

    await expect(
      page.getByText("Login successful! Authentication restored.")
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Dismiss" })
    ).toBeVisible();
  });

  test("failed login shows error with retry option", async ({ page }) => {
    const mock = new MockProvider(page)
      .usePreset("meridianUnhealthy")
      .setMeridianLoginResult({ url: "https://claude.ai/oauth/authorize?code=test" })
      .setMeridianCompleteResult({ success: false, error: "Invalid authorization code" });
    await mock.install();
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await page.getByRole("button", { name: "Authenticate with Claude" }).click();
    await page
      .getByPlaceholder("https://platform.claude.com/oauth/code/callback?code=...")
      .fill("bad-code");
    await page.getByRole("button", { name: "Submit" }).click();

    await expect(
      page.getByText("Invalid authorization code")
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Try again" })
    ).toBeVisible();
  });

  test("cancel button resets login flow", async ({ page }) => {
    const mock = new MockProvider(page)
      .usePreset("meridianUnhealthy")
      .setMeridianLoginResult({ url: "https://claude.ai/oauth/authorize?code=test" })
      .setMeridianCancelResult();
    await mock.install();
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await page.getByRole("button", { name: "Authenticate with Claude" }).click();
    await expect(
      page.getByText("Click the link below to sign in with Claude.")
    ).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(
      page.getByRole("button", { name: "Authenticate with Claude" })
    ).toBeVisible();
  });
});

// ─── Meridian auth section — other states ─────────────────

test.describe("Meridian auth section — healthy", () => {
  test("shows Authenticated status with email", async ({ page }) => {
    const mock = new MockProvider(page).usePreset("meridianHealthy");
    await mock.install();
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Meridian Authentication" })
    ).toBeVisible();
    const meridianSection = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Meridian Authentication" }),
    });
    await expect(meridianSection.getByText("Authenticated")).toBeVisible();
    await expect(meridianSection.getByText("user@claude.ai")).toBeVisible();
    await expect(
      meridianSection.getByRole("button", { name: "Authenticate with Claude" })
    ).not.toBeVisible();
  });
});

test.describe("Meridian auth section — not running", () => {
  test("shows Proxy not running status", async ({ page }) => {
    const mock = new MockProvider(page).usePreset("meridianNotRunning");
    await mock.install();
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(
      page.getByRole("heading", { name: "Meridian Authentication" })
    ).toBeVisible();
    await expect(page.getByText("Proxy not running")).toBeVisible();
  });
});

test.describe("Meridian auth section — login in progress", () => {
  test("shows disabled button when login already in progress", async ({ page }) => {
    const mock = new MockProvider(page).usePreset("meridianLoginInProgress");
    await mock.install();
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    await expect(page.getByText("Login in progress...")).toBeVisible();
  });
});

test.describe("Meridian auth section — not applicable", () => {
  test("section is hidden when AI provider is not meridian", async ({
    page,
  }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");
    await expect(page.getByText("Meridian Authentication")).not.toBeVisible();
  });
});

// ─── Provider-specific auth sections ──────────────────────

test.describe("provider-specific auth sections", () => {
  test("shows database disconnected state", async ({ page }) => {
    const mock = new MockProvider(page).usePreset("dbDown");
    await mock.install();
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    const healthSection = page.locator("section", {
      has: page.getByRole("heading", { name: "System Health" }),
    });
    await expect(healthSection.getByText("Disconnected")).toBeVisible();
  });
});

// ─── API-level tests (no mocking needed) ──────────────────

test.describe("Meridian notify preference — API", () => {
  test("get and set notification preference via API", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);

    const getData = await trpcResult(
      await trpcQuery(ctx, "admin.getMeridianNotifyPreference")
    );
    const original = getData.interval;

    const setRes = await trpcMutation(
      ctx,
      "admin.setMeridianNotifyPreference",
      { interval: "6h" }
    );
    const setBody = await setRes.json();
    expect(setBody.result.data.json.interval).toBe("6h");

    const verify = await trpcResult(
      await trpcQuery(ctx, "admin.getMeridianNotifyPreference")
    );
    expect(verify.interval).toBe("6h");

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
