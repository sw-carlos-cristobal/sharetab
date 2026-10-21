import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { users, authedContext, createTestGroup, trpcMutation, trpcQuery, trpcResult } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

async function upload(ctx: APIRequestContext, query = '') {
  const res = await ctx.post(`${BASE}/api/upload${query}`, {
    multipart: {
      file: { name: 'receipt.png', mimeType: 'image/png', buffer: readFileSync(resolve('e2e/test-receipt.png')) },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as { receiptId: string; imagePath: string };
}

const imageStatus = async (ctx: APIRequestContext, imagePath: string) =>
  (await ctx.get(`${BASE}/api/uploads/${imagePath}`)).status();

async function createSplit(ctx: APIRequestContext, receiptId?: string) {
  const res = await trpcMutation(ctx, 'guest.createSplit', {
    ...(receiptId ? { receiptId } : {}),
    receiptData: { merchantName: 'Cleanup Diner', subtotal: 1000, tax: 0, tip: 0, total: 1000, currency: 'USD' },
    items: [{ name: 'Pizza', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
    people: [{ name: 'Pat' }],
    assignments: [{ itemIndex: 0, personIndices: [0] }],
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()).result.data.json.shareToken as string;
}

// #265: deleting a group or a Quick Split left its scanned receipts behind (with their
// image files), and a group its placeholder members
test.describe('Deleting takes what only it used', () => {
  test('deleting a group removes its scanned receipts and its placeholder members', async () => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      `Cleanup ${Date.now()}`,
    );
    try {
      const placeholderName = `Cleanup Pat ${Date.now()}`;
      expect((await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: placeholderName })).ok()).toBe(true);
      const { receiptId, imagePath } = await upload(owner);
      const processed = await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000);
      expect(processed.ok(), await processed.text()).toBe(true);
      expect(await imageStatus(owner, imagePath)).toBe(200);

      expect((await trpcMutation(owner, 'groups.delete', { groupId })).ok()).toBe(true);

      // The uploader could still open it while the row stayed
      expect(await imageStatus(owner, imagePath)).toBe(404);
      // Alice is the e2e admin (ADMIN_EMAIL)
      const placeholders = await trpcResult(
        await trpcQuery(owner, 'admin.listUsers', { status: 'placeholder', search: placeholderName }),
      );
      expect(placeholders.users).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test('deleting a Quick Split removes the receipt it was made from', async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    try {
      const { receiptId, imagePath } = await upload(ctx, '?guest=true');
      const shareToken = await createSplit(ctx, receiptId);
      const { splits } = await trpcResult(await trpcQuery(ctx, 'guest.mySplits', { limit: 50 }));
      const split = splits.find((s: { shareToken: string }) => s.shareToken === shareToken);
      expect(await imageStatus(ctx, imagePath)).toBe(200);

      expect((await trpcMutation(ctx, 'guest.deleteSplit', { id: split.id })).ok()).toBe(true);

      expect(await imageStatus(ctx, imagePath)).toBe(404);
    } finally {
      await ctx.dispose();
    }
  });

  test("an expired Quick Split's receipt goes when expired splits are cleared", async () => {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    try {
      const { receiptId, imagePath } = await upload(ctx, '?guest=true');
      const shareToken = await createSplit(ctx, receiptId);
      expect((await trpcMutation(ctx, 'guest.expireSession', { token: shareToken })).ok()).toBe(true);
      expect(await imageStatus(ctx, imagePath)).toBe(200);

      // Each new split clears a batch of expired ones in the background
      await expect
        .poll(
          async () => {
            await createSplit(ctx);
            return imageStatus(ctx, imagePath);
          },
          { timeout: 15_000 },
        )
        .toBe(404);
    } finally {
      await ctx.dispose();
    }
  });
});
