import { test, expect } from "@playwright/test";
import { login, users, createTestGroup } from "./helpers";

test.describe("Receipt rescan — smoke tests", () => {
  test("authenticated scan page renders upload step", async ({ page }) => {
    await login(page, users.alice.email, users.alice.password);
    const { groupId, dispose } = await createTestGroup(
      users.alice.email, users.alice.password, [], "Rescan Test"
    );

    await page.goto(`/groups/${groupId}/scan`);
    await expect(page.getByRole("heading", { name: "Scan Receipt" })).toBeVisible();
    await expect(page.getByText("Upload a receipt")).toBeVisible();

    await dispose();
  });

  test("guest split page renders upload step", async ({ page }) => {
    await page.goto("/en/split");
    await expect(page.getByText("Split a bill")).toBeVisible();
    await expect(page.getByText("Snap a Bill")).toBeVisible();
  });

  test("processReceipt accepts correctionHint parameter (schema validation)", async () => {
    const { authedContext, trpcMutation } = await import("./helpers");
    const ctx = await authedContext(users.alice.email, users.alice.password);

    const groupRes = await trpcMutation(ctx, "groups.create", { name: "Rescan API Test" });
    const groupId = (await groupRes.json()).result?.data?.json?.id;

    // Verify the endpoint accepts correctionHint without schema error
    // (NOT_FOUND is expected since receipt doesn't exist)
    const res = await trpcMutation(ctx, "receipts.processReceipt", {
      receiptId: "nonexistent",
      groupId,
      correctionHint: "The total should be $25.00",
    });
    const body = await res.json();
    expect(body.error?.json?.data?.code).toBe("NOT_FOUND");

    await trpcMutation(ctx, "groups.delete", { groupId });
    await ctx.dispose();
  });

  test("guest processReceipt accepts correctionHint parameter (schema validation)", async () => {
    const { request } = await import("@playwright/test");
    const BASE = process.env.BASE_URL || "http://localhost:3001";
    const ctx = await request.newContext({ baseURL: BASE });

    const res = await ctx.post("/api/trpc/guest.processReceipt", {
      data: {
        json: {
          receiptId: "nonexistent",
          correctionHint: "Fix the tax amount",
        },
      },
    });
    const body = await res.json();
    expect(body.error?.json?.data?.code).toBe("NOT_FOUND");

    await ctx.dispose();
  });
});
