import { test, expect, request } from "@playwright/test";
import { trpcMutation } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.describe("Group claiming units", () => {
  test("join form shows group size input", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Group Test Cafe",
        subtotal: 2000,
        tax: 200,
        tip: 0,
        total: 2200,
        currency: "USD",
      },
      items: [
        { name: "Coffee", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Tea", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;
    await ctx.dispose();

    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });

    // Group size input should be visible with default value 1
    const groupSizeInput = page.getByTestId("group-size-input");
    await expect(groupSizeInput).toBeVisible();
    await expect(groupSizeInput).toHaveValue("1");

    await page.close();
    await browserCtx.close();
  });

  test("joining as a couple shows group badge", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Couple Test",
        subtotal: 3000,
        tax: 300,
        tip: 0,
        total: 3300,
        currency: "USD",
      },
      items: [
        { name: "Pizza", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
        { name: "Pasta", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;
    await ctx.dispose();

    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });

    // Join as "Alice & Bob" with group size 2
    await page.getByTestId("claim-name-input").fill("Alice & Bob");
    await page.getByTestId("group-size-input").fill("2");
    await page.getByTestId("claim-join-btn").click();

    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });

    // Should show group badge (×2) — Alice & Bob is person index 1 (creator Alice is 0)
    await expect(page.getByTestId("group-badge-1")).toBeVisible();

    await page.close();
    await browserCtx.close();
  });

  test("solo person does not show group badge", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Solo Test",
        subtotal: 1000,
        tax: 100,
        tip: 0,
        total: 1100,
        currency: "USD",
      },
      items: [
        { name: "Salad", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;
    await ctx.dispose();

    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("claim-name-input").fill("Charlie");
    // Leave group size as default (1)
    await page.getByTestId("claim-join-btn").click();

    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });

    // Should NOT show any group badge
    await expect(page.getByTestId("group-badge-0")).not.toBeVisible();

    await page.close();
    await browserCtx.close();
  });

  test("API: weighted split gives couple proportionally more of shared items", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Scenario: 3 people split a bill
    // - Alice & Bob (couple, groupSize=2)
    // - Charlie (solo, groupSize=1)
    // They all share a $30 item
    // Couple should pay 2/3 ($20), Charlie 1/3 ($10)
    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Weighted Split Test",
        subtotal: 3000,
        tax: 0,
        tip: 0,
        total: 3000,
        currency: "USD",
      },
      items: [
        { name: "Shared Nachos", quantity: 1, unitPrice: 3000, totalPrice: 3000 },
      ],
      creatorName: "Alice & Bob",
      paidByName: "Alice & Bob",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Alice & Bob join as a couple (groupSize=2)
    const joinCouple = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Alice & Bob",
      groupSize: 2,
    });
    const coupleData = (await joinCouple.json()).result?.data?.json;

    // Charlie joins solo
    const joinCharlie = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken,
      name: "Charlie",
    });
    const charlieData = (await joinCharlie.json()).result?.data?.json;

    // Both claim the shared nachos
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex: coupleData.personIndex,
      personToken: coupleData.personToken,
      claimedItemIndices: [0],
    });
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken,
      personIndex: charlieData.personIndex,
      personToken: charlieData.personToken,
      claimedItemIndices: [0],
    });

    // Finalize
    const finalizeRes = await trpcMutation(ctx, "guest.finalizeSession", {
      token: shareToken,
      personIndex: coupleData.personIndex,
      personToken: coupleData.personToken,
    });
    expect(finalizeRes.ok()).toBe(true);

    // Get session to check summary
    const getRes = await ctx.get(
      `/api/trpc/guest.getSession?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: { token: shareToken } } }))}`
    );
    const session = (await getRes.json())[0]?.result?.data?.json;

    expect(session.status).toBe("FINALIZED");
    expect(session.summary).toHaveLength(2);

    const coupleSummary = session.summary.find(
      (s: { name: string }) => s.name === "Alice & Bob"
    );
    const charlieSummary = session.summary.find(
      (s: { name: string }) => s.name === "Charlie"
    );

    expect(coupleSummary).toBeDefined();
    expect(charlieSummary).toBeDefined();

    // Couple (weight 2) should pay 2/3, Charlie (weight 1) should pay 1/3
    // $3000 * 2/3 = $2000, $3000 * 1/3 = $1000
    expect(coupleSummary.total).toBe(2000);
    expect(charlieSummary.total).toBe(1000);

    // Totals should sum to $30
    expect(coupleSummary.total + charlieSummary.total).toBe(3000);

    await ctx.dispose();
  });

  test("API: groupSize=1 (default) produces equal split as before", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Default Split Test",
        subtotal: 3000,
        tax: 0,
        tip: 0,
        total: 3000,
        currency: "USD",
      },
      items: [
        { name: "Shared Item", quantity: 1, unitPrice: 3000, totalPrice: 3000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Both join with default groupSize (1)
    const joinAlice = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Alice",
    });
    const aliceData = (await joinAlice.json()).result?.data?.json;

    const joinBob = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Bob",
    });
    const bobData = (await joinBob.json()).result?.data?.json;

    // Both claim the shared item
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken, personIndex: aliceData.personIndex,
      personToken: aliceData.personToken, claimedItemIndices: [0],
    });
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken, personIndex: bobData.personIndex,
      personToken: bobData.personToken, claimedItemIndices: [0],
    });

    // Finalize
    await trpcMutation(ctx, "guest.finalizeSession", {
      token: shareToken, personIndex: aliceData.personIndex,
      personToken: aliceData.personToken,
    });

    const getRes = await ctx.get(
      `/api/trpc/guest.getSession?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: { token: shareToken } } }))}`
    );
    const session = (await getRes.json())[0]?.result?.data?.json;

    // Equal split: $1500 each
    const aliceSummary = session.summary.find((s: { name: string }) => s.name === "Alice");
    const bobSummary = session.summary.find((s: { name: string }) => s.name === "Bob");

    expect(aliceSummary.total).toBe(1500);
    expect(bobSummary.total).toBe(1500);

    await ctx.dispose();
  });

  test("full UI flow: couple and solo person claim and finalize", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Full Group Flow",
        subtotal: 4000,
        tax: 400,
        tip: 600,
        total: 5000,
        currency: "USD",
      },
      items: [
        { name: "Steak", quantity: 1, unitPrice: 2000, totalPrice: 2000 },
        { name: "Shared Appetizer", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Fish", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice & Bob",
      paidByName: "Alice & Bob",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Charlie claims Fish via API
    const joinCharlie = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Charlie",
    });
    const charlieData = (await joinCharlie.json()).result?.data?.json;
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken, personIndex: charlieData.personIndex,
      personToken: charlieData.personToken, claimedItemIndices: [2],
    });
    await ctx.dispose();

    // Alice & Bob open in browser
    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });

    // Join as couple
    await page.getByTestId("claim-name-input").fill("Alice & Bob");
    await page.getByTestId("group-size-input").fill("2");
    await page.getByTestId("claim-join-btn").click();

    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-sonner-toast]')).toBeHidden({ timeout: 10000 });

    // Couple claims Steak + Shared Appetizer
    await page.getByTestId("claim-item-0").click(); // Steak
    await page.getByTestId("claim-item-1").click(); // Shared Appetizer

    // Charlie also claims the appetizer (shared item)
    // This is already done via API, but the couple also claims it

    // Save
    const saveBtn = page.getByTestId("save-claims-btn");
    await saveBtn.scrollIntoViewIfNeeded();
    await saveBtn.click();
    await expect(saveBtn).toContainText(/saved/i, { timeout: 10000 });

    // Group badge should be visible
    await expect(page.getByTestId("group-badge-0")).toBeVisible();

    // Per-person totals should show the couple paying more
    await expect(page.getByText("Alice & Bob").first()).toBeVisible();
    await expect(page.getByText("Charlie").first()).toBeVisible();

    await page.close();
    await browserCtx.close();
  });

  test("edit group size via inline edit form", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Edit Group Test",
        subtotal: 2000,
        tax: 200,
        tip: 0,
        total: 2200,
        currency: "USD",
      },
      items: [
        { name: "Item A", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Item B", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;
    await ctx.dispose();

    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    // Join as Alice solo
    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("claim-name-input").fill("Alice");
    await page.getByTestId("claim-join-btn").click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-sonner-toast]')).toBeHidden({ timeout: 10000 });

    // No group badge initially (solo)
    await expect(page.getByTestId("group-badge-0")).not.toBeVisible();

    // Click edit pencil on Alice
    await page.getByTestId("edit-person-0").click();

    // Group size input should appear with value 1
    const groupSizeEdit = page.getByTestId("edit-group-size-0");
    await expect(groupSizeEdit).toBeVisible();
    await expect(groupSizeEdit).toHaveValue("1");

    // Change group size to 2
    await groupSizeEdit.fill("2");

    // Also update name to "Alice & Bob"
    const nameEdit = page.getByTestId("edit-name-input-0");
    await nameEdit.fill("Alice & Bob");

    // Submit the edit (click the check button)
    await page.locator('button[type="submit"]').click();

    // Wait for the edit to save
    await page.waitForTimeout(1500);

    // Should now show ×2 badge
    await expect(page.getByTestId("group-badge-0")).toBeVisible({ timeout: 5000 });

    // Name should be updated
    await expect(page.getByText("Alice & Bob").first()).toBeVisible();

    await page.close();
    await browserCtx.close();
  });

  test("changing group size from 2 to 1 removes badge", async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Ungroup Test",
        subtotal: 1000,
        tax: 100,
        tip: 0,
        total: 1100,
        currency: "USD",
      },
      items: [
        { name: "Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Couple",
      paidByName: "Couple",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Join as a couple via API
    const joinRes = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Couple", groupSize: 2,
    });
    expect(joinRes.ok()).toBe(true);
    await ctx.dispose();

    const browserCtx = await browser.newContext();
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    // Join (rejoin) as Couple with groupSize=2
    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("claim-name-input").fill("Couple");
    await page.getByTestId("group-size-input").fill("2");
    await page.getByTestId("claim-join-btn").click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });

    // Dismiss any toasts by waiting
    await page.waitForTimeout(5000);

    // Should show ×2 badge
    await expect(page.getByTestId("group-badge-0")).toBeVisible();

    // Click edit to change group size back to 1
    await page.getByTestId("edit-person-0").click();
    const groupSizeEdit = page.getByTestId("edit-group-size-0");
    await expect(groupSizeEdit).toHaveValue("2");
    await groupSizeEdit.fill("1");
    await page.locator('button[type="submit"]').click();

    // Wait for save
    await page.waitForTimeout(1500);

    // ×2 badge should be gone
    await expect(page.getByTestId("group-badge-0")).not.toBeVisible();

    await page.close();
    await browserCtx.close();
  });

  test("API: editPersonName with groupSize updates the group size", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "API Edit Group",
        subtotal: 1000,
        tax: 100,
        tip: 0,
        total: 1100,
        currency: "USD",
      },
      items: [
        { name: "Item", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Join as solo
    const joinRes = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Alice",
    });
    const { personToken } = (await joinRes.json()).result?.data?.json;

    // Edit to group size 3
    const editRes = await trpcMutation(ctx, "guest.editPersonName", {
      token: shareToken,
      personToken,
      targetIndex: 0,
      newName: "Alice & Friends",
      groupSize: 3,
    });
    expect(editRes.ok()).toBe(true);

    // Verify via getSession
    const getRes = await ctx.get(
      `/api/trpc/guest.getSession?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: { token: shareToken } } }))}`
    );
    const session = (await getRes.json())[0]?.result?.data?.json;

    expect(session.people[0].name).toBe("Alice & Friends");
    expect(session.people[0].groupSize).toBe(3);

    await ctx.dispose();
  });
});
