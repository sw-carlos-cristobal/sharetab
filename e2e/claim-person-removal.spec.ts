import { test, expect, request, type Page } from '@playwright/test';
import { joinGuestSession, trpcMutation, trpcQuery, trpcResult } from './helpers';
import { claimStorageKey } from '../src/lib/guest-session';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// Issue #205: removing someone moves everyone listed after them down one place, so a claim page
// that kept the old indexes would act on the wrong person.

async function createSession(merchantName: string) {
  const ctx = await request.newContext({ baseURL: BASE });
  const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
    receiptData: { merchantName, subtotal: 3000, tax: 0, tip: 0, total: 3000, currency: 'USD' },
    items: [
      { name: 'Tea', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      { name: 'Cake', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
      { name: 'Pie', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
    ],
    creatorName: 'Ann',
    paidByName: 'Ann',
  });
  expect(createRes.ok(), await createRes.text()).toBe(true);
  const shareToken: string = (await createRes.json()).result.data.json.shareToken;
  return { ctx, shareToken };
}

type Session = {
  people: { name: string }[];
  assignments: { itemIndex: number; personIndices: number[] }[];
};

async function getSession(ctx: Awaited<ReturnType<typeof request.newContext>>, token: string): Promise<Session> {
  return trpcResult(await trpcQuery(ctx, 'guest.getSession', { token }));
}

/** Item names each person has claimed, by name */
function claimsByName(session: Session, itemNames: string[]) {
  const byName: Record<string, string[]> = {};
  session.people.forEach((person, i) => {
    byName[person.name] = session.assignments
      .filter((a) => a.personIndices.includes(i))
      .map((a) => itemNames[a.itemIndex]!)
      .sort();
  });
  return byName;
}

/** Ann, Bob and Dee join through the API; Cat joins on `page`, third in the list. */
async function fourPeople(page: Page, merchantName: string) {
  const { ctx, shareToken } = await createSession(merchantName);
  const ann = await joinGuestSession(ctx, { token: shareToken, name: 'Ann' });
  await joinGuestSession(ctx, { token: shareToken, name: 'Bob' });

  await page.goto(`/en/split/${shareToken}/claim`);
  await page.getByTestId('claim-name-input').fill('Cat');
  await page.getByTestId('claim-join-btn').click();
  await expect(page.getByText('Cat (you)').first()).toBeVisible({ timeout: 15000 });

  const dee = await joinGuestSession(ctx, { token: shareToken, name: 'Dee' });
  expect(dee.personIndex).toBe(3);
  // Dee claims the cake
  const deeClaims = await trpcMutation(ctx, 'guest.claimItems', {
    token: shareToken,
    personIndex: dee.personIndex,
    personToken: dee.personToken,
    claimedItemIndices: [1],
  });
  expect(deeClaims.ok(), await deeClaims.text()).toBe(true);
  // Cat's page has seen Dee join
  await expect(page.getByTestId('switch-person-3')).toContainText('Dee', { timeout: 15000 });
  return { ctx, shareToken, ann };
}

/** Ann removes Bob from her own device, and Cat's page (not reloaded) sees him go */
async function annRemovesBob(
  page: Page,
  ctx: Awaited<ReturnType<typeof request.newContext>>,
  shareToken: string,
  annToken: string,
) {
  const removed = await trpcMutation(ctx, 'guest.removePerson', {
    token: shareToken,
    personToken: annToken,
    targetIndex: 1,
  });
  expect(removed.ok(), await removed.text()).toBe(true);
  await expect(page.getByTestId('switch-person-3')).toHaveCount(0, { timeout: 15000 });
}

test.describe('Claim page — someone else removes a person listed earlier', () => {
  test("saving claims saves them for this device's person, not whoever moved into their place", async ({ page }) => {
    const { ctx, shareToken, ann } = await fourPeople(page, 'Shifted Claims Cafe');
    await annRemovesBob(page, ctx, shareToken, ann.personToken);

    // Cat, now second in the list, claims the tea and saves
    await expect(page.getByText('Cat (you)').first()).toBeVisible();
    await page.getByTestId('claim-item-0').click();
    await page.getByTestId('save-claims-btn').click();
    await expect(page.getByText('Claims saved!').first()).toBeVisible({ timeout: 15000 });

    const session = await getSession(ctx, shareToken);
    expect(session.people.map((p) => p.name)).toEqual(['Ann', 'Cat', 'Dee']);
    expect(claimsByName(session, ['Tea', 'Cake', 'Pie'])).toEqual({ Ann: [], Cat: ['Tea'], Dee: ['Cake'] });
    await ctx.dispose();
  });

  test("removing the person who moved into this device's old place keeps this device as itself", async ({ page }) => {
    const { ctx, shareToken, ann } = await fourPeople(page, 'Shifted Remove Cafe');
    await annRemovesBob(page, ctx, shareToken, ann.personToken);

    // Dee is now third, where Cat used to be; Cat removes her
    await expect(page.getByTestId('switch-person-2')).toContainText('Dee');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('remove-person-2').click();
    await expect(page.getByText('Person removed').first()).toBeVisible({ timeout: 15000 });

    // Cat is still Cat here, on this device and after a reload
    await expect(page.getByText('Cat (you)').first()).toBeVisible();
    await expect(page.getByTestId('claim-join-form')).toHaveCount(0);
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), claimStorageKey(shareToken));
    expect(JSON.parse(stored ?? 'null')).toMatchObject({ name: 'Cat' });
    await page.reload();
    await expect(page.getByText('Cat (you)').first()).toBeVisible({ timeout: 15000 });

    const session = await getSession(ctx, shareToken);
    expect(session.people.map((p) => p.name)).toEqual(['Ann', 'Cat']);
    await ctx.dispose();
  });

  test('an open page whose person someone else removed goes back to the join form', async ({ page }) => {
    const { ctx, shareToken, ann } = await fourPeople(page, 'Removed While Open Cafe');
    const removed = await trpcMutation(ctx, 'guest.removePerson', {
      token: shareToken,
      personToken: ann.personToken,
      targetIndex: 2,
    });
    expect(removed.ok(), await removed.text()).toBe(true);

    await expect(page.getByTestId('claim-join-form')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Someone removed you from this split').first()).toBeVisible();
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), claimStorageKey(shareToken)))
      .toBeNull();
    // Nobody is marked as this device's person
    await expect(page.getByText('(you)')).toHaveCount(0);
    await ctx.dispose();
  });

  test("becoming someone from a stale view doesn't show a removed person's claims as theirs", async ({ browser }) => {
    // Ann claimed the tea; Alice's personal link is opened on a new device
    const { ctx, shareToken } = await createSession('Stale Claims Bar');
    const host = await joinGuestSession(ctx, { token: shareToken, name: 'Ann' });
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    const hostClaims = await trpcMutation(ctx, 'guest.claimItems', {
      token: shareToken,
      personIndex: host.personIndex,
      personToken: host.personToken,
      claimedItemIndices: [0],
    });
    expect(hostClaims.ok(), await hostClaims.text()).toBe(true);

    const pc = await browser.newContext();
    const page = await pc.newPage();
    await page.goto(`/en/split/${shareToken}/claim#me=${alice.personToken}`);
    await expect(page.getByTestId('personal-link-offer')).toBeVisible({ timeout: 15000 });

    // Hold the page's session polls, so it keeps the view from before the removal. Wait until a
    // poll is held: until the page refetches on its own (it doesn't while the card is open),
    // an interval poll waits for the fetch in flight, so none sent before the route can still
    // come back with the removal in it.
    let releasePolls = () => {};
    const pollsHeld = new Promise<void>((resolve) => (releasePolls = resolve));
    let pollArrived = () => {};
    const firstPollHeld = new Promise<void>((resolve) => (pollArrived = resolve));
    await page.route(
      (url) => url.pathname.includes('guest.getSession'),
      async (route) => {
        pollArrived();
        await pollsHeld;
        // The page may have closed by now
        await route.continue().catch(() => {});
      },
    );
    await firstPollHeld;

    // Ann is removed (her tea claim goes with her), so Alice moves into Ann's place
    const removed = await trpcMutation(ctx, 'guest.removePerson', {
      token: shareToken,
      personToken: alice.personToken,
      targetIndex: 0,
    });
    expect(removed.ok(), await removed.text()).toBe(true);
    await page.getByTestId('personal-link-accept').click();
    await expect(page.getByText('Continuing as Alice').first()).toBeVisible({ timeout: 15000 });

    releasePolls();
    await expect(page.getByTestId('switch-person-1')).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByText('Alice (you)').first()).toBeVisible();
    // The tea isn't Alice's, and nothing is waiting to be saved
    await expect(page.getByTestId('claim-item-0')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);

    await pc.close();
    await ctx.dispose();
  });
});
