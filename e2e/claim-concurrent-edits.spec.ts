import { test, expect, request, type Page } from '@playwright/test';
import { joinGuestSession, trpcMutation, trpcQuery, trpcResult } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// Issue #226: anyone may claim for anyone, so two devices can edit the same person's claims.
// A save used to replace the person's whole claim set with the one the page built from the
// claims it loaded plus its taps, dropping whatever the other device saved meanwhile. The page
// now sends only the items it changed.

const ITEMS = ['Tea', 'Cake', 'Pie'];

type Session = {
  people: { name: string }[];
  assignments: { itemIndex: number; personIndices: number[] }[];
};

async function claimsOf(ctx: Awaited<ReturnType<typeof request.newContext>>, shareToken: string, name: string) {
  const session: Session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
  const index = session.people.findIndex((p) => p.name === name);
  return session.assignments
    .filter((a) => a.personIndices.includes(index))
    .map((a) => ITEMS[a.itemIndex]!)
    .sort();
}

/** Ann joins on `page` and picks Cat (who joined through the API) under "Claiming for". */
async function annClaimingForCat(page: Page, merchantName: string) {
  const ctx = await request.newContext({ baseURL: BASE });
  const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
    receiptData: { merchantName, subtotal: 3000, tax: 0, tip: 0, total: 3000, currency: 'USD' },
    items: ITEMS.map((name) => ({ name, quantity: 1, unitPrice: 1000, totalPrice: 1000 })),
    creatorName: 'Ann',
    paidByName: 'Ann',
  });
  expect(createRes.ok(), await createRes.text()).toBe(true);
  const shareToken: string = (await createRes.json()).result.data.json.shareToken;

  await page.goto(`/en/split/${shareToken}/claim`);
  await page.getByTestId('claim-name-input').fill('Ann');
  await page.getByTestId('claim-join-btn').click();
  await expect(page.getByText('Ann (you)').first()).toBeVisible({ timeout: 15000 });

  const cat = await joinGuestSession(ctx, { token: shareToken, name: 'Cat' });
  await expect(page.getByTestId('switch-person-1')).toContainText('Cat', { timeout: 15000 });
  await page.getByTestId('switch-person-1').click();

  // What Cat's own phone saves
  const catSaves = async (claimedItemIndices: number[]) => {
    const res = await trpcMutation(ctx, 'guest.claimItems', {
      token: shareToken,
      personId: cat.personId,
      personToken: cat.personToken,
      claimedItemIndices,
    });
    expect(res.ok(), await res.text()).toBe(true);
  };
  return { ctx, shareToken, catSaves };
}

// Checks after a save poll the stored claims (claimsOf) rather than wait for the "Claims saved!"
// toast, since an earlier save's toast can still be on screen
async function save(page: Page) {
  await page.getByTestId('save-claims-btn').click();
  await expect(page.getByText('Claims saved!').first()).toBeVisible({ timeout: 15000 });
}

test.describe('Claim page — two devices edit the same person (#226)', () => {
  test('claiming an item for someone keeps the items their own device saved meanwhile', async ({ page }) => {
    const { ctx, shareToken, catSaves } = await annClaimingForCat(page, 'Two Devices Diner');

    // Ann taps the pie for Cat; before she saves, Cat's phone saves the tea and the cake
    await page.getByTestId('claim-item-2').click();
    await catSaves([0, 1]);
    await save(page);

    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual(['Cake', 'Pie', 'Tea']);
    // Ann's page shows all three as Cat's, with nothing left to save
    for (const item of [0, 1, 2]) {
      await expect(page.getByTestId(`claim-item-${item}`)).toHaveAttribute('aria-pressed', 'true', {
        timeout: 15000,
      });
    }
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);

    await ctx.dispose();
  });

  test('unclaiming an item for someone keeps the items their own device added meanwhile', async ({ page }) => {
    const { ctx, shareToken, catSaves } = await annClaimingForCat(page, 'Two Devices Bar');
    await catSaves([0]);
    await expect(page.getByTestId('claim-item-0')).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });

    // Ann untaps the tea for Cat; before she saves, Cat's phone adds the cake
    await page.getByTestId('claim-item-0').click();
    await catSaves([0, 1]);
    await save(page);

    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual(['Cake']);

    await ctx.dispose();
  });

  test('tapping an item back while its save is in flight keeps that tap', async ({ page }) => {
    const { ctx, shareToken } = await annClaimingForCat(page, 'Two Taps Diner');

    // Hold the save's answer, so the second tap lands while it's in flight
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let saveSent = () => {};
    const sent = new Promise<void>((resolve) => (saveSent = resolve));
    await page.route(
      (url) => url.pathname.includes('guest.claimItems'),
      async (route) => {
        const response = await route.fetch();
        saveSent();
        await released;
        await route.fulfill({ response }).catch(() => {});
      },
      { times: 1 },
    );

    await page.getByTestId('claim-item-2').click();
    await page.getByTestId('save-claims-btn').click();
    await sent;
    await page.getByTestId('claim-item-2').click();
    release();
    await expect(page.getByText('Claims saved!').first()).toBeVisible({ timeout: 15000 });

    // The save stored the pie; the second tap is still here, waiting to be saved
    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual(['Pie']);
    await expect(page.getByTestId('claim-item-2')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('Unsaved changes').first()).toBeVisible();
    await save(page);
    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual([]);

    await ctx.dispose();
  });

  test('tapping an item off and on while its save fails keeps it claimed, still to be saved', async ({ page }) => {
    const { ctx, shareToken } = await annClaimingForCat(page, 'Failed Save Diner');

    // Hold the save, then fail it once the item has been tapped off and on again
    let fail = () => {};
    const failed = new Promise<void>((resolve) => (fail = resolve));
    let saveSent = () => {};
    const sent = new Promise<void>((resolve) => (saveSent = resolve));
    await page.route(
      (url) => url.pathname.includes('guest.claimItems'),
      async (route) => {
        saveSent();
        await failed;
        await route.abort('connectionreset').catch(() => {});
      },
      { times: 1 },
    );

    await page.getByTestId('claim-item-2').click();
    await page.getByTestId('save-claims-btn').click();
    await sent;
    await page.getByTestId('claim-item-2').click();
    await page.getByTestId('claim-item-2').click();
    fail();

    // Nothing was stored; the pie is still claimed here, waiting to be saved
    await expect(page.getByTestId('claim-item-2')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Unsaved changes').first()).toBeVisible({ timeout: 15000 });
    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual([]);
    await save(page);
    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual(['Pie']);

    await ctx.dispose();
  });

  test('a save whose answer is lost after the server stored it keeps a tap made meanwhile', async ({ page }) => {
    const { ctx, shareToken } = await annClaimingForCat(page, 'Lost Answer Diner');

    // The save reaches the server and is stored, but its answer never arrives
    let drop = () => {};
    const dropped = new Promise<void>((resolve) => (drop = resolve));
    let stored = () => {};
    const serverStored = new Promise<void>((resolve) => (stored = resolve));
    await page.route(
      (url) => url.pathname.includes('guest.claimItems'),
      async (route) => {
        await route.fetch();
        stored();
        await dropped;
        await route.abort('connectionreset').catch(() => {});
      },
      { times: 1 },
    );

    // Ann claims the pie for Cat and saves; while the save is out, she taps the pie off again
    await page.getByTestId('claim-item-2').click();
    await page.getByTestId('save-claims-btn').click();
    await serverStored;
    await page.getByTestId('claim-item-2').click();
    drop();

    // The pie was stored; the tap-off is still here, waiting to be saved
    await expect(page.getByText('Unsaved changes').first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('claim-item-2')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual(['Pie']);
    await save(page);
    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual([]);

    await ctx.dispose();
  });

  test('Finalize stays hidden while a save is in flight', async ({ page }) => {
    const { ctx, catSaves } = await annClaimingForCat(page, 'Finalize Wait Diner');
    // Cat has claimed everything, so the split could be finalized
    await catSaves([0, 1, 2]);
    await expect(page.getByTestId('finalize-btn')).toBeVisible({ timeout: 15000 });

    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let saveSent = () => {};
    const sent = new Promise<void>((resolve) => (saveSent = resolve));
    await page.route(
      (url) => url.pathname.includes('guest.claimItems'),
      async (route) => {
        const response = await route.fetch();
        saveSent();
        await released;
        await route.fulfill({ response }).catch(() => {});
      },
      { times: 1 },
    );

    // Ann unclaims the tea for Cat and saves; until the save lands, Finalize can't be pressed
    await page.getByTestId('claim-item-0').click();
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0);
    await page.getByTestId('save-claims-btn').click();
    await sent;
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0);
    release();
    await expect(page.getByText('Claims saved!').first()).toBeVisible({ timeout: 15000 });
    // The tea is nobody's now, so the split still can't be finalized
    await expect(page.getByTestId('finalize-btn')).toHaveCount(0);

    await ctx.dispose();
  });

  test("another device's saves show under changes not saved yet", async ({ page }) => {
    const { ctx, catSaves } = await annClaimingForCat(page, 'Two Devices Cafe');

    await page.getByTestId('claim-item-2').click();
    await catSaves([0]);
    // The next poll shows Cat's tea, and the pie is still waiting to be saved
    await expect(page.getByTestId('claim-item-0')).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });
    await expect(page.getByTestId('claim-item-2')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Unsaved changes').first()).toBeVisible();

    await ctx.dispose();
  });
});
