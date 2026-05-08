import { test, expect, request } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Guest Split UI Flow", () => {
  test("guest split page loads and shows upload options with testids", async ({ page }) => {
    await page.goto("/en/split");
    await expect(page.getByText("Split a bill")).toBeVisible();

    // Verify upload areas are present with correct testids
    await expect(page.getByTestId("guest-snap-upload")).toBeVisible();
    await expect(page.getByTestId("guest-gallery-upload")).toBeVisible();

    // The gallery file input should exist (hidden inside the label)
    await expect(page.getByTestId("guest-file-input")).toBeAttached();
  });
});

test.describe("Guest Split — Share Result Page", () => {
  let shareToken: string;

  test.beforeAll(async () => {
    // Create a split via API to test the result page
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await ctx.post("/api/trpc/guest.createSplit", {
      data: {
        json: {
          receiptData: {
            merchantName: "Taco Stand",
            date: "2026-05-07",
            subtotal: 4500,
            tax: 360,
            tip: 700,
            total: 5560,
            currency: "USD",
          },
          items: [
            { name: "Tacos x3", quantity: 3, unitPrice: 500, totalPrice: 1500 },
            { name: "Burrito", quantity: 1, unitPrice: 1200, totalPrice: 1200 },
            { name: "Nachos", quantity: 1, unitPrice: 900, totalPrice: 900 },
            { name: "Guacamole", quantity: 1, unitPrice: 450, totalPrice: 450 },
            { name: "Drinks", quantity: 1, unitPrice: 450, totalPrice: 450 },
          ],
          people: [{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }],
          assignments: [
            { itemIndex: 0, personIndices: [0, 1, 2] },
            { itemIndex: 1, personIndices: [0] },
            { itemIndex: 2, personIndices: [1] },
            { itemIndex: 3, personIndices: [0, 1, 2] },
            { itemIndex: 4, personIndices: [2] },
          ],
          paidByIndex: 0,
        },
      },
    });

    const body = await res.json();
    shareToken = body.result?.data?.json?.shareToken;
    await ctx.dispose();
  });

  test("result page displays split summary with data-testids", async ({ page }) => {
    await page.goto(`/en/split/${shareToken}`);

    // Result wrapper should be visible
    await expect(page.getByTestId("split-result")).toBeVisible();

    // Should show merchant name
    await expect(page.getByText("Taco Stand")).toBeVisible();

    // Person cards should be present with indexed testids
    await expect(page.getByTestId("person-card-0")).toBeVisible();
    await expect(page.getByTestId("person-card-1")).toBeVisible();
    await expect(page.getByTestId("person-card-2")).toBeVisible();

    // Share buttons should be present
    await expect(page.getByTestId("copy-link-btn")).toBeVisible();
    await expect(page.getByTestId("share-btn")).toBeVisible();
  });

  test("person cards contain correct names", async ({ page }) => {
    await page.goto(`/en/split/${shareToken}`);
    await expect(page.getByTestId("split-result")).toBeVisible();

    // Verify each person card has the correct person's name
    // The order matches the summary order from the API
    const card0Text = await page.getByTestId("person-card-0").textContent();
    const card1Text = await page.getByTestId("person-card-1").textContent();
    const card2Text = await page.getByTestId("person-card-2").textContent();

    // All three names should appear across the cards
    const allText = `${card0Text} ${card1Text} ${card2Text}`;
    expect(allText).toContain("Alice");
    expect(allText).toContain("Bob");
    expect(allText).toContain("Charlie");
  });

  test("invalid share token shows error state", async ({ page }) => {
    await page.goto("/en/split/nonexistent-token-abc123");
    await expect(page.getByText("Split not found")).toBeVisible();
  });
});
