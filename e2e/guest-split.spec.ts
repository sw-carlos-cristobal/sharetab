import { test, expect, request } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Guest Bill Split — UI", () => {
  test("split page loads without authentication", async ({ page }) => {
    await page.goto("/split");
    await expect(page.getByText("Split a bill")).toBeVisible();
    // Upload options: camera and gallery
    await expect(page.getByText("Snap a Bill")).toBeVisible();
  });

  test("split page shows upload form with camera option", async ({ page }) => {
    await page.goto("/split");
    const fileInput = page.locator('input[type="file"]').first();
    await expect(fileInput).toBeAttached();
  });

  test("login page links to guest split", async ({ page }) => {
    await page.goto("/login");
    const splitLink = page.getByRole("link", { name: "Split without an account" });
    await expect(splitLink).toBeVisible();
    await expect(splitLink).toHaveAttribute("href", "/split");
  });
});

test.describe("Guest Bill Split — API", () => {
  test("createSplit creates a shareable split and getSplit retrieves it", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create a split via the API
    const createRes = await ctx.post("/api/trpc/guest.createSplit", {
      data: {
        json: {
          receiptData: {
            merchantName: "Test Restaurant",
            date: "2026-03-30",
            subtotal: 3000,
            tax: 240,
            tip: 500,
            total: 3740,
            currency: "USD",
          },
          items: [
            { name: "Burger", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
            { name: "Salad", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
            { name: "Fries", quantity: 1, unitPrice: 500, totalPrice: 500 },
          ],
          people: [{ name: "Alice" }, { name: "Bob" }],
          assignments: [
            { itemIndex: 0, personIndices: [0] },
            { itemIndex: 1, personIndices: [1] },
            { itemIndex: 2, personIndices: [0, 1] },
          ],
          paidByIndex: 0,
        },
      },
    });

    expect(createRes.ok()).toBe(true);
    const createBody = await createRes.json();
    const shareToken = createBody.result?.data?.json?.shareToken;
    expect(shareToken).toBeTruthy();

    // Retrieve the split
    const getRes = await ctx.get(
      `/api/trpc/guest.getSplit?batch=1&input=${encodeURIComponent(
        JSON.stringify({ "0": { json: { token: shareToken } } })
      )}`
    );
    expect(getRes.ok()).toBe(true);
    const getBody = await getRes.json();
    const split = getBody[0]?.result?.data?.json;

    expect(split.shareToken).toBe(shareToken);
    expect(split.receiptData.merchantName).toBe("Test Restaurant");
    expect(split.receiptData.total).toBe(3740);
    expect(split.items).toHaveLength(3);
    expect(split.people).toHaveLength(2);
    expect(split.summary).toHaveLength(2);
    expect(split.paidByIndex).toBe(0);

    // Verify summary has correct person names
    const names = split.summary.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(["Alice", "Bob"]);

    // Verify totals add up
    const totalFromSummary = split.summary.reduce(
      (sum: number, s: { total: number }) => sum + s.total,
      0
    );
    expect(totalFromSummary).toBe(3740);

    await ctx.dispose();
  });

  test("getSplit returns NOT_FOUND for invalid token", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await ctx.get(
      `/api/trpc/guest.getSplit?batch=1&input=${encodeURIComponent(
        JSON.stringify({ "0": { json: { token: "invalid-token-xyz" } } })
      )}`
    );
    const body = await res.json();
    expect(body[0]?.error?.json?.data?.code).toBe("NOT_FOUND");
    await ctx.dispose();
  });

  test("createSplit requires at least one person", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await ctx.post("/api/trpc/guest.createSplit", {
      data: {
        json: {
          receiptData: {
            subtotal: 1000,
            tax: 0,
            tip: 0,
            total: 1000,
            currency: "USD",
          },
          items: [{ name: "Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
          people: [],
          assignments: [{ itemIndex: 0, personIndices: [] }],
          paidByIndex: 0,
        },
      },
    });
    // Should fail validation (people min 1)
    const body = await res.json();
    expect(body.error).toBeTruthy();
    await ctx.dispose();
  });
});

test.describe("Guest Bill Split — Share Page", () => {
  let shareToken: string;

  test.beforeAll(async () => {
    // Create a split to test the share page
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await ctx.post("/api/trpc/guest.createSplit", {
      data: {
        json: {
          receiptData: {
            merchantName: "Pizza Place",
            subtotal: 2400,
            tax: 200,
            tip: 400,
            total: 3000,
            currency: "USD",
          },
          items: [
            { name: "Large Pizza", quantity: 1, unitPrice: 2400, totalPrice: 2400 },
          ],
          people: [{ name: "Charlie" }, { name: "Dave" }],
          assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
          paidByIndex: 0,
        },
      },
    });
    const body = await res.json();
    shareToken = body.result?.data?.json?.shareToken;
    await ctx.dispose();
  });

  test("share page displays split summary", async ({ page }) => {
    await page.goto(`/split/${shareToken}`);
    await expect(page.getByText("Pizza Place")).toBeVisible();
    await expect(page.getByText("Charlie").first()).toBeVisible();
    await expect(page.getByText("Dave").first()).toBeVisible();
    await expect(page.getByText("$30.00").first()).toBeVisible();
  });

  test("share page has copy link and share buttons", async ({ page }) => {
    await page.goto(`/split/${shareToken}`);
    await expect(page.getByRole("button", { name: /copy/i })).toBeVisible();
  });

  test("share page shows split your own bill link", async ({ page }) => {
    await page.goto(`/split/${shareToken}`);
    await expect(page.getByText("Split your own bill")).toBeVisible();
  });

  test("invalid share token shows not found", async ({ page }) => {
    await page.goto("/split/nonexistent-token-abc123");
    await expect(page.getByText("Split not found")).toBeVisible();
  });
});
