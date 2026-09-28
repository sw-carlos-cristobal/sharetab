import { test, expect, request, type Page } from '@playwright/test';
import { joinGuestSession, personIdByName, trpcMutation, trpcQuery, trpcResult } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// Issue #226: anyone may claim for anyone, so two devices can edit the same person's claims.
// A save used to replace the person's whole claim set with the one the page built from the
// claims it loaded plus its taps, dropping whatever the other device saved meanwhile. The page
// now sends only the items it changed.
// Issue #238: a save whose answer was lost left its changes as unsaved edits, which could undo
// another device's later change. The page now sends it again with the same save key until the
// answer says whether it was stored; the server stores a save once per key.

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
  return { ctx, shareToken, cat, catSaves };
}

// Checks after a save poll the stored claims (claimsOf) rather than wait for the "Claims saved!"
// toast, since an earlier save's toast can still be on screen
async function save(page: Page) {
  await page.getByTestId('save-claims-btn').click();
  await expect(page.getByText('Claims saved!').first()).toBeVisible({ timeout: 15000 });
}

/** The save key of every claim save the page sends, in order. */
function recordSaveKeys(page: Page) {
  const keys: string[] = [];
  page.on('request', (req) => {
    if (!new URL(req.url()).pathname.includes('guest.claimItems')) return;
    keys.push(/"saveKey":"([0-9a-f-]{36})"/.exec(req.postData() ?? '')?.[1] ?? '');
  });
  return keys;
}

/**
 * Whether "Unsaved changes" appears on the page from now on (it's absent when this is called).
 * Read it with sawUnsavedChanges.
 */
async function watchForUnsavedChanges(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { sawUnsavedChanges: boolean };
    w.sawUnsavedChanges = false;
    new MutationObserver(() => {
      if (document.body.innerText.includes('Unsaved changes')) w.sawUnsavedChanges = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
const sawUnsavedChanges = (page: Page) =>
  page.evaluate(() => (window as unknown as { sawUnsavedChanges: boolean }).sawUnsavedChanges);

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

  test('a save that got no answer is sent again until it is stored, keeping taps made meanwhile (#238)', async ({
    page,
  }) => {
    const { ctx, shareToken } = await annClaimingForCat(page, 'Failed Save Diner');
    const saveKeys = recordSaveKeys(page);

    // Hold the save, then drop it before it reaches the server, once the pie has been tapped off
    // and on again and the tea tapped
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
    await page.getByTestId('claim-item-0').click();
    fail();

    // The page sends the save again with the same key, and it's stored; the pie taps cancelled
    // out, and the tea is still waiting to be saved
    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual(['Pie']);
    await expect(page.getByTestId('save-claims-btn')).toBeEnabled({ timeout: 15000 });
    await expect(page.getByTestId('claim-item-2')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('claim-item-0')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Unsaved changes').first()).toBeVisible();
    expect(saveKeys).toHaveLength(2);
    expect(saveKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(saveKeys[1]).toBe(saveKeys[0]);
    await save(page);
    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual(['Pie', 'Tea']);

    await ctx.dispose();
  });

  test('a save the server refuses is not sent again, and its changes stay to be saved (#238)', async ({ page }) => {
    const { ctx, shareToken } = await annClaimingForCat(page, 'Refused Save Diner');
    const saveKeys = recordSaveKeys(page);

    // The first save arrives with a malformed save key, so the server refuses it (400)
    await page.route(
      (url) => url.pathname.includes('guest.claimItems'),
      async (route) => {
        const postData = (route.request().postData() ?? '').replace(/"saveKey":"[0-9a-f-]{36}"/, '"saveKey":"bad"');
        await route.continue({ postData }).catch(() => {});
      },
      { times: 1 },
    );

    await page.getByTestId('claim-item-2').click();
    await page.getByTestId('save-claims-btn').click();

    // Nothing was stored; the pie is still claimed here, waiting to be saved
    await expect(page.getByTestId('save-claims-btn')).toBeEnabled({ timeout: 15000 });
    await expect(page.getByTestId('claim-item-2')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Unsaved changes').first()).toBeVisible();
    expect(await claimsOf(ctx, shareToken, 'Cat')).toEqual([]);
    expect(saveKeys).toHaveLength(1);
    await save(page);
    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual(['Pie']);

    await ctx.dispose();
  });

  test("a save whose answer was lost doesn't come back to undo another device's later change (#238)", async ({
    page,
  }) => {
    const { ctx, shareToken, catSaves } = await annClaimingForCat(page, 'Lost Answer Cafe');
    const saveKeys = recordSaveKeys(page);

    // The save reaches the server and is stored, but its answer never arrives
    await page.route(
      (url) => url.pathname.includes('guest.claimItems'),
      async (route) => {
        await route.fetch();
        await route.abort('connectionreset').catch(() => {});
      },
      { times: 1 },
    );

    // Ann claims the pie for Cat and saves
    await page.getByTestId('claim-item-2').click();
    await page.getByTestId('save-claims-btn').click();
    await expect(page.getByTestId('save-claims-btn')).toHaveText('Claims saved', { timeout: 15000 });
    await expect.poll(() => claimsOf(ctx, shareToken, 'Cat'), { timeout: 15000 }).toEqual(['Pie']);

    // Later, Cat's own phone unclaims the pie: Ann's page shows that, with nothing to save
    await catSaves([]);
    await expect(page.getByTestId('claim-item-2')).toHaveAttribute('aria-pressed', 'false', { timeout: 15000 });
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);
    await expect(page.getByTestId('save-claims-btn')).toBeDisabled();
    expect(await claimsOf(ctx, shareToken, 'Cat')).toEqual([]);

    // It learned the save was stored by sending it again with the same key
    expect(saveKeys).toHaveLength(2);
    expect(saveKeys[1]).toBe(saveKeys[0]);

    await ctx.dispose();
  });

  test('a save stops, without an error, once the person saving is removed (#238)', async ({ page }) => {
    const { ctx, shareToken, cat } = await annClaimingForCat(page, 'Removed Saver Diner');
    const saveKeys = recordSaveKeys(page);

    // Ann's save for Cat is stored but its answer is lost, and meanwhile Cat's phone removes Ann
    await page.route(
      (url) => url.pathname.includes('guest.claimItems'),
      async (route) => {
        await route.fetch();
        const annId = await personIdByName(ctx, shareToken, 'Ann');
        const removed = await trpcMutation(ctx, 'guest.removePerson', {
          token: shareToken,
          personToken: cat.personToken,
          targetId: annId,
        });
        expect(removed.ok(), await removed.text()).toBe(true);
        await route.abort('connectionreset').catch(() => {});
      },
      { times: 1 },
    );

    await page.getByTestId('claim-item-2').click();
    await page.getByTestId('save-claims-btn').click();

    // The page forgets Ann (she was removed) instead of sending the save again with her
    // now-invalid token and showing that refusal
    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Invalid person token')).toHaveCount(0);
    expect(saveKeys).toHaveLength(1);
    expect(await claimsOf(ctx, shareToken, 'Cat')).toEqual(['Pie']);

    await ctx.dispose();
  });

  test('a stored save whose reload fails never shows its changes as unsaved (#238)', async ({ page }) => {
    const { ctx, shareToken } = await annClaimingForCat(page, 'Failed Reload Diner');

    // Once the save is stored, every session reload fails until `failing` is turned off
    let failing = false;
    let failedReloads = 0;
    await page.route(
      (url) => url.pathname.includes('guest.getSession'),
      async (route) => {
        if (!failing) return route.continue().catch(() => {});
        failedReloads += 1;
        await route.fulfill({ status: 500, body: 'unavailable' }).catch(() => {});
      },
    );
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
        failing = true;
        await route.fulfill({ response }).catch(() => {});
      },
      { times: 1 },
    );

    await page.getByTestId('claim-item-2').click();
    await page.getByTestId('save-claims-btn').click();
    await sent;
    // The pie is in the save now, not an unsaved change; watch from here until the save ends
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);
    await watchForUnsavedChanges(page);
    release();

    // Reloads keep failing: the page keeps the pie in the save, and keeps trying. One reload is
    // four requests (the query's own three retries), so by the fifth failed request the first
    // reload has failed (a poll may be among them); the checks below and sawUnsavedChanges are
    // what tell the fix apart
    await expect.poll(() => failedReloads, { timeout: 30000 }).toBeGreaterThanOrEqual(5);
    await expect(page.getByTestId('save-claims-btn')).toBeDisabled();
    await expect(page.getByTestId('claim-item-2')).toHaveAttribute('aria-pressed', 'true');

    // Once a reload lands, the save is done, with nothing left to save
    failing = false;
    await expect(page.getByTestId('save-claims-btn')).toHaveText('Claims saved', { timeout: 20000 });
    await expect(page.getByTestId('claim-item-2')).toHaveAttribute('aria-pressed', 'true');
    expect(await sawUnsavedChanges(page)).toBe(false);
    expect(await claimsOf(ctx, shareToken, 'Cat')).toEqual(['Pie']);

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

test.describe('guest.claimItems save keys (#238)', () => {
  test('a save sent again with its key is not applied again, and both of two copies sent at once answer saved', async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Save Key Diner', subtotal: 3000, tax: 0, tip: 0, total: 3000, currency: 'USD' },
      items: ITEMS.map((name) => ({ name, quantity: 1, unitPrice: 1000, totalPrice: 1000 })),
      creatorName: 'Host',
      paidByName: 'Host',
    });
    expect(createRes.ok(), await createRes.text()).toBe(true);
    const shareToken: string = (await createRes.json()).result.data.json.shareToken;
    const ann = await joinGuestSession(ctx, { token: shareToken, name: 'Ann' });
    const cat = await joinGuestSession(ctx, { token: shareToken, name: 'Cat' });
    const forCat = (saveKey: string, changes: Record<string, number[]>) =>
      trpcMutation(ctx, 'guest.claimItems', {
        token: shareToken,
        personId: cat.personId,
        personToken: ann.personToken,
        saveKey,
        ...changes,
      });
    const catSaves = async (claimedItemIndices: number[]) => {
      const res = await trpcMutation(ctx, 'guest.claimItems', {
        token: shareToken,
        personId: cat.personId,
        personToken: cat.personToken,
        claimedItemIndices,
      });
      expect(res.ok(), await res.text()).toBe(true);
    };

    // Ann's save of the pie is stored; Cat's phone unclaims it; Ann's page sends the save again
    const pieKey = '99999999-9999-4999-8999-000000000001';
    expect((await forCat(pieKey, { addItemIndices: [2] })).ok()).toBe(true);
    await catSaves([]);
    const again = await forCat(pieKey, { addItemIndices: [2] });
    expect(again.ok(), await again.text()).toBe(true);
    expect(await claimsOf(ctx, shareToken, 'Cat')).toEqual([]);
    // The same key with other changes is refused
    expect((await forCat(pieKey, { addItemIndices: [1] })).status()).toBe(409);

    // Two copies of one save at once (a smoke check: they may not overlap, and adding an item
    // twice looks like adding it once): both answer saved, and the key is kept
    const teaKey = '99999999-9999-4999-8999-000000000002';
    const both = await Promise.all([forCat(teaKey, { addItemIndices: [0] }), forCat(teaKey, { addItemIndices: [0] })]);
    for (const res of both) expect(res.ok(), await res.text()).toBe(true);
    expect(await claimsOf(ctx, shareToken, 'Cat')).toEqual(['Tea']);
    // The key was stored: once Cat unclaims the tea, sending it again doesn't bring it back
    await catSaves([]);
    expect((await forCat(teaKey, { addItemIndices: [0] })).ok()).toBe(true);
    expect(await claimsOf(ctx, shareToken, 'Cat')).toEqual([]);

    await ctx.dispose();
  });
});
