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
      // Nobody on it is gone any more, so there's nothing to explain
      await expect(page.getByTestId('former-members-notice')).toHaveCount(0);

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

  // Someone who left before the server took people off saved receipts as they leave is still on
  // them, whenever the receipt was saved, and a save naming someone while an admin deletes their
  // account can put them back. The page leaves them out of what it shows, counts and sends, so the
  // receipt can still be finished, and says why their items need someone.
  test('the page leaves out a saved payer and assignee who are no longer in the group', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await newGroup('Saved Receipt Gone');
    const alice = memberIds[users.alice.email]!;
    const bob = memberIds[users.bob.email]!;
    try {
      const { receiptId, sharedItem, goneItem } = await receiptNamingSomeoneGone(page, owner, groupId, memberIds);

      await openReceipt(page, groupId, receiptId);
      await expect(page.getByTestId('former-members-notice')).toBeVisible();
      // Not the payer: the page picks the signed-in user, as for a receipt saved with none
      await expect(page.getByTestId('paid-by-select')).toHaveValue(alice);
      // Their own item has nobody, and looks it; the one they shared still has Bob
      const create = page.getByTestId('create-expense-btn');
      await expect(create).toHaveText('Assign all items (1 remaining)');
      const goneCard = page.getByTestId(`item-card-${goneItem.id}`);
      await expect(goneCard).toHaveClass(/border-amber-300/);
      await expect(page.getByTestId(`item-card-${sharedItem.id}`)).not.toHaveClass(/border-amber-300/);
      await expect(page.getByTestId(`person-total-${bob}`)).toBeVisible();

      await goneCard.getByTestId(`member-toggle-${bob}`).click();
      await expect(create).toHaveText('Create Expense from Receipt');
      await expect(goneCard).not.toHaveClass(/border-amber-300/);

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
      expect(people[sharedItem.id]).toEqual([bob]);
      expect(people[goneItem.id]).toEqual([bob]);
    } finally {
      await dispose();
    }
  });

  test('a receipt that names someone no longer in the group can be made into an expense', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await newGroup('Saved Receipt Gone Create');
    const alice = memberIds[users.alice.email]!;
    const bob = memberIds[users.bob.email]!;
    try {
      const { receiptId, goneItem } = await receiptNamingSomeoneGone(page, owner, groupId, memberIds);

      await openReceipt(page, groupId, receiptId);
      await page.getByTestId(`item-card-${goneItem.id}`).getByTestId(`member-toggle-${bob}`).click();
      const create = page.getByTestId('create-expense-btn');
      await expect(create).toHaveText('Create Expense from Receipt');
      await create.click();
      await expect(page).toHaveURL(new RegExp(`/groups/${groupId}$`), { timeout: 30000 });

      // Paid by the signed-in user and shared by the two of them: nobody gone is in it
      const { expenses } = await trpcResult(await trpcQuery(owner, 'expenses.list', { groupId, limit: 1 }));
      expect(expenses).toHaveLength(1);
      const expense = await trpcResult(await trpcQuery(owner, 'expenses.get', { groupId, expenseId: expenses[0].id }));
      expect(expense.paidById).toBe(alice);
      expect((expense.shares as { userId: string }[]).map((share) => share.userId).sort()).toEqual([alice, bob].sort());
    } finally {
      await dispose();
    }
  });
});

// A receipt saved for later as one saved before #414 can still read: someone who is in no group is
// its payer, has one item to themselves and shares another with Bob. Saved through the API with
// Bob as payer and on the shared item (the API refuses anyone not in the group), then the receipt
// page's reads of it are rewritten to add the person gone.
async function receiptNamingSomeoneGone(page: Page, owner: Owner, groupId: string, memberIds: Record<string, string>) {
  const alice = memberIds[users.alice.email]!;
  const bob = memberIds[users.bob.email]!;
  const gone = 'departed-user-id';
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

  await page.route('**/api/trpc/**receipts.getReceiptItems**', async (route) => {
    const response = await route.fetch();
    const procedures = new URL(route.request().url()).pathname.split('/').at(-1)!.split(',');
    const body = await response.json();
    const answer = body[procedures.indexOf('receipts.getReceiptItems')].result.data.json;
    answer.receipt.paidById = gone;
    for (const item of answer.items as Item[]) {
      if (item.id === sharedItem!.id || item.id === goneItem!.id) {
        item.assignments.push({ userId: gone, receiptItemId: item.id, id: `a-${item.id}`, shareOfItem: 1 } as never);
      }
    }
    await route.fulfill({ response, json: body });
  });
  return { receiptId, sharedItem: sharedItem!, goneItem: goneItem! };
}
