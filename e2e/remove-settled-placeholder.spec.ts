import { test, expect } from '@playwright/test';
import { users, login, createTestGroup, trpcMutation, trpcQuery, trpcResult } from './helpers';

// #284: a placeholder who is in expenses could never be removed, even once settled up. Now
// one at a zero balance can be: they leave the member list and the pickers for new expenses,
// but their history stays theirs, so a balance that comes back shows under their name and
// can be settled with them.
test('a settled-up placeholder can be removed, and a balance that comes back can be settled', async ({ page }) => {
  const { owner, groupId, memberIds, dispose } = await createTestGroup(
    users.alice.email,
    users.alice.password,
    [],
    'Remove Settled Placeholder UI',
  );
  try {
    const aliceId = memberIds[users.alice.email]!;
    const created = async (proc: string, input: unknown) => {
      const body = await (await trpcMutation(owner, proc, input)).json();
      expect(body.result, JSON.stringify(body)).toBeDefined();
      return body.result.data.json;
    };
    const hal = await created('groups.addPlaceholder', { groupId, name: 'Hal' });
    // Hal owes Alice $5.00 for one, and Alice owes Hal $5.00 for the other
    const alicePaid = await created('expenses.create', {
      groupId,
      title: 'Alice paid',
      amount: 1000,
      paidById: aliceId,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 500 },
        { userId: hal.id, amount: 500 },
      ],
    });
    const halPaid = await created('expenses.create', {
      groupId,
      title: 'Hal paid',
      amount: 1000,
      paidById: hal.id,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 500 },
        { userId: hal.id, amount: 500 },
      ],
    });

    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${groupId}/settings`);
    await page.getByRole('button', { name: 'Remove Hal' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove Hal?' });
    await expect(dialog).toContainText('Their past expenses and payments stay as they are.');
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove Hal' })).toHaveCount(0);

    // Gone from the member list, and from the people a new expense can be split with
    await page.goto(`/en/groups/${groupId}`);
    await expect(page.getByText('All settled up!')).toBeVisible();
    await expect(page.getByText('Hal', { exact: true })).toHaveCount(0);
    await page.goto(`/en/groups/${groupId}/expenses/new`);
    await expect(page.getByLabel('Paid by')).toBeVisible();
    await expect(page.getByText('Hal', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Paid by').locator('option', { hasText: 'Hal' })).toHaveCount(0);

    // Editing an expense Hal is in keeps his share there, instead of moving it to Alice
    await page.goto(`/en/groups/${groupId}/expenses/${alicePaid.id}/edit`);
    await expect(page.getByRole('heading', { name: 'Edit Expense' })).toBeVisible();
    await expect(page.getByText('Hal', { exact: true })).toBeVisible();
    await expect(page.getByText(/shares for former group members/)).toHaveCount(0);
    await page.locator('#title').fill('Alice paid (edited)');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await page.waitForURL(`**/groups/${groupId}/expenses/${alicePaid.id}`);
    const edited = await trpcResult(await trpcQuery(owner, 'expenses.get', { groupId, expenseId: alicePaid.id }));
    expect(edited.shares.map((s: { userId: string; amount: number }) => [s.userId, s.amount]).sort()).toEqual(
      [
        [aliceId, 500],
        [hal.id, 500],
      ].sort(),
    );

    // Without the expense Hal paid, Hal owes Alice $5.00 again: shown under his name
    await created('expenses.delete', { groupId, expenseId: halPaid.id });
    await page.goto(`/en/groups/${groupId}`);
    const debt = page.getByRole('button', { name: /Hal.*Alice Johnson.*\$5\.00/ });
    await expect(debt).toBeVisible();

    // ...and settled from it
    await debt.click();
    await expect(page.getByLabel('From').locator('option:checked')).toHaveText('Hal');
    await expect(page.getByLabel('To', { exact: true }).locator('option:checked')).toHaveText(users.alice.name);
    await page.getByTestId('record-payment-btn').click();
    await expect(page.getByText('All settled up!')).toBeVisible();
  } finally {
    await dispose();
  }
});
