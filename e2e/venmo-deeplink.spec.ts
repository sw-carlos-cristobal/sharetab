import { test, expect, request } from "@playwright/test";
import { login, users, authedContext, trpcMutation, trpcQuery, trpcResult } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.use({ viewport: { width: 430, height: 932 } });

test.describe("Venmo deeplink payments", () => {
  test.beforeAll(async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(ctx, "admin.setVenmoEnabled", { enabled: true });
    await ctx.dispose();
  });

  test.afterAll(async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(ctx, "admin.setVenmoEnabled", { enabled: false });
    await ctx.dispose();
  });

  test("creator sees editable venmo handle input on split result page", async ({ browser }) => {
    const aliceCtx = await authedContext(users.alice.email, users.alice.password);
    const createRes = await trpcMutation(aliceCtx, "guest.createSplit", {
      receiptData: {
        merchantName: "Venmo Test Cafe",
        subtotal: 3000,
        tax: 300,
        tip: 400,
        total: 3700,
        currency: "USD",
      },
      items: [
        { name: "Latte", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
        { name: "Muffin", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
      ],
      people: [{ name: "Alice Johnson" }, { name: "Bob" }],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [1] },
      ],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;
    await aliceCtx.dispose();

    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/split/${shareToken}`);

    const venmoInput = page.getByTestId("venmo-handle-input");
    await expect(venmoInput).toBeVisible({ timeout: 15000 });

    // No pay buttons yet (creator is payer — buttons hidden)
    await expect(page.locator('[data-testid^="venmo-pay-"]')).toHaveCount(0);

    await page.close();
    await browserCtx.close();
  });

  test("guest sees pay buttons when payer handle is set", async ({ browser }) => {
    // Create as authenticated Alice with venmo handle set
    const aliceCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(aliceCtx, "auth.updateProfile", { venmoUsername: "alice-venmo" });
    const createRes = await trpcMutation(aliceCtx, "guest.createSplit", {
      receiptData: {
        merchantName: "Pay Button Test",
        subtotal: 4000,
        tax: 400,
        tip: 600,
        total: 5000,
        currency: "USD",
      },
      items: [
        { name: "Steak", quantity: 1, unitPrice: 2000, totalPrice: 2000 },
        { name: "Salad", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: "Dessert", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      people: [{ name: "Alice Johnson" }, { name: "Bob" }, { name: "Charlie" }],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [1] },
        { itemIndex: 2, personIndices: [2] },
      ],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;
    await aliceCtx.dispose();

    // Guest views the split — pay buttons should show for non-payers
    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}`);

    await expect(page.getByTestId("venmo-handle-display")).toBeVisible({ timeout: 15000 });

    const payButtons = page.locator('[data-testid^="venmo-pay-"]');
    await expect(payButtons).toHaveCount(2, { timeout: 5000 });

    const firstPayHref = await payButtons.first().getAttribute("href");
    expect(firstPayHref).toContain("venmo.com/alice-venmo");
    expect(firstPayHref).toContain("txn=pay");

    await page.screenshot({ path: "docs/screenshots/venmo-pay-buttons.png" });

    // Clean up
    const cleanCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(cleanCtx, "auth.updateProfile", { venmoUsername: null });
    await cleanCtx.dispose();

    await page.close();
    await browserCtx.close();
  });

  test("venmo deeplink has correct amount and note", async ({ browser }) => {
    const aliceCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(aliceCtx, "auth.updateProfile", { venmoUsername: "alice-pays" });
    const createRes = await trpcMutation(aliceCtx, "guest.createSplit", {
      receiptData: {
        merchantName: "Pizza Palace",
        subtotal: 2500,
        tax: 250,
        tip: 350,
        total: 3100,
        currency: "USD",
      },
      items: [
        { name: "Large Pizza", quantity: 1, unitPrice: 2500, totalPrice: 2500 },
      ],
      people: [{ name: "Alice Johnson" }, { name: "Bob" }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;
    await aliceCtx.dispose();

    // Guest views — verify deeplink URL
    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}`);

    await expect(page.getByTestId("venmo-handle-display")).toBeVisible({ timeout: 15000 });
    const payBtn = page.locator('[data-testid^="venmo-pay-"]').first();
    await expect(payBtn).toBeVisible();
    const href = await payBtn.getAttribute("href");

    expect(href).toContain("venmo.com/alice-pays");
    expect(href).toContain("txn=pay");
    expect(href).toMatch(/amount=\d+\.\d{2}/);
    expect(href).toContain("Pizza%20Palace");

    // Clean up
    const cleanCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(cleanCtx, "auth.updateProfile", { venmoUsername: null });
    await cleanCtx.dispose();

    await page.close();
    await browserCtx.close();
  });

  test("guest sees payer venmo handle auto-populated from creator profile", async ({ browser }) => {
    // Set Alice's venmoUsername via profile update
    const aliceCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(aliceCtx, "auth.updateProfile", { venmoUsername: "alice-venmo-e2e" });

    // Create a split as authenticated Alice
    const createRes = await trpcMutation(aliceCtx, "guest.createSplit", {
      receiptData: {
        merchantName: "Auto-Populate Test",
        subtotal: 2000,
        tax: 200,
        tip: 300,
        total: 2500,
        currency: "USD",
      },
      items: [
        { name: "Burger", quantity: 1, unitPrice: 2000, totalPrice: 2000 },
      ],
      people: [{ name: "Alice Johnson" }, { name: "Bob" }],
      assignments: [
        { itemIndex: 0, personIndices: [0, 1] },
      ],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;

    // Verify the split record has the handle stored (name must match profile)
    const splitRes = await trpcQuery(aliceCtx, "guest.getSplit", { token: shareToken });
    const splitData = await trpcResult(splitRes);
    expect(splitData.payerVenmoHandle).toBe("alice-venmo-e2e");
    await aliceCtx.dispose();

    // Open the split as an unauthenticated guest in a fresh browser context
    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}`);

    // Guest sees the handle as read-only text (not an editable input)
    const venmoDisplay = page.getByTestId("venmo-handle-display");
    await expect(venmoDisplay).toBeVisible({ timeout: 15000 });
    await expect(venmoDisplay).toContainText("alice-venmo-e2e");
    await expect(page.getByTestId("venmo-handle-input")).toHaveCount(0);

    // Pay buttons should appear for Bob (non-payer)
    const payButtons = page.locator('[data-testid^="venmo-pay-"]');
    await expect(payButtons).toHaveCount(1, { timeout: 5000 });
    const href = await payButtons.first().getAttribute("href");
    expect(href).toContain("venmo.com/alice-venmo-e2e");

    // Screenshot: guest sees payer's handle auto-populated
    await page.screenshot({ path: "docs/screenshots/venmo-guest-sees-payer-handle.png", fullPage: true });

    await page.close();
    await browserCtx.close();

    // Screenshot: creator sees own handle on the same split (logged in)
    const creatorCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const creatorPage = await creatorCtx.newPage();
    await login(creatorPage, users.alice.email, users.alice.password);
    await creatorPage.goto(`/en/split/${shareToken}`);
    await expect(creatorPage.getByTestId("venmo-handle-input")).toHaveValue("alice-venmo-e2e", { timeout: 15000 });
    await creatorPage.screenshot({ path: "docs/screenshots/venmo-creator-sees-own-handle.png", fullPage: true });

    // Clean up Alice's venmo handle
    const cleanCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(cleanCtx, "auth.updateProfile", { venmoUsername: null });
    await cleanCtx.dispose();

    await creatorPage.close();
    await creatorCtx.close();
  });

  test("changing venmo handle persists to split record across reload", async ({ browser }) => {
    // Create as authenticated Alice (so userId is set and isCreator works)
    const aliceCtx = await authedContext(users.alice.email, users.alice.password);
    const createRes = await trpcMutation(aliceCtx, "guest.createSplit", {
      receiptData: {
        merchantName: "Persist Split Test",
        subtotal: 1500,
        tax: 150,
        tip: 200,
        total: 1850,
        currency: "USD",
      },
      items: [
        { name: "Tea", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
      ],
      people: [{ name: "Alice Johnson" }, { name: "Bob" }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;
    await aliceCtx.dispose();

    // Login as Alice and open the split
    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/split/${shareToken}`);

    const venmoInput = page.getByTestId("venmo-handle-input");
    await expect(venmoInput).toBeVisible({ timeout: 15000 });

    // Type a new handle and blur to trigger save
    await venmoInput.fill("updated-handle");
    await venmoInput.blur();

    // Wait for mutation by checking network idle
    await page.waitForResponse((r) => r.url().includes("setPayerVenmoHandle") && r.status() === 200, { timeout: 10000 });

    // Reload and verify the handle persisted from the split record
    await page.reload();
    await expect(page.getByTestId("venmo-handle-input")).toHaveValue("updated-handle", { timeout: 15000 });

    await page.close();
    await browserCtx.close();
  });

  test("creator/payer does not see pay buttons on their own split", async ({ browser }) => {
    const aliceCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(aliceCtx, "auth.updateProfile", { venmoUsername: "alice-payer-test" });

    // Create split where Alice is the payer
    const createRes = await trpcMutation(aliceCtx, "guest.createSplit", {
      receiptData: {
        merchantName: "Payer No Buttons Test",
        subtotal: 3000,
        tax: 300,
        tip: 0,
        total: 3300,
        currency: "USD",
      },
      items: [
        { name: "Pasta", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
        { name: "Salad", quantity: 1, unitPrice: 1500, totalPrice: 1500 },
      ],
      people: [{ name: "Alice Johnson" }, { name: "Bob" }],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [1] },
      ],
      paidByIndex: 0,
    });
    const { shareToken } = (await createRes.json()).result?.data?.json;
    await aliceCtx.dispose();

    // Creator (Alice) views the split — should see input but NO pay buttons
    const creatorBrowser = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const creatorPage = await creatorBrowser.newPage();
    await login(creatorPage, users.alice.email, users.alice.password);
    await creatorPage.goto(`/en/split/${shareToken}`);

    await expect(creatorPage.getByTestId("venmo-handle-input")).toBeVisible({ timeout: 15000 });
    await expect(creatorPage.locator('[data-testid^="venmo-pay-"]')).toHaveCount(0);
    await creatorPage.screenshot({ path: "docs/screenshots/venmo-creator-no-pay-buttons.png", fullPage: true });

    await creatorPage.close();
    await creatorBrowser.close();

    // Guest (Bob) views the same split — should see read-only handle AND pay button
    const guestBrowser = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const guestPage = await guestBrowser.newPage();
    await guestPage.goto(`/en/split/${shareToken}`);

    await expect(guestPage.getByTestId("venmo-handle-display")).toBeVisible({ timeout: 15000 });
    const payButtons = guestPage.locator('[data-testid^="venmo-pay-"]');
    await expect(payButtons).toHaveCount(1, { timeout: 5000 });
    await guestPage.screenshot({ path: "docs/screenshots/venmo-guest-sees-pay-buttons.png", fullPage: true });

    // Clean up
    const cleanCtx = await authedContext(users.alice.email, users.alice.password);
    await trpcMutation(cleanCtx, "auth.updateProfile", { venmoUsername: null });
    await cleanCtx.dispose();

    await guestPage.close();
    await guestBrowser.close();
  });
});
