import { test, expect, request, type Page, type Route } from '@playwright/test';
import { joinGuestSession, trpcMutation } from './helpers';
import { claimStorageKey } from '../src/lib/guest-session';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// Issue #213: tabs of one browser share the stored claim identity. A join, or an accepted
// personal link, whose answer comes back after another tab became someone else must not replace
// that tab's person in storage (the later answer used to win, not the later action).

async function createSession(merchantName: string) {
  const ctx = await request.newContext({ baseURL: BASE });
  const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
    receiptData: { merchantName, subtotal: 2000, tax: 0, tip: 0, total: 2000, currency: 'USD' },
    items: [
      { name: 'Tea', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      { name: 'Cake', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
    ],
    creatorName: 'Ann',
    paidByName: 'Ann',
  });
  expect(createRes.ok(), await createRes.text()).toBe(true);
  const shareToken: string = (await createRes.json()).result.data.json.shareToken;
  return { ctx, shareToken };
}

/**
 * Hold the page's next call to a guest procedure: the request reaches the server, but its answer
 * is handed to the page only once `release` is called. `answered` settles once the server has
 * answered.
 */
async function holdNextAnswer(page: Page, procedure: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let serverAnswered = () => {};
  const answered = new Promise<void>((resolve) => (serverAnswered = resolve));
  await page.route(
    (url) => url.pathname.includes(procedure),
    async (route: Route) => {
      const response = await route.fetch();
      serverAnswered();
      await released;
      // The page may have closed by now
      await route.fulfill({ response }).catch(() => {});
    },
    { times: 1 },
  );
  return { answered, release };
}

async function storedToken(page: Page, shareToken: string): Promise<string | undefined> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), claimStorageKey(shareToken));
  return raw ? (JSON.parse(raw) as { personToken: string }).personToken : undefined;
}

async function joinAs(page: Page, name: string) {
  await page.getByTestId('claim-name-input').fill(name);
  await page.getByTestId('claim-join-btn').click();
}

test.describe('claim page identity across tabs (#213)', () => {
  test("a join answered after another tab joined keeps that tab's person", async ({ browser }) => {
    const { ctx, shareToken } = await createSession('Two Tabs Diner');
    const browserCtx = await browser.newContext();
    const tabA = await browserCtx.newPage();
    const tabB = await browserCtx.newPage();
    await tabA.goto(`/en/split/${shareToken}/claim`);
    await tabB.goto(`/en/split/${shareToken}/claim`);
    await expect(tabA.getByTestId('claim-join-form')).toBeVisible({ timeout: 15000 });
    await expect(tabB.getByTestId('claim-join-form')).toBeVisible({ timeout: 15000 });

    // Tab A joins as Alice; the server creates her, but tab A doesn't hear back yet
    const aliceJoin = await holdNextAnswer(tabA, 'guest.joinSession');
    await joinAs(tabA, 'Alice');
    await aliceJoin.answered;

    // Meanwhile tab B joins as Bob
    await joinAs(tabB, 'Bob');
    await expect(tabB.getByText('Bob (you)').first()).toBeVisible({ timeout: 15000 });
    const bobsToken = await storedToken(tabB, shareToken);
    expect(bobsToken).toMatch(/^[0-9a-f-]{36}$/);

    // Tab A's answer arrives: it keeps Bob and continues as him, instead of storing Alice
    aliceJoin.release();
    await expect(tabA.getByText('Continuing as Bob')).toBeVisible({ timeout: 15000 });
    await expect(tabA.getByText('Bob (you)').first()).toBeVisible({ timeout: 15000 });
    expect(await storedToken(tabA, shareToken)).toBe(bobsToken);

    // After a reload this browser is still Bob
    await tabA.reload();
    await expect(tabA.getByText('Bob (you)').first()).toBeVisible({ timeout: 15000 });
    expect(await storedToken(tabA, shareToken)).toBe(bobsToken);

    await browserCtx.close();
    await ctx.dispose();
  });

  test('accepting a personal link answered after another tab joined asks again', async ({ browser }) => {
    const { ctx, shareToken } = await createSession('Two Tabs Link Bar');
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    const browserCtx = await browser.newContext();
    const tabA = await browserCtx.newPage();
    const tabB = await browserCtx.newPage();
    await tabA.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(tabA.getByTestId('personal-link-offer')).toContainText("This is Alice's personal link", {
      timeout: 15000,
    });
    // Nobody is stored yet, so the card doesn't say it replaces anyone
    await expect(tabA.getByTestId('personal-link-offer-replaces')).toHaveCount(0);
    await tabB.goto(`/en/split/${shareToken}/claim`);
    await expect(tabB.getByTestId('claim-join-form')).toBeVisible({ timeout: 15000 });

    // Tab A accepts Alice's link; the lookup's answer is held
    const accept = await holdNextAnswer(tabA, 'guest.resumeSession');
    await tabA.getByTestId('personal-link-accept').click();
    await accept.answered;

    // Meanwhile tab B joins as Bob
    await joinAs(tabB, 'Bob');
    await expect(tabB.getByText('Bob (you)').first()).toBeVisible({ timeout: 15000 });
    const bobsToken = await storedToken(tabB, shareToken);

    // The accept's answer arrives: tab A asks again, now saying continuing replaces Bob
    accept.release();
    await expect(tabA.getByTestId('personal-link-offer-replaces')).toContainText(
      'This device joined this split as Bob',
      { timeout: 15000 },
    );
    expect(await storedToken(tabA, shareToken)).toBe(bobsToken);

    // Accepting again, knowing that, switches this browser to Alice
    await tabA.getByTestId('personal-link-accept').click();
    await expect(tabA.getByText('Alice (you)').first()).toBeVisible({ timeout: 15000 });
    expect(await storedToken(tabA, shareToken)).toBe(alice.personToken);

    await browserCtx.close();
    await ctx.dispose();
  });
});
