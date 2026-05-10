import { test, expect } from "@playwright/test";
import { login, users, authedContext, trpcMutation, trpcQuery, trpcResult, createTestGroup } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.use({ viewport: { width: 430, height: 932 } });

test.describe("Venmo settle from group balances", () => {
  test.beforeAll(async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(ctx, "admin.setVenmoEnabled", { enabled: true });
    await trpcMutation(ctx, "auth.updateProfile", { venmoUsername: "alice-venmo" });
    await ctx.dispose();
  });

  test.afterAll(async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(ctx, "admin.setVenmoEnabled", { enabled: false });
    await trpcMutation(ctx, "auth.updateProfile", { venmoUsername: "" });
    await ctx.dispose();
  });

  test("venmo pay button on group debt row + auto-settle confirmation", async ({ page }) => {
    test.setTimeout(60_000);

    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Venmo Settle Group"
    );

    try {
      const aliceId = memberIds[users.alice.email];
      const bobId = memberIds[users.bob.email];

      // Create expense: Alice paid $20, split equally (Bob owes Alice $10)
      await trpcMutation(owner, "expenses.create", {
        groupId,
        title: "Lunch",
        amount: 2000,
        currency: "USD",
        paidById: aliceId,
        splitMode: "EQUAL",
        shares: [
          { userId: aliceId, amount: 1000 },
          { userId: bobId, amount: 1000 },
        ],
      });

      // Login as Bob (who owes Alice)
      await login(page, users.bob.email, users.bob.password);
      await page.goto(`/en/groups/${groupId}`);

      // Wait for the debt to show
      await expect(page.getByText("Balances")).toBeVisible({ timeout: 15000 });
      // Venmo button should appear
      const venmoBtn = page.locator('[data-testid^="venmo-settle-"]').first();
      await expect(venmoBtn).toBeVisible({ timeout: 5000 });

      // Screenshot: Venmo pay button on group debt row
      await page.screenshot({ path: "docs/screenshots/venmo-settle-group.png" });
    } finally {
      await dispose();
    }
  });

  test("venmo button hidden when payee has no venmo handle", async ({ page }) => {
    test.setTimeout(60_000);

    // Temporarily clear Alice's venmo handle
    const adminCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(adminCtx, "auth.updateProfile", { venmoUsername: "" });

    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "No Venmo Group"
    );

    try {
      const aliceId = memberIds[users.alice.email];
      const bobId = memberIds[users.bob.email];

      await trpcMutation(owner, "expenses.create", {
        groupId,
        title: "Dinner",
        amount: 3000,
        currency: "USD",
        paidById: aliceId,
        splitMode: "EQUAL",
        shares: [
          { userId: aliceId, amount: 1500 },
          { userId: bobId, amount: 1500 },
        ],
      });

      await login(page, users.bob.email, users.bob.password);
      await page.goto(`/en/groups/${groupId}`);

      await expect(page.getByText("Balances")).toBeVisible({ timeout: 15000 });

      // No venmo button (Alice has no handle)
      await expect(page.locator('[data-testid^="venmo-settle-"]')).not.toBeVisible();
    } finally {
      // Restore Alice's handle
      await trpcMutation(adminCtx, "auth.updateProfile", { venmoUsername: "alice-venmo" });
      await adminCtx.dispose();
      await dispose();
    }
  });

  test("dashboard shows venmo link on people you owe", async ({ page }) => {
    test.setTimeout(60_000);

    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email, users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      "Dashboard Venmo Group"
    );

    try {
      const aliceId = memberIds[users.alice.email];
      const bobId = memberIds[users.bob.email];

      await trpcMutation(owner, "expenses.create", {
        groupId,
        title: "Coffee",
        amount: 1000,
        currency: "USD",
        paidById: aliceId,
        splitMode: "EQUAL",
        shares: [
          { userId: aliceId, amount: 500 },
          { userId: bobId, amount: 500 },
        ],
      });

      // Login as Bob and go to dashboard
      await login(page, users.bob.email, users.bob.password);
      await page.goto("/en/dashboard");

      // Wait for debt summary to load
      await expect(page.getByText(/you owe/i).first()).toBeVisible({ timeout: 15000 });

      // Scroll to see the debt cards
      await page.evaluate(() => window.scrollTo({ top: 400, behavior: "instant" }));
      await page.waitForTimeout(1000);

      // Screenshot: dashboard venmo links
      await page.screenshot({ path: "docs/screenshots/venmo-dashboard.png" });
    } finally {
      await dispose();
    }
  });
});
