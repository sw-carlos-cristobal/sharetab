import { test, expect } from '@playwright/test';
import { users, login, createTestGroup, trpcMutation } from './helpers';

// #341: a plain member (role MEMBER) may record only payments they made, and settlements.create
// refuses any other with "You can only record payments from yourself". The group page opened the
// payment dialog from every balance row, with a From list of everyone, so a member could fill in a
// payment between two other people that the server then turned down.

async function threeWayGroup(name: string) {
  const group = await createTestGroup(
    users.alice.email,
    users.alice.password,
    [
      { email: users.bob.email, password: users.bob.password },
      { email: users.charlie.email, password: users.charlie.password },
    ],
    name,
  );
  const aliceId = group.memberIds[users.alice.email]!;
  const bobId = group.memberIds[users.bob.email]!;
  const charlieId = group.memberIds[users.charlie.email]!;
  // Bob and Charlie each owe Alice $10.00
  const res = await trpcMutation(group.owner, 'expenses.create', {
    groupId: group.groupId,
    title: 'Dinner',
    amount: 3000,
    paidById: aliceId,
    splitMode: 'EQUAL',
    shares: [
      { userId: aliceId, amount: 1000 },
      { userId: bobId, amount: 1000 },
      { userId: charlieId, amount: 1000 },
    ],
  });
  expect(res.ok()).toBe(true);
  return group;
}

test.describe('Recording a payment by role (#341)', () => {
  test('a member can record only a payment they made', async ({ page }) => {
    const { groupId, dispose } = await threeWayGroup('Settle As Member');
    try {
      await login(page, users.bob.email, users.bob.password);
      await page.goto(`/en/groups/${groupId}`);

      // Charlie's debt to Alice is shown, but isn't Bob's to record
      const bobsDebt = page.getByRole('button', { name: /^Bob Smith.*Alice Johnson.*\$10\.00/ });
      await expect(bobsDebt).toBeVisible();
      await expect(page.getByText(/Charlie Brown.*Alice Johnson.*\$10\.00/)).toBeVisible();
      await expect(page.getByRole('button', { name: /^Charlie Brown.*Alice Johnson/ })).toHaveCount(0);

      // Settle up fixes From to Bob: shown, not a choice
      await page.getByRole('button', { name: 'Settle up' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('combobox', { name: 'From' })).toHaveCount(0);
      await expect(dialog.getByRole('textbox', { name: 'From' })).toHaveValue(users.bob.name);
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).not.toBeVisible();

      // His own debt opens the dialog with him as the payer, and the payment is recorded
      await bobsDebt.click();
      await expect(dialog.getByRole('textbox', { name: 'From' })).toHaveValue(users.bob.name);
      await expect(dialog.getByLabel('To', { exact: true }).locator('option:checked')).toHaveText(users.alice.name);
      await dialog.getByTestId('record-payment-btn').click();
      await expect(dialog).not.toBeVisible();
      await expect(page.getByRole('button', { name: /^Bob Smith.*Alice Johnson/ })).toHaveCount(0);
      await expect(page.getByText(/Charlie Brown.*Alice Johnson.*\$10\.00/)).toBeVisible();
    } finally {
      await dispose();
    }
  });

  test('the owner can still record a payment between two other members', async ({ page }) => {
    const { groupId, dispose } = await threeWayGroup('Settle As Owner');
    try {
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}`);

      // Every debt opens the dialog for the owner
      await expect(page.getByRole('button', { name: /^Bob Smith.*Alice Johnson.*\$10\.00/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Charlie Brown.*Alice Johnson.*\$10\.00/ })).toBeVisible();

      // Bob pays Charlie $5.00, recorded by Alice
      await page.getByRole('button', { name: 'Settle up' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('combobox', { name: 'From' }).selectOption({ label: users.bob.name });
      await dialog.getByLabel('To', { exact: true }).selectOption({ label: users.charlie.name });
      await dialog.getByLabel('Amount').fill('5.00');
      await dialog.getByTestId('record-payment-btn').click();
      await expect(dialog).not.toBeVisible();

      // Bob now owes Alice $5.00 and Charlie owes her $15.00
      await expect(page.getByRole('button', { name: /^Bob Smith.*Alice Johnson.*\$5\.00/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Charlie Brown.*Alice Johnson.*\$15\.00/ })).toBeVisible();
    } finally {
      await dispose();
    }
  });
});
