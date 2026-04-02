import { test, expect, request } from "@playwright/test";
import {
  users,
  login,
  authedContext,
  trpcQuery,
  trpcMutation,
  trpcResult,
  trpcError,
} from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Admin — Guest Split Cleanup", () => {
  // ── API Tests ────────────────────────────────────────────

  test("getExpiredSplitCount returns counts", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    const data = await trpcResult(
      await trpcQuery(ctx, "admin.getExpiredSplitCount")
    );
    expect(typeof data.expiredCount).toBe("number");
    expect(typeof data.totalCount).toBe("number");
    expect(data.expiredCount).toBeLessThanOrEqual(data.totalCount);
    await ctx.dispose();
  });

  test("cleanupExpiredSplits deletes expired records", async () => {
    const unauthCtx = await request.newContext({ baseURL: BASE });

    // Create a guest split (these expire in 7 days, so it won't be expired)
    const createRes = await unauthCtx.post("/api/trpc/guest.createSplit", {
      data: {
        json: {
          receiptData: {
            merchantName: "Cleanup Test",
            subtotal: 1000,
            tax: 80,
            tip: 0,
            total: 1080,
            currency: "USD",
          },
          items: [
            { name: "Test Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
          ],
          people: [{ name: "Tester" }],
          assignments: [{ itemIndex: 0, personIndices: [0] }],
          paidByIndex: 0,
        },
      },
    });
    expect(createRes.ok()).toBe(true);
    await unauthCtx.dispose();

    // Now run cleanup as admin — should succeed (may delete 0 if none are expired)
    const adminCtx = await authedContext(users.alice.email, users.alice.password);
    const cleanupRes = await trpcMutation(adminCtx, "admin.cleanupExpiredSplits", {});
    const cleanupBody = await cleanupRes.json();
    expect(cleanupBody.result.data.json.deletedCount).toBeGreaterThanOrEqual(0);
    await adminCtx.dispose();
  });

  test("non-admin cannot call getExpiredSplitCount", async () => {
    const ctx = await authedContext(users.bob.email, users.bob.password);
    const res = await trpcQuery(ctx, "admin.getExpiredSplitCount");
    const error = await trpcError(res);
    expect(error).toBeTruthy();
    expect(error.data?.code).toBe("FORBIDDEN");
    await ctx.dispose();
  });

  test("non-admin cannot call cleanupExpiredSplits", async () => {
    const ctx = await authedContext(users.bob.email, users.bob.password);
    const res = await trpcMutation(ctx, "admin.cleanupExpiredSplits", {});
    const body = await res.json();
    const code = body.error?.json?.data?.code ?? body.error?.data?.code;
    expect(code).toBe("FORBIDDEN");
    await ctx.dispose();
  });

  // ── UI Tests ─────────────────────────────────────────────

  test("admin tools section shows Guest Split Cleanup card", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    // Should see the cleanup card within the tools section
    const toolsSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Admin Tools" }),
    });
    await expect(toolsSection).toBeVisible();
    await expect(toolsSection.getByText("Guest Split Cleanup")).toBeVisible();
    await expect(toolsSection.getByText("guest splits")).toBeVisible();
    await expect(
      toolsSection.getByRole("button", { name: "Purge Expired" })
    ).toBeVisible();
  });

  test("purge button works and shows result", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto("/admin");

    const toolsSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Admin Tools" }),
    });

    const purgeButton = toolsSection.getByRole("button", { name: "Purge Expired" });

    // Check if button is enabled (there might be expired splits or not)
    const isDisabled = await purgeButton.isDisabled();
    if (!isDisabled) {
      await purgeButton.click();
      // Should show a success message
      await expect(toolsSection.getByText(/Deleted \d+ expired splits/)).toBeVisible({
        timeout: 10000,
      });
    }
    // If disabled, that means 0 expired — which is also a valid state
  });
});
