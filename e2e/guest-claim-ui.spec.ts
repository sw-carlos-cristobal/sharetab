import { test, expect, request, type Locator, type Page } from '@playwright/test';
import { joinGuestSession, trpcMutation } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

test.describe('Guest Split UI Flow', () => {
  test('guest split page loads and shows upload options with testids', async ({ page }) => {
    await page.goto('/en/split');
    await expect(page.getByText('Split a bill')).toBeVisible();

    // Verify upload areas are present with correct testids
    await expect(page.getByTestId('guest-snap-upload')).toBeVisible();
    await expect(page.getByTestId('guest-gallery-upload')).toBeVisible();

    // The gallery file input should exist (hidden inside the label)
    await expect(page.getByTestId('guest-file-input')).toBeAttached();
  });
});

test.describe('Guest Split — Share Result Page', () => {
  let shareToken: string;

  test.beforeAll(async () => {
    // Create a split via API to test the result page
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await ctx.post('/api/trpc/guest.createSplit', {
      data: {
        json: {
          receiptData: {
            merchantName: 'Taco Stand',
            date: '2026-05-07',
            subtotal: 4500,
            tax: 360,
            tip: 700,
            total: 5560,
            currency: 'USD',
          },
          items: [
            { name: 'Tacos x3', quantity: 3, unitPrice: 500, totalPrice: 1500 },
            { name: 'Burrito', quantity: 1, unitPrice: 1200, totalPrice: 1200 },
            { name: 'Nachos', quantity: 1, unitPrice: 900, totalPrice: 900 },
            { name: 'Guacamole', quantity: 1, unitPrice: 450, totalPrice: 450 },
            { name: 'Drinks', quantity: 1, unitPrice: 450, totalPrice: 450 },
          ],
          people: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Charlie' }],
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

  test('result page displays split summary with data-testids', async ({ page }) => {
    await page.goto(`/en/split/${shareToken}`);

    // Result wrapper should be visible
    await expect(page.getByTestId('split-result')).toBeVisible();

    // Should show merchant name
    await expect(page.getByText('Taco Stand')).toBeVisible();

    // Person cards should be present with indexed testids
    await expect(page.getByTestId('person-card-0')).toBeVisible();
    await expect(page.getByTestId('person-card-1')).toBeVisible();
    await expect(page.getByTestId('person-card-2')).toBeVisible();

    // Share buttons should be present
    await expect(page.getByTestId('copy-link-btn')).toBeVisible();
    await expect(page.getByTestId('share-btn')).toBeVisible();
  });

  test('person cards contain correct names', async ({ page }) => {
    await page.goto(`/en/split/${shareToken}`);
    await expect(page.getByTestId('split-result')).toBeVisible();

    // Verify each person card has the correct person's name
    // The order matches the summary order from the API
    const card0Text = await page.getByTestId('person-card-0').textContent();
    const card1Text = await page.getByTestId('person-card-1').textContent();
    const card2Text = await page.getByTestId('person-card-2').textContent();

    // All three names should appear across the cards
    const allText = `${card0Text} ${card1Text} ${card2Text}`;
    expect(allText).toContain('Alice');
    expect(allText).toContain('Bob');
    expect(allText).toContain('Charlie');
  });

  test('invalid share token shows error state', async ({ page }) => {
    await page.goto('/en/split/nonexistent-token-abc123');
    await expect(page.getByText('Split not found')).toBeVisible();
  });
});

// #278: a shared item was listed at its full price under each person on it, so the lines on a
// person's card added up to more than their total
test.describe('Guest Split — shared items on the result page', () => {
  const cents = (text: string) => Math.round(Number(text.replace(/[^0-9.]/g, '')) * 100);

  function personCard(page: Page, name: string) {
    return page.locator('[data-testid^="person-card-"]').filter({ hasText: name });
  }

  async function expectLinesAddUpToTotal(card: Locator) {
    const lines = await card.getByTestId('line-amount').allTextContents();
    const total = await card.locator('[data-testid^="person-total-"]').textContent();
    expect(lines.reduce((sum, line) => sum + cents(line), 0)).toBe(cents(total ?? ''));
  }

  test("a Quick Split lists a shared item at each person's share of it", async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await trpcMutation(ctx, 'guest.createSplit', {
      receiptData: { merchantName: 'Lemonade Stand', subtotal: 2875, tax: 230, tip: 0, total: 3105, currency: 'USD' },
      items: [
        { name: 'Burger', quantity: 1, unitPrice: 1600, totalPrice: 1600 },
        { name: 'Lemonade', quantity: 1, unitPrice: 375, totalPrice: 375 },
        { name: 'Salad', quantity: 1, unitPrice: 900, totalPrice: 900 },
      ],
      people: [{ name: 'Pat' }, { name: 'Dana' }],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [0, 1] },
        { itemIndex: 2, personIndices: [1] },
      ],
      paidByIndex: 0,
    });
    expect(res.ok(), await res.text()).toBe(true);
    const { shareToken } = (await res.json()).result.data.json;
    await ctx.dispose();

    await page.goto(`/en/split/${shareToken}`);
    const pat = personCard(page, 'Pat');
    const dana = personCard(page, 'Dana');
    await expect(pat).toContainText('Lemonade (1/2 of $3.75)');
    await expect(pat).toContainText('$1.88');
    await expect(dana).toContainText('Lemonade (1/2 of $3.75)');
    await expect(dana).toContainText('$1.87');
    // Items someone has to themselves show their full price with no share
    await expect(pat.getByText('Burger', { exact: true })).toBeVisible();
    await expect(pat).toContainText('$16.00');

    await expectLinesAddUpToTotal(pat);
    await expectLinesAddUpToTotal(dana);
  });

  test('a finalized claim session weights a shared item by group size, as its totals do', async ({ page }) => {
    const ctx = await request.newContext({ baseURL: BASE });
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Pitcher House', subtotal: 600, tax: 60, tip: 0, total: 660, currency: 'USD' },
      items: [
        { name: 'Pitcher', quantity: 1, unitPrice: 100, totalPrice: 100 },
        { name: 'Fries', quantity: 1, unitPrice: 500, totalPrice: 500 },
      ],
      creatorName: 'Alice',
      paidByName: 'Alice',
      joinCreator: true,
    });
    expect(createRes.ok(), await createRes.text()).toBe(true);
    const { shareToken, creator } = (await createRes.json()).result.data.json;
    // Bob is here with a friend, so he pays two thirds of what he shares with Alice
    const bob = await joinGuestSession(ctx, { token: shareToken, name: 'Bob', groupSize: 2 });
    for (const [person, items] of [
      [creator, [0, 1]],
      [bob, [0]],
    ] as const) {
      const claimed = await trpcMutation(ctx, 'guest.claimItems', {
        token: shareToken,
        personId: person.personId,
        personToken: person.personToken,
        claimedItemIndices: items,
      });
      expect(claimed.ok(), await claimed.text()).toBe(true);
    }
    const finalized = await trpcMutation(ctx, 'guest.finalizeSession', {
      token: shareToken,
      personId: creator.personId,
      personToken: creator.personToken,
    });
    expect(finalized.ok(), await finalized.text()).toBe(true);
    await ctx.dispose();

    await page.goto(`/en/split/${shareToken}`);
    const alice = personCard(page, 'Alice');
    const bobCard = personCard(page, 'Bob');
    await expect(alice).toContainText('Pitcher (1/3 of $1.00)');
    await expect(alice).toContainText('$0.33');
    await expect(bobCard).toContainText('Pitcher (2/3 of $1.00)');
    await expect(bobCard).toContainText('$0.67');

    await expectLinesAddUpToTotal(alice);
    await expectLinesAddUpToTotal(bobCard);
  });
});
