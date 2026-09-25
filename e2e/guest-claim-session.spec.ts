import { test, expect, request } from '@playwright/test';
import { joinGuestSession, trpcMutation, trpcQuery, trpcResult, trpcError } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

const RECEIPT_DATA = {
  merchantName: 'Test Cafe',
  subtotal: 2000,
  tax: 200,
  tip: 100,
  total: 2300,
  currency: 'USD',
};

const ITEMS = [
  { name: 'Item 1', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
  { name: 'Item 2', quantity: 1, unitPrice: 1000, totalPrice: 1000 },
];

test.describe('Guest claiming sessions', () => {
  test('create session and join', async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create a claiming session
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: 'Alice',
      paidByName: 'Alice',
    });
    expect(createRes.ok()).toBe(true);
    const createBody = (await createRes.json()).result?.data?.json;
    const shareToken = createBody.shareToken;
    expect(shareToken).toBeTruthy();

    // Get session -- verify status and initial state
    const getRes = await trpcQuery(ctx, 'guest.getSession', { token: shareToken });
    const session = await trpcResult(getRes);
    expect(session.status).toBe('CLAIMING');
    expect(session.items).toHaveLength(2);
    expect(session.people).toHaveLength(1);
    expect(session.people[0].name).toBe('Alice');

    // Join session as "Bob"
    const joinRes = await trpcMutation(ctx, 'guest.joinSession', {
      token: shareToken,
      name: 'Bob',
    });
    expect(joinRes.ok()).toBe(true);
    const joinBody = (await joinRes.json()).result?.data?.json;
    expect(joinBody.personIndex).toBe(1);
    expect(joinBody.personToken).toBeTruthy();

    // Verify 2 people now
    const getRes2 = await trpcQuery(ctx, 'guest.getSession', { token: shareToken });
    const session2 = await trpcResult(getRes2);
    expect(session2.people).toHaveLength(2);
    expect(session2.people[1].name).toBe('Bob');

    await ctx.dispose();
  });

  test('claim items and verify assignments', async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create session
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: 'Alice',
      paidByName: 'Alice',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Join as Alice (creator) to get a personToken
    const joinRes = await trpcMutation(ctx, 'guest.joinSession', {
      token: shareToken,
      name: 'Alice',
    });
    const { personIndex, personToken } = (await joinRes.json()).result?.data?.json;
    expect(personIndex).toBe(0);

    // Claim items 0 and 1
    const claimRes = await trpcMutation(ctx, 'guest.claimItems', {
      token: shareToken,
      personIndex,
      personToken,
      claimedItemIndices: [0, 1],
    });
    expect(claimRes.ok()).toBe(true);
    expect((await claimRes.json()).result?.data?.json?.success).toBe(true);

    // Verify assignments
    const getRes = await trpcQuery(ctx, 'guest.getSession', { token: shareToken });
    const session = await trpcResult(getRes);
    expect(session.assignments.length).toBeGreaterThanOrEqual(1);

    // Both items should be assigned to person 0
    const item0Assignment = session.assignments.find((a: { itemIndex: number }) => a.itemIndex === 0);
    const item1Assignment = session.assignments.find((a: { itemIndex: number }) => a.itemIndex === 1);
    expect(item0Assignment).toBeDefined();
    expect(item0Assignment.personIndices).toContain(0);
    expect(item1Assignment).toBeDefined();
    expect(item1Assignment.personIndices).toContain(0);

    await ctx.dispose();
  });

  test('finalize session calculates totals', async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create session with 2 items
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: 'Alice',
      paidByName: 'Bob',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Join as Alice (person 0)
    const joinAlice = await trpcMutation(ctx, 'guest.joinSession', {
      token: shareToken,
      name: 'Alice',
    });
    const aliceJoin = (await joinAlice.json()).result?.data?.json;

    // Join as Bob (person 1)
    const joinBob = await trpcMutation(ctx, 'guest.joinSession', {
      token: shareToken,
      name: 'Bob',
    });
    const bobJoin = (await joinBob.json()).result?.data?.json;

    // Alice claims item 0
    await trpcMutation(ctx, 'guest.claimItems', {
      token: shareToken,
      personIndex: aliceJoin.personIndex,
      personToken: aliceJoin.personToken,
      claimedItemIndices: [0],
    });

    // Bob claims item 1
    await trpcMutation(ctx, 'guest.claimItems', {
      token: shareToken,
      personIndex: bobJoin.personIndex,
      personToken: bobJoin.personToken,
      claimedItemIndices: [1],
    });

    // Finalize (Alice finalizes)
    const finalizeRes = await trpcMutation(ctx, 'guest.finalizeSession', {
      token: shareToken,
      personIndex: aliceJoin.personIndex,
      personToken: aliceJoin.personToken,
    });
    expect(finalizeRes.ok()).toBe(true);

    // Get session -- verify finalized status and summary
    const getRes = await trpcQuery(ctx, 'guest.getSession', { token: shareToken });
    const session = await trpcResult(getRes);
    expect(session.status).toBe('FINALIZED');
    expect(session.summary).toBeTruthy();
    expect(session.summary.length).toBeGreaterThanOrEqual(1);

    // Verify summary totals are positive
    for (const entry of session.summary) {
      expect(entry.total).toBeGreaterThan(0);
      expect(entry.name).toBeTruthy();
    }

    await ctx.dispose();
  });

  test('rejoining under a name someone already joined as requires their token', async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: 'Alice',
      paidByName: 'Alice',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // First join as Alice -- gets personToken
    const alice = await joinGuestSession(ctx, { token: shareToken, name: 'Alice' });
    expect(alice.personIndex).toBe(0);

    // Anyone else typing her name (case-insensitive) is refused and gets no token
    const takeover = await trpcMutation(ctx, 'guest.joinSession', { token: shareToken, name: 'alice' });
    expect(takeover.status()).toBe(409);
    const takeoverBody = await takeover.text();
    expect(takeoverBody).not.toContain(alice.personToken);
    expect((await trpcError(takeover))?.data?.code).toBe('CONFLICT');

    // The device holding her token rejoins as her
    const rejoin = await joinGuestSession(ctx, { token: shareToken, name: 'alice', personToken: alice.personToken });
    expect(rejoin).toEqual({ personIndex: 0, personToken: alice.personToken });

    await ctx.dispose();
  });

  test('rejects claims on finalized session', async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: 'Alice',
      paidByName: 'Alice',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Join as Alice
    const joinRes = await trpcMutation(ctx, 'guest.joinSession', {
      token: shareToken,
      name: 'Alice',
    });
    const { personIndex, personToken } = (await joinRes.json()).result?.data?.json;

    // Finalize
    await trpcMutation(ctx, 'guest.finalizeSession', {
      token: shareToken,
      personIndex,
      personToken,
    });

    // Try to claim items on finalized session
    const claimRes = await trpcMutation(ctx, 'guest.claimItems', {
      token: shareToken,
      personIndex,
      personToken,
      claimedItemIndices: [0],
    });
    const err = await trpcError(claimRes);
    expect(err?.data?.code).toBe('BAD_REQUEST');

    await ctx.dispose();
  });

  test('getSplit rejects claiming sessions', async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Create a claiming session (not yet finalized)
    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: 'Alice',
      paidByName: 'Alice',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Try to get it via getSplit (which expects finalized splits)
    const getRes = await trpcQuery(ctx, 'guest.getSplit', { token: shareToken });
    const body = await getRes.json();
    const error = body[0]?.error;
    expect(error).toBeTruthy();
    // getSplit checks status !== "FINALIZED" and returns CONFLICT
    expect(error?.json?.data?.code).toBe('CONFLICT');

    await ctx.dispose();
  });

  test('creator and paidBy are different people when names differ', async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: 'Alice',
      paidByName: 'Bob',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    const getRes = await trpcQuery(ctx, 'guest.getSession', { token: shareToken });
    const session = await trpcResult(getRes);

    // Should have 2 people: Alice and Bob
    expect(session.people).toHaveLength(2);
    expect(session.people[0].name).toBe('Alice');
    expect(session.people[1].name).toBe('Bob');
    expect(session.paidByIndex).toBe(1);

    await ctx.dispose();
  });

  test('multi-quantity items: one person claims more than others after split', async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    // Scenario: 5 beers + nachos. Items with qty > 1 are auto-split into
    // individual rows by createClaimSession, so:
    //   Input: Beer(2), Beer(2), Beer(1), Nachos(1)
    //   Stored: Beer, Beer, Beer, Beer, Beer, Nachos (indices 0-5)
    const splitItems = [
      { name: 'Beer', quantity: 2, unitPrice: 500, totalPrice: 1000 },
      { name: 'Beer', quantity: 2, unitPrice: 500, totalPrice: 1000 },
      { name: 'Beer', quantity: 1, unitPrice: 500, totalPrice: 500 },
      { name: 'Nachos', quantity: 1, unitPrice: 800, totalPrice: 800 },
    ];

    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: {
        merchantName: 'Sports Bar',
        subtotal: 3300,
        tax: 300,
        tip: 500,
        total: 4100,
        currency: 'USD',
      },
      items: splitItems,
      creatorName: 'Alice',
      paidByName: 'Alice',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    // Join all 3 people
    const joinAlice = await trpcMutation(ctx, 'guest.joinSession', { token: shareToken, name: 'Alice' });
    const alice = (await joinAlice.json()).result?.data?.json;

    const joinBob = await trpcMutation(ctx, 'guest.joinSession', { token: shareToken, name: 'Bob' });
    const bob = (await joinBob.json()).result?.data?.json;

    const joinCharlie = await trpcMutation(ctx, 'guest.joinSession', { token: shareToken, name: 'Charlie' });
    const charlie = (await joinCharlie.json()).result?.data?.json;

    // After auto-split: indices 0,1 = first 2x Beer; 2,3 = second 2x Beer; 4 = 1x Beer; 5 = Nachos
    // Alice claims her 2 beers (0,1) + Nachos (5, shared)
    await trpcMutation(ctx, 'guest.claimItems', {
      token: shareToken,
      personIndex: alice.personIndex,
      personToken: alice.personToken,
      claimedItemIndices: [0, 1, 5],
    });

    // Bob claims his 2 beers (2,3) + Nachos (5, shared)
    await trpcMutation(ctx, 'guest.claimItems', {
      token: shareToken,
      personIndex: bob.personIndex,
      personToken: bob.personToken,
      claimedItemIndices: [2, 3, 5],
    });

    // Charlie claims his 1 beer (4) + Nachos (5, shared)
    await trpcMutation(ctx, 'guest.claimItems', {
      token: shareToken,
      personIndex: charlie.personIndex,
      personToken: charlie.personToken,
      claimedItemIndices: [4, 5],
    });

    // Verify assignments
    const sessionRes = await trpcQuery(ctx, 'guest.getSession', { token: shareToken });
    const session = await trpcResult(sessionRes);

    // Items 0,1 (Beer) — only Alice
    const item0 = session.assignments.find((a: { itemIndex: number }) => a.itemIndex === 0);
    expect(item0.personIndices).toEqual([alice.personIndex]);
    const item1 = session.assignments.find((a: { itemIndex: number }) => a.itemIndex === 1);
    expect(item1.personIndices).toEqual([alice.personIndex]);

    // Items 2,3 (Beer) — only Bob
    const item2 = session.assignments.find((a: { itemIndex: number }) => a.itemIndex === 2);
    expect(item2.personIndices).toEqual([bob.personIndex]);
    const item3 = session.assignments.find((a: { itemIndex: number }) => a.itemIndex === 3);
    expect(item3.personIndices).toEqual([bob.personIndex]);

    // Item 4 (Beer) — only Charlie
    const item4 = session.assignments.find((a: { itemIndex: number }) => a.itemIndex === 4);
    expect(item4.personIndices).toEqual([charlie.personIndex]);

    // Item 5 (Nachos) — all three (shared)
    const item5 = session.assignments.find((a: { itemIndex: number }) => a.itemIndex === 5);
    expect(item5.personIndices).toHaveLength(3);
    expect(item5.personIndices).toContain(alice.personIndex);
    expect(item5.personIndices).toContain(bob.personIndex);
    expect(item5.personIndices).toContain(charlie.personIndex);

    // Finalize and verify totals
    const finalizeRes = await trpcMutation(ctx, 'guest.finalizeSession', {
      token: shareToken,
      personIndex: alice.personIndex,
      personToken: alice.personToken,
    });
    expect(finalizeRes.ok()).toBe(true);

    const finalSession = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
    expect(finalSession.status).toBe('FINALIZED');
    expect(finalSession.summary).toHaveLength(3);

    // Alice: $10 (2 beers) + $2.67 (1/3 nachos) + proportional tax/tip
    // Bob: $10 (2 beers) + $2.67 (1/3 nachos) + proportional tax/tip
    // Charlie: $5 (1 beer) + $2.66 (1/3 nachos) + proportional tax/tip
    // Alice and Bob should owe more than Charlie
    const aliceSummary = finalSession.summary.find((s: { personIndex: number }) => s.personIndex === alice.personIndex);
    const bobSummary = finalSession.summary.find((s: { personIndex: number }) => s.personIndex === bob.personIndex);
    const charlieSummary = finalSession.summary.find(
      (s: { personIndex: number }) => s.personIndex === charlie.personIndex,
    );

    expect(aliceSummary.total).toBeGreaterThan(charlieSummary.total);
    expect(bobSummary.total).toBeGreaterThan(charlieSummary.total);
    // Alice and Bob should be roughly equal (both had 2 beers + 1/3 nachos)
    expect(Math.abs(aliceSummary.total - bobSummary.total)).toBeLessThanOrEqual(1);
    // All totals should sum to the grand total
    const totalSum = aliceSummary.total + bobSummary.total + charlieSummary.total;
    expect(totalSum).toBe(4100);

    await ctx.dispose();
  });

  test('creator and paidBy are same person when names match', async () => {
    const ctx = await request.newContext({ baseURL: BASE });

    const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
      receiptData: RECEIPT_DATA,
      items: ITEMS,
      creatorName: 'Alice',
      paidByName: 'Alice',
    });
    const shareToken = (await createRes.json()).result?.data?.json?.shareToken;

    const getRes = await trpcQuery(ctx, 'guest.getSession', { token: shareToken });
    const session = await trpcResult(getRes);

    // Should have 1 person since creator === paidBy
    expect(session.people).toHaveLength(1);
    expect(session.people[0].name).toBe('Alice');
    expect(session.paidByIndex).toBe(0);

    await ctx.dispose();
  });

  // #196: when several requests write to one session at once, Postgres aborts the later
  // writer and the server re-runs it. Every request must still succeed, and no join or claim
  // may be lost. This covers same-session contention and the retry budget; the cross-session
  // aborts behind #196 came from Serializable isolation, and guest-transaction.test.ts pins
  // guestTransaction (which the six claim-session mutations go through) to Repeatable Read.
  // Retries are off so a regression can't pass on a second attempt.
  test.describe('same-session contention', () => {
    test.describe.configure({ retries: 0 });

    test('simultaneous joins and claims on one session all succeed and none are lost', async () => {
      const ctx = await request.newContext({ baseURL: BASE });
      const guests = Array.from({ length: 8 }, (_, i) => `Guest ${i + 1}`);
      const sharedItem = guests.length; // index of the dish everyone claims

      const createRes = await trpcMutation(ctx, 'guest.createClaimSession', {
        receiptData: { merchantName: 'Busy Table', subtotal: 900, tax: 0, tip: 0, total: 900, currency: 'USD' },
        items: [
          ...guests.map((_, i) => ({ name: `Dish ${i + 1}`, quantity: 1, unitPrice: 100, totalPrice: 100 })),
          { name: 'Shared Nachos', quantity: 1, unitPrice: 100, totalPrice: 100 },
        ],
        creatorName: 'Host',
        paidByName: 'Host',
      });
      expect(createRes.ok(), await createRes.text()).toBe(true);
      const shareToken: string = (await createRes.json()).result.data.json.shareToken;
      expect(shareToken).toBeTruthy();

      const joined = await Promise.all(guests.map((name) => joinGuestSession(ctx, { token: shareToken, name })));

      // All at once, each guest claims their own dish plus the shared one
      const claims = await Promise.all(
        joined.map((guest, i) =>
          trpcMutation(ctx, 'guest.claimItems', {
            token: shareToken,
            personIndex: guest.personIndex,
            personToken: guest.personToken,
            claimedItemIndices: [i, sharedItem],
          }),
        ),
      );
      for (const claim of claims) expect(claim.ok(), await claim.text()).toBe(true);

      const session = await trpcResult(await trpcQuery(ctx, 'guest.getSession', { token: shareToken }));
      const assignedTo = (itemIndex: number) =>
        session.assignments
          .find((a: { itemIndex: number }) => a.itemIndex === itemIndex)
          ?.personIndices.toSorted((a: number, b: number) => a - b);

      expect(session.people.map((p: { name: string }) => p.name).sort()).toEqual(['Host', ...guests].sort());
      for (const [i, guest] of joined.entries()) expect(assignedTo(i)).toEqual([guest.personIndex]);
      expect(assignedTo(sharedItem)).toEqual(joined.map((g) => g.personIndex).sort((a, b) => a - b));

      await ctx.dispose();
    });
  });
});
