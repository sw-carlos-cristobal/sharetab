import { test, expect, request } from '@playwright/test';
import { joinGuestSession, trpcMutation, trpcQuery, trpcError } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// #204: the claim-session writes allow 30 saves of each kind a minute per person (share token +
// the caller's person token) and 300 per share token, and getSession 3000 reads a minute per share
// token. Before, each write allowed 10 a minute for the whole session and getSession 120. A fresh
// session per test keeps the in-memory budgets separate.
test.describe('claim-session rate limits', () => {
  async function newSession(ctx: Awaited<ReturnType<typeof request.newContext>>, itemCount: number) {
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Claim Limit', subtotal: 100, tax: 0, tip: 0, total: 100, currency: 'USD' },
      items: Array.from({ length: itemCount }, (_, i) => ({
        name: `Dish ${i}`,
        quantity: 1,
        unitPrice: 100,
        totalPrice: 100,
      })),
      creatorName: 'Host',
      paidByName: 'Host',
    });
    expect(createRes.ok(), await createRes.text()).toBe(true);
    return (await createRes.json()).result.data.json.shareToken as string;
  }

  test('lets eleven people save their claims in the same minute', async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const shareToken = await newSession(ctx, 11);

    const people = [];
    for (let i = 0; i < 11; i++) {
      people.push(await joinGuestSession(ctx, { token: shareToken, name: `Person ${i}` }));
    }
    for (const [i, person] of people.entries()) {
      const res = await trpcMutation(ctx, 'guest.claimItems', {
        token: shareToken,
        personToken: person.personToken,
        personId: person.personId,
        claimedItemIndices: [i],
      });
      expect(res.ok(), `${person.name}: ${await res.text()}`).toBe(true);
    }

    await ctx.dispose();
  });

  test("refuses a person's 31st save in a minute but still lets someone else save", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const shareToken = await newSession(ctx, 2);
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    const bob = await joinGuestSession(ctx, { token: shareToken, name: 'Bob' });

    const save = (person: typeof alice, items: number[]) =>
      trpcMutation(ctx, 'guest.claimItems', {
        token: shareToken,
        personToken: person.personToken,
        personId: person.personId,
        claimedItemIndices: items,
      });
    for (let i = 0; i < 30; i++) {
      const res = await save(alice, [i % 2]);
      expect(res.ok(), `save ${i + 1}: ${await res.text()}`).toBe(true);
    }

    const refused = await save(alice, [0]);
    expect(refused.status()).toBe(429);
    expect((await trpcError(refused))?.data?.code).toBe('TOO_MANY_REQUESTS');

    const bobSaves = await save(bob, [1]);
    expect(bobSaves.ok(), await bobSaves.text()).toBe(true);

    await ctx.dispose();
  });

  test('keeps answering reads past the old limit of 120 a minute', async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const shareToken = await newSession(ctx, 1);

    // Seven claim pages polling every 3 s make 140 reads a minute
    for (let i = 0; i < 140; i++) {
      const res = await trpcQuery(ctx, 'guest.getSession', { token: shareToken });
      expect(res.ok(), `read ${i + 1}: ${await res.text()}`).toBe(true);
    }

    await ctx.dispose();
  });
});
