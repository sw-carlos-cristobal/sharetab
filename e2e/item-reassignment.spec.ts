import { test, expect, request } from "@playwright/test";
import { trpcMutation } from "./helpers";

const BASE = process.env.BASE_URL || "http://localhost:3001";

test.use({ viewport: { width: 430, height: 932 } });

test.describe("Item reassignment via person switcher", () => {
  test("creator can switch person and reassign items between people", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const ctx = await request.newContext({ baseURL: BASE });

    // Create session with 3 items
    const createRes = await trpcMutation(ctx, "guest.createClaimSession", {
      receiptData: {
        merchantName: "Reassignment Demo",
        subtotal: 3000,
        tax: 300,
        tip: 0,
        total: 3300,
        currency: "USD",
      },
      items: [
        { name: "Burger", quantity: 1, unitPrice: 1200, totalPrice: 1200 },
        { name: "Salad", quantity: 1, unitPrice: 800, totalPrice: 800 },
        { name: "Fries", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: "Alice",
      paidByName: "Alice",
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Bob joins and claims Burger + Fries via API
    const joinBob = await trpcMutation(ctx, "guest.joinSession", {
      token: shareToken, name: "Bob",
    });
    const bobData = (await joinBob.json()).result?.data?.json;
    await trpcMutation(ctx, "guest.claimItems", {
      token: shareToken, personIndex: bobData.personIndex,
      personToken: bobData.personToken, claimedItemIndices: [0, 2],
    });
    await ctx.dispose();

    // Alice opens in browser
    const browserCtx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const page = await browserCtx.newPage();
    await page.goto(`/en/split/${shareToken}/claim`);

    // Join as Alice
    await expect(page.getByTestId("claim-join-form")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("claim-name-input").fill("Alice");
    await page.getByTestId("claim-join-btn").click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-sonner-toast]')).toBeHidden({ timeout: 10000 });

    // Alice claims Salad for herself
    await page.getByTestId("claim-item-1").click();
    const saveBtn = page.getByTestId("save-claims-btn");
    await saveBtn.scrollIntoViewIfNeeded();
    await saveBtn.click();
    await expect(saveBtn).toContainText(/saved/i, { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Screenshot 1: Alice's view — she has Salad, Bob has Burger + Fries
    await page.evaluate(() => window.scrollTo({ top: 200, behavior: "instant" }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: "docs/screenshots/reassign-before.png" });

    // Now Alice switches to claiming for Bob
    await page.getByTestId("switch-person-1").click();
    await page.waitForTimeout(500);

    // Screenshot 2: Switched to Bob — can see Bob's claims
    await page.screenshot({ path: "docs/screenshots/reassign-switch-to-bob.png" });

    // Unclaim Fries from Bob (Bob claimed wrong item)
    await page.getByTestId("claim-item-2").click();
    await expect(page.getByTestId("claim-item-2")).toHaveAttribute("aria-pressed", "false");

    // Save Bob's updated claims
    await saveBtn.scrollIntoViewIfNeeded();
    await saveBtn.click();
    await expect(saveBtn).toContainText(/saved/i, { timeout: 10000 });
    await page.waitForTimeout(1000);

    // Switch back to Alice
    await page.getByTestId("switch-person-0").click();
    await page.waitForTimeout(500);

    // Claim Fries for Alice instead
    await page.getByTestId("claim-item-2").click();
    await expect(page.getByTestId("claim-item-2")).toHaveAttribute("aria-pressed", "true");

    // Save Alice's updated claims
    await saveBtn.scrollIntoViewIfNeeded();
    await saveBtn.click();
    await expect(saveBtn).toContainText(/saved/i, { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Screenshot 3: After reassignment — Alice has Salad + Fries, Bob has Burger
    await page.evaluate(() => window.scrollTo({ top: 200, behavior: "instant" }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: "docs/screenshots/reassign-after.png" });

    // Verify: Alice should have items 1 (Salad) and 2 (Fries) claimed
    await expect(page.getByTestId("claim-item-1")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("claim-item-2")).toHaveAttribute("aria-pressed", "true");

    // Switch to Bob and verify he only has Burger now
    await page.getByTestId("switch-person-1").click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("claim-item-0")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("claim-item-2")).toHaveAttribute("aria-pressed", "false");

    await page.close();
    await browserCtx.close();
  });
});
