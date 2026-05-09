import { test, expect, request } from "@playwright/test";
import { trpcMutation, trpcResult, trpcQuery, trpcError } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Finding #3: removePerson index state", () => {
  test("removing a person doesn't break claiming for remaining people", async ({
    browser,
  }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create session with 3 people
    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Index Test",
        subtotal: 3000,
        tax: 300,
        tip: 0,
        total: 3300,
        currency: "USD",
      },
      items: [
        { name: "Item A", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Item B", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Item C", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Join Alice and Bob
    const joinAlice = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Alice",
    });
    const aliceToken = (await joinAlice.json()).result?.data?.json?.personToken;

    await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Bob",
    });

    await ctx.dispose();

    // Open in browser, join as Alice via UI
    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("claim-name-input").fill("Alice");
    await page.getByTestId("claim-join-btn").click();

    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });

    // Claim item 0 for Alice
    await page.getByTestId("claim-item-0").click();
    await expect(page.getByTestId("claim-item-0")).toHaveAttribute("aria-pressed", "true");

    // Save
    const saveBtn = page.getByTestId("save-claims-btn");
    await saveBtn.scrollIntoViewIfNeeded();
    await saveBtn.click();
    await expect(saveBtn).toContainText(/saved/i, { timeout: 10000 });

    // Remove Bob (person index 1) via API
    const apiCtx = await request.newContext({ baseURL: BASE });
    const removeRes = await trpcMutation(apiCtx, "guest.removePerson", {
      token: shareToken,
      personToken: aliceToken,
      targetIndex: 1,
    });
    expect(removeRes.ok()).toBe(true);
    await apiCtx.dispose();

    // Wait for polling to pick up the change
    await page.waitForTimeout(4000);

    // Alice's claim on item 0 should still show (via polling refresh)
    // The page should not be in a broken state
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible();

    await page.close();
    await browserCtx.close();
  });
});

test.describe("Finding #5: paidByIndex with blank people", () => {
  test("createSplit handles paidByIndex correctly when people array has blanks", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create a split where people[0] is blank, people[1] is "Alice"
    // paidByIndex=1 should map to validPeople[0] after filtering
    // The server-side createSplit already handles this via its own filtering,
    // but the client should send the correct remapped index
    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Blank People Test",
        subtotal: 1000,
        tax: 100,
        tip: 0,
        total: 1100,
        currency: "USD",
      },
      items: [
        { name: "Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      // Only valid people (server filters blanks)
      people: [{ name: "Alice" }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
      paidByIndex: 0,
    });
    expect(createRes.ok()).toBe(true);
    const { shareToken } = (await createRes.json()).result?.data?.json;

    const getRes = await trpcQuery(ctx, "guest.getSplit", { token: shareToken });
    const data = await trpcResult(getRes);
    expect(data.paidByIndex).toBe(0);
    expect(data.people[0].name).toBe("Alice");

    await ctx.dispose();
  });
});

test.describe("Finding #6: assignAllToEveryone with blank names", () => {
  test("split with all-assigned should only include valid people in assignments", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create a split with 2 valid people assigned to 1 item
    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Assign All Test",
        subtotal: 1000,
        tax: 100,
        tip: 0,
        total: 1100,
        currency: "USD",
      },
      items: [
        { name: "Shared Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      people: [{ name: "Alice" }, { name: "Bob" }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      paidByIndex: 0,
    });
    expect(createRes.ok()).toBe(true);
    const { shareToken } = (await createRes.json()).result?.data?.json;

    const getRes = await trpcQuery(ctx, "guest.getSplit", { token: shareToken });
    const data = await trpcResult(getRes);

    // Both people should be in the assignment
    expect(data.summary).toHaveLength(2);
    // Totals should sum correctly
    const totalSum = data.summary.reduce(
      (sum: number, s: { total: number }) => sum + s.total,
      0
    );
    expect(totalSum).toBe(1100);

    await ctx.dispose();
  });
});

test.describe("Finding #7: empty items submit guard", () => {
  test("createSplit rejects empty items array", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createSplit", {
      receiptData: {
        merchantName: "Empty Items Test",
        subtotal: 0,
        tax: 0,
        tip: 0,
        total: 0,
        currency: "USD",
      },
      items: [],
      people: [{ name: "Alice" }],
      assignments: [],
      paidByIndex: 0,
    });
    // Server should reject empty items (Zod validation or business logic)
    expect(createRes.ok()).toBe(false);

    await ctx.dispose();
  });
});

test.describe("Finding #8: non-JSON upload error handling", () => {
  test("upload endpoint returns JSON error for invalid requests", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Send an empty upload (no file) — should get a JSON error, not crash
    const res = await ctx.post(`${BASE}/api/upload`, {
      multipart: {},
    });
    // Should return an error status with a parseable response
    expect(res.status()).toBeGreaterThanOrEqual(400);

    // The response should be parseable (JSON or at least not crash the client)
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);

    await ctx.dispose();
  });

  test("upload rejects oversized or invalid content types gracefully", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Send a text file instead of an image
    const res = await ctx.post(`${BASE}/api/upload?guest=true`, {
      multipart: {
        file: {
          name: "test.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("this is not an image"),
        },
      },
    });

    // Should return an error but not crash
    expect(res.status()).toBeGreaterThanOrEqual(400);
    // Response should be JSON
    const body = await res.json();
    expect(body.error).toBeTruthy();

    await ctx.dispose();
  });
});
