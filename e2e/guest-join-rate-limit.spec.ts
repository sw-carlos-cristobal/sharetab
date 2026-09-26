import { test, expect, request } from '@playwright/test';
import { trpcMutation, trpcError } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

// #199: guest.joinSession allows 10 joins a minute per person (share token + the caller's
// person token when it sends one, else + name) and 200 per share token. A fresh session per
// test keeps the in-memory budgets separate.
test.describe('guest.joinSession rate limit', () => {
  test("refuses a device's 11th rejoin in a minute but still lets someone else join", async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: { merchantName: 'Join Limit', subtotal: 100, tax: 0, tip: 0, total: 100, currency: 'USD' },
      items: [{ name: 'Dish', quantity: 1, unitPrice: 100, totalPrice: 100 }],
      creatorName: 'Host',
      paidByName: 'Host',
    });
    expect(createRes.ok(), await createRes.text()).toBe(true);
    const shareToken: string = (await createRes.json()).result.data.json.shareToken;

    // Rejoining a name someone holds needs their token, so the looping client here is Alice's
    // own device: it joins once, then rejoins with its token, budgeted by that token. The
    // groupSize toggle makes every rejoin write the session row.
    const first = await trpcMutation(ctx, 'guest.joinSession', { token: shareToken, name: 'Alice' });
    expect(first.ok(), await first.text()).toBe(true);
    const personToken: string = (await first.json()).result.data.json.personToken;
    for (let i = 0; i < 10; i++) {
      const res = await trpcMutation(ctx, 'guest.joinSession', {
        token: shareToken,
        name: 'Alice',
        groupSize: (i % 2) + 1,
        personToken,
      });
      expect(res.ok(), `rejoin ${i + 1}: ${await res.text()}`).toBe(true);
    }

    const refused = await trpcMutation(ctx, 'guest.joinSession', {
      token: shareToken,
      name: 'alice',
      groupSize: 2,
      personToken,
    });
    expect(refused.status()).toBe(429);
    expect((await trpcError(refused))?.data?.code).toBe('TOO_MANY_REQUESTS');

    const bob = await trpcMutation(ctx, 'guest.joinSession', { token: shareToken, name: 'Bob' });
    expect(bob.ok(), await bob.text()).toBe(true);

    await ctx.dispose();
  });
});
