import { test, expect } from '@playwright/test';
import {
  login,
  users,
  createTestGroup,
  navigateToGroup,
  trpcMutation,
  trpcQuery,
  trpcResult,
  trpcError,
} from './helpers';

// #261: a recorded payment was never shown again and couldn't be removed, so a
// typo ($500 instead of $50) skewed the group's balances for good.

type Ctx = Parameters<typeof trpcMutation>[0];

async function bobOwesAliceHalf(owner: Ctx, groupId: string, aliceId: string, bobId: string) {
  await trpcMutation(owner, 'expenses.create', {
    groupId,
    title: 'Bob owes half',
    amount: 1000,
    paidById: aliceId,
    splitMode: 'EQUAL',
    shares: [
      { userId: aliceId, amount: 500 },
      { userId: bobId, amount: 500 },
    ],
  });
}

async function netOf(ctx: Ctx, groupId: string, userId: string) {
  const { balances } = await trpcResult(await trpcQuery(ctx, 'balances.getGroupBalances', { groupId }));
  return balances.find((b: { userId: string }) => b.userId === userId).net as number;
}

test.describe('Deleting a recorded payment', () => {
  test('the payer deletes a mistaken payment, the balances go back and the deletion is logged', async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Payment Delete Payer',
    );
    const bob = memberContexts[0]!;
    const aliceId = memberIds[users.alice.email]!;
    const bobId = memberIds[users.bob.email]!;
    await bobOwesAliceHalf(owner, groupId, aliceId, bobId);

    // $500 instead of $5
    const created = (
      await (await trpcMutation(bob, 'settlements.create', { groupId, toId: aliceId, amount: 50000 })).json()
    ).result?.data?.json;
    expect(await netOf(bob, groupId, bobId)).toBe(49500);

    const listed = await trpcResult(await trpcQuery(bob, 'settlements.list', { groupId }));
    expect(listed.items.map((p: { id: string }) => p.id)).toEqual([created.id]);

    const res = await trpcMutation(bob, 'settlements.delete', { groupId, settlementId: created.id });
    expect((await res.json()).result?.data?.json).toEqual({ success: true });

    expect((await trpcResult(await trpcQuery(bob, 'settlements.list', { groupId }))).items).toEqual([]);
    expect(await netOf(bob, groupId, bobId)).toBe(-500);

    const activity = await trpcResult(await trpcQuery(owner, 'activity.getGroupActivity', { groupId }));
    const deleted = activity.items.find((a: { type: string }) => a.type === 'SETTLEMENT_DELETED');
    expect(deleted).toMatchObject({
      entityId: created.id,
      userId: bobId,
      metadata: { fromId: bobId, toId: aliceId, amount: 50000, currency: 'USD' },
    });

    await dispose();
  });

  test('the recipient cannot delete a payment, but the group owner can', async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [
        { email: users.bob.email, password: users.bob.password },
        { email: users.charlie.email, password: users.charlie.password },
      ],
      'Payment Delete Recipient',
    );
    const [bob, charlie] = [memberContexts[0]!, memberContexts[1]!];
    const charlieId = memberIds[users.charlie.email]!;

    const created = (
      await (await trpcMutation(bob, 'settlements.create', { groupId, toId: charlieId, amount: 500 })).json()
    ).result?.data?.json;

    const refused = await trpcError(
      await trpcMutation(charlie, 'settlements.delete', { groupId, settlementId: created.id }),
    );
    expect(refused?.data?.code).toBe('FORBIDDEN');
    expect((await trpcResult(await trpcQuery(owner, 'settlements.list', { groupId }))).items).toHaveLength(1);

    const res = await trpcMutation(owner, 'settlements.delete', { groupId, settlementId: created.id });
    expect((await res.json()).result?.data?.json).toEqual({ success: true });
    expect((await trpcResult(await trpcQuery(owner, 'settlements.list', { groupId }))).items).toEqual([]);

    await dispose();
  });

  test('an archived group refuses the deletion', async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Payment Delete Archived',
    );
    const aliceId = memberIds[users.alice.email]!;
    const bobId = memberIds[users.bob.email]!;
    await bobOwesAliceHalf(owner, groupId, aliceId, bobId);
    const created = (
      await (
        await trpcMutation(owner, 'settlements.create', { groupId, fromId: bobId, toId: aliceId, amount: 500 })
      ).json()
    ).result?.data?.json;
    await trpcMutation(owner, 'groups.archive', { groupId });

    const refused = await trpcError(
      await trpcMutation(owner, 'settlements.delete', { groupId, settlementId: created.id }),
    );
    expect(refused?.data?.code).toBe('BAD_REQUEST');
    expect((await trpcResult(await trpcQuery(owner, 'settlements.list', { groupId }))).items).toHaveLength(1);

    await trpcMutation(owner, 'groups.unarchive', { groupId });
    await dispose();
  });

  test('the group page lists payments and lets the payer delete theirs', async ({ page }) => {
    const groupName = `Payments UI ${Date.now()}`;
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [
        { email: users.bob.email, password: users.bob.password },
        { email: users.charlie.email, password: users.charlie.password },
      ],
      groupName,
    );
    const aliceId = memberIds[users.alice.email]!;
    const bobId = memberIds[users.bob.email]!;
    const charlieId = memberIds[users.charlie.email]!;
    await trpcMutation(owner, 'settlements.create', { groupId, fromId: bobId, toId: aliceId, amount: 50000 });
    await trpcMutation(owner, 'settlements.create', { groupId, fromId: charlieId, toId: aliceId, amount: 1200 });

    await login(page, users.bob.email, users.bob.password);
    await navigateToGroup(page, groupName);

    const rows = page.getByTestId('payment-row');
    await expect(rows).toHaveCount(2);
    // Bob made only one of the two payments, so only that one can be deleted
    await expect(page.getByTestId('delete-payment')).toHaveCount(1);

    const mine = rows.filter({ hasText: '$500.00' });
    await mine
      .getByRole('button', { name: `Delete the payment of $500.00 from ${users.bob.name} to ${users.alice.name}` })
      .click();
    await expect(page.getByRole('dialog')).toContainText('Delete this payment?');
    await page.getByTestId('confirm-delete-payment').click();

    await expect(page.getByText('Payment deleted')).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('$12.00');

    await dispose();
  });
});
