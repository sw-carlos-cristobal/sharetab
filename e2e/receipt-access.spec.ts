import { test, expect, request } from '@playwright/test';
import {
  authedContext,
  users,
  trpcMutation,
  trpcQuery,
  trpcError,
  trpcResult,
  createTestGroup,
  login,
  FAKE_JPEG,
} from './helpers';

const createdReceiptIds: string[] = [];

const BASE = process.env.BASE_URL || 'http://localhost:3001';

/** Upload a tiny JPEG as an authenticated user and return the receiptId + imagePath. */
async function uploadReceipt(ctx: Awaited<ReturnType<typeof authedContext>>) {
  const res = await ctx.post('/api/upload', {
    multipart: {
      file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG },
    },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { receiptId: string; imagePath: string };
  createdReceiptIds.push(body.receiptId);
  return body;
}

/** Upload a tiny JPEG as a guest and return the receiptId + imagePath. */
async function uploadGuestReceipt() {
  const ctx = await request.newContext({ baseURL: BASE });
  const res = await ctx.post('/api/upload?guest=true', {
    multipart: {
      file: { name: 'guest-receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG },
    },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { receiptId: string; imagePath: string };
  await ctx.dispose();
  return body;
}

test.afterAll(async () => {
  const ctx = await authedContext(users.alice.email, users.alice.password);
  for (const id of createdReceiptIds) {
    try {
      await trpcMutation(ctx, 'receipts.deletePending', { receiptId: id });
    } catch {}
  }
  await ctx.dispose();
});

test.describe('Receipt access control', () => {
  test("User B cannot getReceiptItems for User A's receipt", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const bob = await authedContext(users.bob.email, users.bob.password);

    const { receiptId } = await uploadReceipt(alice);

    const res = await trpcQuery(bob, 'receipts.getReceiptItems', { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe('FORBIDDEN');

    await alice.dispose();
    await bob.dispose();
  });

  test("User B cannot processReceipt for User A's receipt", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const bob = await authedContext(users.bob.email, users.bob.password);

    const { receiptId } = await uploadReceipt(alice);

    const res = await trpcMutation(bob, 'receipts.processReceipt', { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe('FORBIDDEN');

    await alice.dispose();
    await bob.dispose();
  });

  test("User B cannot deletePending for User A's receipt", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const bob = await authedContext(users.bob.email, users.bob.password);

    const { receiptId } = await uploadReceipt(alice);

    const res = await trpcMutation(bob, 'receipts.deletePending', { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe('FORBIDDEN');

    await alice.dispose();
    await bob.dispose();
  });

  test('Guest-uploaded receipt not accessible via auth endpoints', async () => {
    const { receiptId } = await uploadGuestReceipt();
    const alice = await authedContext(users.alice.email, users.alice.password);

    // uploadedById is null for guest receipts, so no authenticated user should match
    const res = await trpcQuery(alice, 'receipts.getReceiptItems', { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe('FORBIDDEN');

    await alice.dispose();
  });

  test('Auth-uploaded receipt not accessible via guest endpoints', async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const { receiptId } = await uploadReceipt(alice);

    // Guest endpoint should reject non-guest receipts
    const guestCtx = await request.newContext({ baseURL: BASE });
    const res = await trpcQuery(guestCtx, 'guest.getReceiptItems', { receiptId });
    const err = await trpcError(res);
    expect(err).toBeTruthy();
    expect(err.data.code).toBe('NOT_FOUND');

    await alice.dispose();
    await guestCtx.dispose();
  });

  test("User B cannot fetch User A's receipt image", async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const bob = await authedContext(users.bob.email, users.bob.password);

    const { imagePath } = await uploadReceipt(alice);

    const res = await bob.get(`/api/uploads/${imagePath}`);
    expect(res.status()).toBe(403);

    await alice.dispose();
    await bob.dispose();
  });

  test('Authenticated user can fetch guest receipt image', async () => {
    const { imagePath } = await uploadGuestReceipt();
    const alice = await authedContext(users.alice.email, users.alice.password);

    const res = await alice.get(`/api/uploads/${imagePath}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/jpeg');

    await alice.dispose();
  });

  test('Unauthenticated user can fetch guest receipt image', async () => {
    const { imagePath } = await uploadGuestReceipt();
    const ctx = await request.newContext({ baseURL: BASE });

    const res = await ctx.get(`/api/uploads/${imagePath}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/jpeg');

    await ctx.dispose();
  });

  test('Unauthenticated user cannot fetch auth-uploaded receipt image', async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const { imagePath } = await uploadReceipt(alice);

    const ctx = await request.newContext({ baseURL: BASE });
    const res = await ctx.get(`/api/uploads/${imagePath}`);
    expect(res.status()).toBe(401);

    await alice.dispose();
    await ctx.dispose();
  });
});

// #318: the group scan page's Share Link makes a claim session from a group receipt. Its
// claim page, open to anyone with the link, shows the receipt's photo, which was served only
// to the group's members; and deleting the receipt from the group's pending list deleted it
// under the claim page.
test.describe('A group receipt shared for claiming (#318)', () => {
  test('anyone can see its photo while the split is open; deleting it from the pending list keeps it until the split goes', async ({
    page,
  }) => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Shared Receipt',
    );
    const anyone = await request.newContext({ baseURL: BASE });
    try {
      const uploadRes = await owner.post('/api/upload', {
        multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
      });
      const { receiptId, imagePath } = (await uploadRes.json()) as { receiptId: string; imagePath: string };
      const processed = await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000);
      expect(processed.ok(), await processed.text()).toBe(true);
      expect((await trpcMutation(owner, 'receipts.saveForLater', { groupId, receiptId })).ok()).toBe(true);
      expect((await anyone.get(`/api/uploads/${imagePath}`)).status()).toBe(401);

      // Share Link, as the group scan page sends it
      const shared = await trpcMutation(owner, 'guest.createClaimSession', {
        receiptId,
        receiptData: {
          merchantName: 'Shared Receipt Cafe',
          subtotal: 1000,
          tax: 0,
          tip: 0,
          total: 1000,
          currency: 'USD',
        },
        items: [{ name: 'Tea', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
        creatorName: 'Alice',
        paidByName: 'Alice',
      });
      expect(shared.ok(), await shared.text()).toBe(true);
      const { shareToken } = (await shared.json()).result.data.json as { shareToken: string };
      expect((await anyone.get(`/api/uploads/${imagePath}`)).status()).toBe(200);

      // Deleted from the group's pending list
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}`);
      await page.getByRole('button', { name: 'Delete receipt' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Delete receipt' })).toHaveCount(0);

      // The claim page still shows it
      const session = await trpcResult(await trpcQuery(anyone, 'guest.getSession', { token: shareToken }));
      expect(session.receiptImagePath).toBe(imagePath);
      expect((await anyone.get(`/api/uploads/${imagePath}`)).status()).toBe(200);

      // Deleting the split takes it, with its photo
      const splits = await trpcResult(await trpcQuery(owner, 'guest.mySplits', { limit: 50 }));
      const split = (splits.splits as { id: string; shareToken: string }[]).find((s) => s.shareToken === shareToken);
      expect(split, 'the split is in My Splits').toBeDefined();
      expect((await trpcMutation(owner, 'guest.deleteSplit', { id: split!.id })).ok()).toBe(true);
      expect((await anyone.get(`/api/uploads/${imagePath}`)).status()).toBe(404);
    } finally {
      await anyone.dispose();
      await dispose();
    }
  });

  // Codex on #319: a split's receipt is shown to anyone with its link, so someone outside the
  // group who knows the receipt's id mustn't be able to make one and publish the photo
  test("someone outside the group can't make a split from its receipt, so the photo stays private", async () => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Private Receipt',
    );
    const anyone = await request.newContext({ baseURL: BASE });
    const bob = await authedContext(users.bob.email, users.bob.password);
    try {
      const uploadRes = await owner.post('/api/upload', {
        multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
      });
      const { receiptId, imagePath } = (await uploadRes.json()) as { receiptId: string; imagePath: string };
      const processed = await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000);
      expect(processed.ok(), await processed.text()).toBe(true);

      const split = {
        receiptId,
        receiptData: { merchantName: 'Private Cafe', subtotal: 1000, tax: 0, tip: 0, total: 1000, currency: 'USD' },
        items: [{ name: 'Tea', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
      };
      for (const ctx of [anyone, bob]) {
        const claim = await trpcMutation(ctx, 'guest.createClaimSession', {
          ...split,
          creatorName: 'Eve',
          paidByName: 'Eve',
        });
        expect((await trpcError(claim))?.data?.code).toBe('NOT_FOUND');
        const quick = await trpcMutation(ctx, 'guest.createSplit', {
          ...split,
          people: [{ name: 'Eve' }],
          assignments: [{ itemIndex: 0, personIndices: [0] }],
        });
        expect((await trpcError(quick))?.data?.code).toBe('NOT_FOUND');
      }
      expect((await anyone.get(`/api/uploads/${imagePath}`)).status()).toBe(401);
      expect((await bob.get(`/api/uploads/${imagePath}`)).status()).toBe(403);
    } finally {
      await bob.dispose();
      await anyone.dispose();
      await dispose();
    }
  });
});
