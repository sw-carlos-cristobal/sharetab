import { test, expect, request } from '@playwright/test';
import {
  joinGuestSession,
  rememberClaimIdentity,
  trpcMutation,
  trpcResult,
  trpcQuery,
  FAKE_PNG,
  authedContext,
  users,
} from './helpers';
import { claimStorageKey } from '../src/lib/guest-session';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

test.describe('Claim page — rejoin buttons', () => {
  test("offers people nobody has joined as yet, but won't let a new device take over someone who joined", async ({
    page,
  }) => {
    // Alice created the split and Pat paid; only Alice has joined
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Rejoin Cafe',
        subtotal: 2000,
        tax: 200,
        tip: 100,
        total: 2300,
        currency: 'USD',
      },
      items: [
        { name: 'Coffee', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        { name: 'Muffin', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: 'Alice',
      paidByName: 'Pat',
    });
    expect(createRes.ok()).toBe(true);
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    await ctx.dispose();

    // A browser without Alice's stored identity sees a join button for Pat only
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('rejoin-person-1')).toContainText('Pat');
    await expect(page.getByTestId('rejoin-person-0')).toHaveCount(0);

    // Typing Alice's name is refused, and the page stays on the join form
    await page.getByTestId('claim-name-input').fill('alice');
    await page.getByTestId('claim-join-btn').click();
    await expect(page.getByText('Someone has already joined under this name')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('claim-join-form')).toBeVisible();
    await expect(page.locator('[data-testid^="claim-item-"]')).toHaveCount(0);
  });

  test('clicking rejoin button auto-joins as that person', async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create session with Carol as creator — she's in people[] but has no personToken yet
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Auto Join Diner',
        subtotal: 1500,
        tax: 150,
        tip: 200,
        total: 1850,
        currency: 'USD',
      },
      items: [{ name: 'Burger', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      creatorName: 'Carol',
      paidByName: 'Carol',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;
    await ctx.dispose();

    // Open in browser and click Carol's rejoin button (first join — no token needed)
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('rejoin-person-0').click();

    // Should auto-join and show claim items (join form disappears)
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
  });

  test('double-tapping a join button sends one join', async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Double Tap Diner', subtotal: 1500, tax: 0, tip: 0, total: 1500, currency: 'USD' },
      items: [{ name: 'Burger', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      creatorName: 'Carol',
      paidByName: 'Carol',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Count joinSession calls, not requests: tRPC's batch link can put two calls in one request
    // (the path then lists the procedure once per call, e.g. guest.joinSession,guest.joinSession)
    let joinCalls = 0;
    page.on('request', (req) => {
      const procedures = new URL(req.url()).pathname.split('/').pop()?.split(',') ?? [];
      joinCalls += procedures.filter((p) => p === 'guest.joinSession').length;
    });

    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('rejoin-person-0').dblclick();

    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
    await page.waitForLoadState('networkidle');
    // Only one join is sent (the synchronous guard); networkidle above waits out a late second one
    expect(joinCalls).toBe(1);
    const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
    expect(session.people).toHaveLength(1);
    await ctx.dispose();
  });

  test('someone who renamed themselves is still recognized when they come back', async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Rename Bistro', subtotal: 1500, tax: 0, tip: 0, total: 1500, currency: 'USD' },
      items: [{ name: 'Soup', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      creatorName: 'Alice',
      paidByName: 'Alice',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    await page.goto(`/en/split/${shareToken}/claim`);
    await page.getByTestId('rejoin-person-0').click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });

    // Rename herself, then come back to the page
    await page.getByTestId('edit-person-0').click();
    await page.getByTestId('edit-name-input-0').fill('Alice S.');
    await page.locator('button[type="submit"]').click();
    await expect(page.getByText('Alice S. (you)').first()).toBeVisible({ timeout: 10000 });
    await page.reload();

    // Still recognized as the same person: no second "Alice" was created
    await expect(page.getByText('Alice S. (you)').first()).toBeVisible({ timeout: 15000 });
    const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
    expect(session.people.map((p: { name: string }) => p.name)).toEqual(['Alice S.']);
    await ctx.dispose();
  });

  test('a join whose response was lost can be retried as the same person', async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Flaky Wifi Cafe', subtotal: 1500, tax: 0, tip: 0, total: 1500, currency: 'USD' },
      items: [{ name: 'Latte', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      creatorName: 'Host',
      paidByName: 'Host',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // The first join reaches the server and is saved, but its response never reaches the page
    let dropped = false;
    let joinKey = '';
    await page.route(
      (url) => url.pathname.includes('guest.joinSession'),
      async (route) => {
        if (dropped) return route.continue();
        dropped = true;
        joinKey = /"joinKey":"([0-9a-f-]{36})"/.exec(route.request().postData() ?? '')?.[1] ?? '';
        await route.fetch();
        await route.abort('connectionreset');
      },
    );
    await page.goto(`/en/split/${shareToken}/claim`);
    await page.getByTestId('claim-name-input').fill('Carol');
    await page.getByTestId('claim-join-btn').click();
    await expect.poll(() => dropped).toBe(true);
    await expect(page.getByTestId('claim-join-form')).toBeVisible();

    // The pending join key stays in memory: nothing in storage could be redeemed for Carol
    expect(joinKey).toMatch(/^[0-9a-f-]{36}$/);
    const storage = await page.evaluate(() => JSON.stringify({ ...window.localStorage, ...window.sessionStorage }));
    expect(storage).not.toContain(joinKey);

    // Trying again gets Carol back, not "Someone has already joined under this name"
    await page.getByTestId('claim-join-btn').click();
    await expect(page.getByText('Carol (you)').first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Someone has already joined under this name')).toHaveCount(0);
    const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
    expect(session.people.map((p: { name: string }) => p.name)).toEqual(['Host', 'Carol']);
    await ctx.dispose();
  });

  test('a device whose person was removed forgets them and shows the join form', async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Removed Diner', subtotal: 1500, tax: 0, tip: 0, total: 1500, currency: 'USD' },
      items: [{ name: 'Pie', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      creatorName: 'Host',
      paidByName: 'Host',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;
    const host = await joinGuestSession(ctx, { token: shareToken, name: 'Host' });

    await page.goto(`/en/split/${shareToken}/claim`);
    await page.getByTestId('claim-name-input').fill('Carol');
    await page.getByTestId('claim-join-btn').click();
    await expect(page.getByText('Carol (you)').first()).toBeVisible({ timeout: 15000 });

    // The first join was remembered: a plain reload comes back as Carol
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), claimStorageKey(shareToken));
    expect(JSON.parse(stored ?? 'null')).toMatchObject({ name: 'Carol' });
    await page.reload();
    await expect(page.getByText('Carol (you)').first()).toBeVisible({ timeout: 15000 });

    // Someone else removes Carol, then her device comes back
    const removed = await trpcMutation(ctx, 'guest.removePerson', {
      token: shareToken,
      personToken: host.personToken,
      targetIndex: 1,
    });
    expect(removed.ok(), await removed.text()).toBe(true);
    await page.reload();
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 15000 });
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), claimStorageKey(shareToken)))
      .toBeNull();
    await ctx.dispose();
  });
});

test.describe('Claim page — continue on another device', () => {
  const DEAD_TOKEN = '33333333-3333-4333-8333-333333333333';

  async function createSession(merchantName: string) {
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName, subtotal: 1500, tax: 0, tip: 0, total: 1500, currency: 'USD' },
      items: [{ name: 'Tacos', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      creatorName: 'Alice',
      paidByName: 'Alice',
    });
    const shareToken: string = (await createRes.json()).result.data.json.shareToken;
    return { ctx, shareToken };
  }

  test('a personal link from one device brings the same person back on another', async ({ browser }) => {
    const { ctx, shareToken } = await createSession('Phone To PC');

    // Phone: join as Alice and copy the personal link (Web Share isn't used here, so it copies)
    const phone = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await phone.addInitScript(() => Object.defineProperty(navigator, 'share', { value: undefined }));
    const phonePage = await phone.newPage();
    await phonePage.goto(`/en/split/${shareToken}/claim`);
    await phonePage.getByTestId('rejoin-person-0').click();
    await expect(phonePage.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
    // The warning is on screen before anything is sent
    await expect(phonePage.getByTestId('personal-link-hint')).toContainText('Only open it on your own devices');
    await phonePage.getByTestId('personal-link-btn').click();
    await expect(phonePage.getByText('Personal link copied')).toBeVisible({ timeout: 10000 });
    const personalLink = await phonePage.evaluate(() => navigator.clipboard.readText());
    expect(personalLink).toContain(`/split/${shareToken}/claim#me=`);

    // PC: the link asks first, then resumes as Alice; the token leaves the address bar
    const pc = await browser.newContext();
    const pcPage = await pc.newPage();
    await pcPage.goto(personalLink);
    await expect(pcPage.getByTestId('personal-link-offer')).toContainText("This is Alice's personal link", {
      timeout: 15000,
    });
    await expect.poll(() => pcPage.url()).not.toContain('#me=');
    await pcPage.getByTestId('personal-link-accept').click();
    await expect(pcPage.getByText('Alice (you)').first()).toBeVisible({ timeout: 15000 });

    // The PC now remembers Alice: a reload resumes without asking again
    await pcPage.reload();
    await expect(pcPage.getByText('Alice (you)').first()).toBeVisible({ timeout: 15000 });
    await expect(pcPage.getByTestId('personal-link-offer')).toHaveCount(0);
    const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
    expect(session.people).toHaveLength(1);

    await phone.close();
    await pc.close();
    await ctx.dispose();
  });

  test("someone else's personal link asks first, and declining keeps this device's own person", async ({ browser }) => {
    const { ctx, shareToken } = await createSession('Wrong Link Bar');
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    const bob = await joinGuestSession(ctx, { token: shareToken, name: 'Bob' });

    // Bob's phone opens Alice's personal link (e.g. she shared it to the group by mistake)
    const bobsPhone = await browser.newContext();
    await rememberClaimIdentity(bobsPhone, shareToken, { name: 'Bob', personToken: bob.personToken });
    const page = await bobsPhone.newPage();
    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(page.getByTestId('personal-link-offer')).toContainText("This is Alice's personal link", {
      timeout: 15000,
    });
    await page.getByTestId('personal-link-decline').click();

    await expect(page.getByText('Bob (you)').first()).toBeVisible({ timeout: 15000 });
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), claimStorageKey(shareToken));
    expect(stored).toContain(bob.personToken);
    const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
    expect(session.people.map((p: { name: string }) => p.name)).toEqual(['Alice', 'Bob']);

    await bobsPhone.close();
    await ctx.dispose();
  });

  test('a dead personal link says so and falls back to the person this device already was', async ({ browser }) => {
    const { ctx, shareToken } = await createSession('Dead Link Diner');
    const bob = await joinGuestSession(ctx, { token: shareToken, name: 'Bob' });
    const bobsPhone = await browser.newContext();
    await rememberClaimIdentity(bobsPhone, shareToken, { name: 'Bob', personToken: bob.personToken });
    const page = await bobsPhone.newPage();

    await page.goto(`/en/split/${shareToken}/claim#me=${DEAD_TOKEN}`);
    await expect(page.getByText('This personal link no longer works')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Bob (you)').first()).toBeVisible({ timeout: 15000 });

    await bobsPhone.close();
    await ctx.dispose();
  });

  test('a personal link survives a failed first load, so a reload can still use it', async ({ page }) => {
    const { ctx, shareToken } = await createSession('Flaky Load Diner');
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });

    // The split fails to load (e.g. the read budget is spent): the token must stay in the URL
    const isGetSession = (url: URL) => url.pathname.includes('guest.getSession');
    await page.route(isGetSession, (route) => route.fulfill({ status: 500, body: 'unavailable' }));
    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await page.waitForTimeout(2000);
    expect(page.url()).toContain(`#me=${alice.personToken}`);

    // Once it loads, the link works and only then leaves the address bar
    await page.unroute(isGetSession);
    await page.reload();
    await expect(page.getByTestId('personal-link-offer')).toContainText("This is Alice's personal link", {
      timeout: 15000,
    });
    await expect.poll(() => page.url()).not.toContain('#me=');
    await ctx.dispose();
  });

  test('a dead personal link on a device with no identity leaves the join form up', async ({ page }) => {
    const { ctx, shareToken } = await createSession('Dead Link Deli');
    await page.goto(`/en/split/${shareToken}/claim#me=${DEAD_TOKEN}`);
    await expect(page.getByText('This personal link no longer works')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('claim-join-form')).toBeVisible();
    await expect.poll(() => page.url()).not.toContain('#me=');
    await ctx.dispose();
  });

  test('a personal link works on a finalized split too', async ({ browser }) => {
    const { ctx, shareToken } = await createSession('Finalized Link Pub');
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    const finalize = await trpcMutation(ctx, 'guest.finalizeSession', {
      token: shareToken,
      personIndex: alice.personIndex,
      personToken: alice.personToken,
    });
    expect(finalize.ok(), await finalize.text()).toBe(true);

    const pc = await browser.newContext();
    const page = await pc.newPage();
    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(page.getByTestId('personal-link-offer')).toContainText("This is Alice's personal link", {
      timeout: 15000,
    });
    await page.getByTestId('personal-link-accept').click();
    await expect(page.getByText('Continuing as Alice')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('personal-link-offer')).toHaveCount(0);
    // And the finalized view ("View summary" is only there) offers this person's own link
    await expect(page.getByText('View summary')).toBeVisible();
    await expect(page.locator('[data-testid^="claim-item-"]')).toHaveCount(0);
    await expect(page.getByTestId('personal-link-btn')).toBeVisible();

    await pc.close();
    await ctx.dispose();
  });

  test("accepting someone else's link on a device that already joined says who it replaces", async ({ browser }) => {
    const { ctx, shareToken } = await createSession('Switch Device Cafe');
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    const bob = await joinGuestSession(ctx, { token: shareToken, name: 'Bob' });

    const bobsPhone = await browser.newContext();
    const page = await bobsPhone.newPage();
    // Plant Bob's identity once (not with rememberClaimIdentity, which re-plants it on every
    // navigation and would hide what accepting stored)
    await page.goto(`/en/split/${shareToken}/claim`);
    await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
      key: claimStorageKey(shareToken),
      value: JSON.stringify({ name: 'Bob', personToken: bob.personToken }),
    });
    // Open the link fresh (a pasted link is covered by its own test)
    await page.goto('about:blank');
    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(page.getByTestId('personal-link-offer-replaces')).toContainText(
      'This device joined this split as Bob. Continuing switches it to Alice',
      { timeout: 15000 },
    );
    await page.getByTestId('personal-link-accept').click();
    await expect(page.getByText('Alice (you)').first()).toBeVisible({ timeout: 15000 });

    // The device is Alice now, including after a reload
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), claimStorageKey(shareToken));
    expect(stored).toContain(alice.personToken);
    await page.reload();
    await expect(page.getByText('Alice (you)').first()).toBeVisible({ timeout: 15000 });

    await bobsPhone.close();
    await ctx.dispose();
  });

  test('an ignored personal link card is gone once this device joins as someone else', async ({ browser }) => {
    const { ctx, shareToken } = await createSession('Ignored Link Grill');
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });

    // Dave opens Alice's mis-shared link, ignores the card and joins as himself
    const davesPhone = await browser.newContext();
    const page = await davesPhone.newPage();
    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(page.getByTestId('personal-link-offer')).toBeVisible({ timeout: 15000 });

    // Hold the join in flight: the card's buttons are disabled meanwhile
    let releaseJoin = () => {};
    const joinHeld = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    await page.route(
      (url) => url.pathname.includes('guest.joinSession'),
      async (route) => {
        await joinHeld;
        await route.continue();
      },
    );
    await page.getByTestId('claim-name-input').fill('Dave');
    await page.getByTestId('claim-join-btn').click();
    await expect(page.getByTestId('personal-link-accept')).toBeDisabled();
    await expect(page.getByTestId('personal-link-decline')).toBeDisabled();
    releaseJoin();
    await expect(page.getByText('Dave (you)').first()).toBeVisible({ timeout: 15000 });

    // Once the split is finalized, the old card must not come back and offer to switch
    const finalize = await trpcMutation(ctx, 'guest.finalizeSession', {
      token: shareToken,
      personIndex: alice.personIndex,
      personToken: alice.personToken,
    });
    expect(finalize.ok(), await finalize.text()).toBe(true);
    // "View summary" is only on the finalized view, so the page has picked up the new status
    await expect(page.getByText('View summary')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('personal-link-btn')).toBeVisible();
    await expect(page.getByTestId('personal-link-offer')).toHaveCount(0);
    // Still Dave after a reload, with no card
    await page.reload();
    await expect(page.getByText('View summary')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('personal-link-btn')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('personal-link-offer')).toHaveCount(0);
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), claimStorageKey(shareToken));
    expect(JSON.parse(stored ?? 'null')).toMatchObject({ name: 'Dave' });

    await davesPhone.close();
    await ctx.dispose();
  });

  test('accepting a card left open while someone was removed becomes the right person', async ({ browser }) => {
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Stale Card Bar', subtotal: 1500, tax: 0, tip: 0, total: 1500, currency: 'USD' },
      items: [{ name: 'Tacos', quantity: 1, unitPrice: 1500, totalPrice: 1500 }],
      creatorName: 'Host',
      paidByName: 'Host',
    });
    const shareToken: string = (await createRes.json()).result.data.json.shareToken;
    await joinGuestSession(ctx, { token: shareToken, name: 'Host' });
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    expect(alice.personIndex).toBe(1);

    const pc = await browser.newContext();
    const page = await pc.newPage();
    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(page.getByTestId('personal-link-offer')).toBeVisible({ timeout: 15000 });

    // While the card is open, Host is removed, so Alice moves from index 1 to index 0
    const removed = await trpcMutation(ctx, 'guest.removePerson', {
      token: shareToken,
      personToken: alice.personToken,
      targetIndex: 0,
    });
    expect(removed.ok(), await removed.text()).toBe(true);
    await page.getByTestId('personal-link-accept').click();
    await expect(page.getByText('Alice (you)').first()).toBeVisible({ timeout: 15000 });

    await pc.close();
    await ctx.dispose();
  });

  test('a personal link pasted into a tab already on the claim page is picked up', async ({ page }) => {
    const { ctx, shareToken } = await createSession('Pasted Link Cafe');
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 15000 });

    // Like pasting it into the address bar: only the fragment changes, so the page doesn't reload by itself
    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(page.getByTestId('personal-link-offer')).toContainText("This is Alice's personal link", {
      timeout: 15000,
    });
    await expect.poll(() => page.url()).not.toContain('#me=');
    await ctx.dispose();
  });

  test('a pasted personal link is picked up even if the URL is rewritten before hashchange fires', async ({ page }) => {
    const { ctx, shareToken } = await createSession('Rewritten Link Cafe');
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    // Reproduce what some runs showed: between popstate and hashchange, something puts the URL
    // back without the fragment, so location.hash is empty when hashchange fires
    await page.addInitScript(() => {
      window.addEventListener('popstate', () => {
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      });
    });
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 15000 });

    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(page.getByTestId('personal-link-offer')).toContainText("This is Alice's personal link", {
      timeout: 15000,
    });
    await ctx.dispose();
  });

  test('tapping accept and then decline before the page updates still continues as the link names', async ({
    browser,
  }) => {
    const { ctx, shareToken } = await createSession('Double Tap Link Bar');
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    const pc = await browser.newContext();
    const page = await pc.newPage();
    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(page.getByTestId('personal-link-offer')).toBeVisible({ timeout: 15000 });

    // Both clicks in the same task, before React re-renders the buttons as disabled
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="personal-link-accept"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-testid="personal-link-decline"]')!.click();
    });
    await expect(page.getByText('Alice (you)').first()).toBeVisible({ timeout: 15000 });

    await pc.close();
    await ctx.dispose();
  });

  test('tapping decline and then accept on a device that already joined keeps it as itself', async ({ browser }) => {
    const { ctx, shareToken } = await createSession('Decline First Grill');
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    const bob = await joinGuestSession(ctx, { token: shareToken, name: 'Bob' });
    const bobsPhone = await browser.newContext();
    const page = await bobsPhone.newPage();
    // Plant Bob's identity once (rememberClaimIdentity would re-plant it on every navigation)
    await page.goto(`/en/split/${shareToken}/claim`);
    await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
      key: claimStorageKey(shareToken),
      value: JSON.stringify({ name: 'Bob', personToken: bob.personToken }),
    });
    await page.goto('about:blank');
    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(page.getByTestId('personal-link-offer')).toBeVisible({ timeout: 15000 });

    // Declining resumes Bob (one lookup); the accept right after it must not look up Alice
    const resumed: string[] = [];
    page.on('request', (req) => {
      if (new URL(req.url()).pathname.includes('guest.resumeSession')) resumed.push(req.postData() ?? '');
    });
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="personal-link-decline"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-testid="personal-link-accept"]')!.click();
    });
    await expect(page.getByText('Bob (you)').first()).toBeVisible({ timeout: 15000 });
    await page.waitForLoadState('networkidle');
    expect(resumed.some((body) => body.includes(alice.personToken))).toBe(false);
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), claimStorageKey(shareToken));
    expect(stored).toContain(bob.personToken);

    await bobsPhone.close();
    await ctx.dispose();
  });

  test('tapping decline and then accept before the page updates declines, without looking the link up', async ({
    browser,
  }) => {
    const { ctx, shareToken } = await createSession('Decline First Bar');
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    const pc = await browser.newContext();
    const page = await pc.newPage();
    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(page.getByTestId('personal-link-offer')).toBeVisible({ timeout: 15000 });

    // A device with no identity: declining has nothing to resume, so nothing else may be sent
    let resumeCalls = 0;
    page.on('request', (req) => {
      const procedures = new URL(req.url()).pathname.split('/').pop()?.split(',') ?? [];
      resumeCalls += procedures.filter((p) => p === 'guest.resumeSession').length;
    });
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="personal-link-decline"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-testid="personal-link-accept"]')!.click();
    });
    await expect(page.getByTestId('personal-link-offer')).toHaveCount(0);
    await expect(page.getByTestId('claim-join-form')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(resumeCalls).toBe(0);
    await expect(page.getByText('Alice (you)')).toHaveCount(0);

    await pc.close();
    await ctx.dispose();
  });

  test('"Copy link" drops the fragment, even one left in the address bar', async ({ browser }) => {
    const { ctx, shareToken } = await createSession('Plain Link Cafe');
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    // Not a personal link, so the page leaves it in the address bar
    await page.goto(`/en/split/${shareToken}/claim#foo=1`);
    await page.getByTestId('rejoin-person-0').click();
    await expect(page.locator('[data-testid^="claim-item-"]').first()).toBeVisible({ timeout: 15000 });
    expect(page.url()).toContain('#foo=1');
    await page.getByTestId('copy-link-btn').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`/split/${shareToken}/claim`);
    expect(copied).not.toContain('#');
    await context.close();
    await ctx.dispose();
  });
});

test.describe('Claim page — receipt image', () => {
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS) testInfo.skip(true, 'Set RUN_AI_TESTS=1 to enable (requires receipt with image)');
  });

  test('toggle button shows and hides receipt image', async ({ page }) => {
    // This test requires a real receipt with an image.
    // Create a receipt via upload, then a claiming session linked to it.
    const ctx = await authedContext(users.alice.email, users.alice.password);

    // Upload a receipt image
    const uploadRes = await ctx.post(`${BASE}/api/upload?guest=true`, {
      multipart: {
        file: { name: 'receipt.png', mimeType: 'image/png', buffer: FAKE_PNG },
      },
    });
    expect(uploadRes.status()).toBe(200);
    const { receiptId } = await uploadRes.json();

    // Add items to the receipt
    await trpcMutation(ctx, 'receipts.addItem', {
      receiptId,
      name: 'Test Item',
      quantity: 1,
      unitPrice: 1000,
      totalPrice: 1000,
    });

    // Create a claiming session linked to the receipt
    const anonCtx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(anonCtx, 'guest.createClaimSession', {
      receiptId,
      receiptData: {
        merchantName: 'Image Test Cafe',
        subtotal: 1000,
        tax: 100,
        tip: 0,
        total: 1100,
        currency: 'USD',
      },
      items: [{ name: 'Test Item', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
      creatorName: 'Tester',
      paidByName: 'Tester',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    await ctx.dispose();
    await anonCtx.dispose();

    // Open claim page
    await page.goto(`/en/split/${shareToken}/claim`);
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 10000 });

    // Receipt image toggle should be visible
    const toggleBtn = page.getByTestId('toggle-receipt-image');
    await expect(toggleBtn).toBeVisible();

    // Image should not be visible initially
    await expect(page.getByTestId('receipt-image')).not.toBeVisible();

    // Click toggle to show image
    await toggleBtn.click();
    await expect(page.getByTestId('receipt-image')).toBeVisible();

    // Click toggle again to hide
    await toggleBtn.click();
    await expect(page.getByTestId('receipt-image')).not.toBeVisible();
  });
});

test.describe('Claim session — API: mySplits tracks claim sessions', () => {
  test('claim session created by logged-in user appears in mySplits', async () => {
    const ctx = await authedContext(users.bob.email, users.bob.password);

    // Create a claiming session as Bob
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: {
        merchantName: "Bob's Pizza",
        subtotal: 2500,
        tax: 250,
        tip: 300,
        total: 3050,
        currency: 'USD',
      },
      items: [
        { name: 'Pepperoni', quantity: 1, unitPrice: 1500, totalPrice: 1500 },
        { name: 'Margherita', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      ],
      creatorName: 'Bob',
      paidByName: 'Bob',
    });
    expect(createRes.ok()).toBe(true);

    // Query mySplits — should include the new session
    const splitsRes = await trpcQuery(ctx, 'guest.mySplits', { limit: 10 });
    const data = await trpcResult(splitsRes);

    expect(data.splits.length).toBeGreaterThanOrEqual(1);
    const bobsPizza = data.splits.find((s: { merchantName: string }) => s.merchantName === "Bob's Pizza");
    expect(bobsPizza).toBeDefined();
    expect(bobsPizza.status).toBe('CLAIMING');
    expect(bobsPizza.total).toBe(3050);
    expect(bobsPizza.peopleCount).toBe(1);

    await ctx.dispose();
  });
});
