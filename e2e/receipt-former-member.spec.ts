import { test, expect, type Page } from '@playwright/test';
import { users, login, createTestGroup, trpcMutation, trpcQuery, trpcResult, FAKE_JPEG } from './helpers';

type Owner = Awaited<ReturnType<typeof createTestGroup>>['owner'];
type Item = { id: string; name: string; assignments: { userId: string }[] };

// The mock AI provider (AI_PROVIDER_PRIORITY=mock, as CI runs) reads 18 items from any image
async function scanReceipt(owner: Owner, groupId: string) {
  const uploadRes = await owner.post('/api/upload', {
    multipart: { file: { name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: FAKE_JPEG } },
  });
  const { receiptId } = await uploadRes.json();
  const processed = await (await trpcMutation(owner, 'receipts.processReceipt', { receiptId, groupId }, 60_000)).json();
  expect(processed.result, JSON.stringify(processed)).toBeDefined();
  const { items } = await trpcResult(await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }));
  return { receiptId: receiptId as string, items: items as Item[] };
}

async function openReceipt(page: Page, groupId: string, receiptId: string) {
  await login(page, users.alice.email, users.alice.password);
  await page.goto(`/en/groups/${groupId}/scan?receiptId=${receiptId}`);
  await expect(page.getByTestId('split-all-btn')).toBeVisible({ timeout: 30000 });
}

async function ok(res: { ok: () => boolean; text: () => Promise<string> }) {
  expect(res.ok(), await res.text()).toBe(true);
}

function newGroup(name: string) {
  return createTestGroup(
    users.alice.email,
    users.alice.password,
    [
      { email: users.bob.email, password: users.bob.password },
      { email: users.charlie.email, password: users.charlie.password },
    ],
    name,
  );
}

// #414: someone who left the group stayed assigned on its receipts saved for later, and stayed
// their payer. The receipt page draws chips only for current members, so their item showed
// nobody selected yet counted as assigned, and Create Expense and Save for later were both
// refused; only "Split all equally", which discards every per-item choice, got past it.
test.describe('Receipt scan: someone saved on a receipt leaves the group (#414)', () => {
  test('their items show as unassigned, and the receipt can be finished once they are reassigned', async ({ page }) => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await newGroup('Saved Receipt Leaver');
    const alice = memberIds[users.alice.email]!;
    const bob = memberIds[users.bob.email]!;
    const charlie = memberIds[users.charlie.email]!;
    try {
      const { receiptId, items } = await scanReceipt(owner, groupId);
      const [charliesItem, ...rest] = items;
      await ok(
        await trpcMutation(owner, 'receipts.saveForLater', {
          groupId,
          receiptId,
          paidById: charlie,
          assignments: [
            { receiptItemId: charliesItem!.id, userIds: [charlie] },
            ...rest.map((item) => ({ receiptItemId: item.id, userIds: [alice] })),
          ],
        }),
      );

      // Charlie leaves: the group has no expenses yet, so they're settled up
      await ok(await trpcMutation(memberContexts[1]!, 'groups.removeMember', { groupId, userId: charlie }));

      // Taken off the receipt: no longer its payer, and on none of its items
      const { receipt, items: after } = await trpcResult(
        await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }),
      );
      expect(receipt.paidById).toBeNull();
      expect((after as Item[]).flatMap((item) => item.assignments.map((a) => a.userId))).not.toContain(charlie);
      expect((after as Item[]).find((item) => item.id === charliesItem!.id)!.assignments).toEqual([]);

      await openReceipt(page, groupId, receiptId);
      const create = page.getByTestId('create-expense-btn');
      await expect(create).toHaveText('Assign all items (1 remaining)');
      await expect(page.getByTestId('paid-by-select')).toHaveValue(alice);

      await page.getByTestId(`item-card-${charliesItem!.id}`).getByTestId(`member-toggle-${bob}`).click();
      await expect(create).toHaveText('Create Expense from Receipt');
      await create.click();
      await expect(page).toHaveURL(new RegExp(`/groups/${groupId}$`), { timeout: 30000 });

      const { expenses } = await trpcResult(await trpcQuery(owner, 'expenses.list', { groupId, limit: 1 }));
      expect(expenses).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  // Receipts saved before people were taken off them as they left still name them, and a save
  // racing an admin deleting an account can too. The page leaves them out of what it counts and
  // sends, so the receipt can still be finished, and says why their items need someone.
  test('the page leaves out a saved payer and assignee who are no longer in the group', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await newGroup('Saved Receipt Gone');
    const alice = memberIds[users.alice.email]!;
    const bob = memberIds[users.bob.email]!;
    const gone = 'departed-user-id';
    try {
      const { receiptId, items } = await scanReceipt(owner, groupId);
      const [sharedItem, goneItem, ...rest] = items;
      await ok(
        await trpcMutation(owner, 'receipts.saveForLater', {
          groupId,
          receiptId,
          paidById: bob,
          assignments: [
            { receiptItemId: sharedItem!.id, userIds: [bob] },
            ...rest.map((item) => ({ receiptItemId: item.id, userIds: [alice] })),
          ],
        }),
      );

      // The receipt as such a save left it: the person gone is its payer, has one item to
      // themselves and shares another
      await page.route('**/api/trpc/**receipts.getReceiptItems**', async (route) => {
        const response = await route.fetch();
        const procedures = new URL(route.request().url()).pathname.split('/').at(-1)!.split(',');
        const body = await response.json();
        const answer = body[procedures.indexOf('receipts.getReceiptItems')].result.data.json;
        answer.receipt.paidById = gone;
        for (const item of answer.items as (Item & { id: string })[]) {
          if (item.id === sharedItem!.id || item.id === goneItem!.id) {
            item.assignments.push({
              userId: gone,
              receiptItemId: item.id,
              id: `a-${item.id}`,
              shareOfItem: 1,
            } as never);
          }
        }
        await route.fulfill({ response, json: body });
      });

      await openReceipt(page, groupId, receiptId);
      await expect(page.getByTestId('former-members-notice')).toBeVisible();
      // Not the payer: the page picks the signed-in user, as for a receipt saved with none
      await expect(page.getByTestId('paid-by-select')).toHaveValue(alice);
      // Their own item has nobody; the one they shared still has Bob
      const create = page.getByTestId('create-expense-btn');
      await expect(create).toHaveText('Assign all items (1 remaining)');
      await expect(page.getByTestId(`person-total-${bob}`)).toBeVisible();

      await page.getByTestId(`item-card-${goneItem!.id}`).getByTestId(`member-toggle-${bob}`).click();
      await expect(create).toHaveText('Create Expense from Receipt');

      // Saved without them, so Save for later isn't refused for naming them
      const saved = page.waitForResponse((res) => res.url().includes('receipts.saveForLater'));
      await page.getByRole('button', { name: 'Save for Later' }).click();
      expect((await saved).ok()).toBe(true);
      await expect(page).toHaveURL(new RegExp(`/groups/${groupId}$`), { timeout: 30000 });

      await page.unrouteAll({ behavior: 'ignoreErrors' });
      const { receipt, items: after } = await trpcResult(
        await trpcQuery(owner, 'receipts.getReceiptItems', { receiptId }),
      );
      expect(receipt.paidById).toBe(alice);
      const people = Object.fromEntries(
        (after as Item[]).map((item) => [item.id, item.assignments.map((a) => a.userId).sort()]),
      );
      expect(people[sharedItem!.id]).toEqual([bob]);
      expect(people[goneItem!.id]).toEqual([bob]);
    } finally {
      await dispose();
    }
  });
});
