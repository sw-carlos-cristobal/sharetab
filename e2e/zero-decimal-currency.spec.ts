import { test, expect } from '@playwright/test';
import { users, login, createTestGroup, trpcMutation, trpcError } from './helpers';

// #335: every amount is stored in hundredths, which is right for USD and wrong for a currency with
// no decimals. ¥1,000 split three ways came to ¥333.34, ¥333.33 and ¥333.33, each shown as ¥333, so
// the shares on screen added up to ¥999, and the payment dialog offered "333.33".

async function yenGroup(name: string) {
  const group = await createTestGroup(
    users.alice.email,
    users.alice.password,
    [
      { email: users.bob.email, password: users.bob.password },
      { email: users.charlie.email, password: users.charlie.password },
    ],
    name,
  );
  const res = await trpcMutation(group.owner, 'groups.update', { groupId: group.groupId, currency: 'JPY' });
  expect(res.ok()).toBe(true);
  return group;
}

test.describe('A currency with no decimals (#335)', () => {
  test('¥1,000 three ways is ¥334, ¥333 and ¥333, ¥1,000.50 is refused, and a debt settles in whole yen', async ({
    page,
  }) => {
    const { groupId, dispose } = await yenGroup('Yen Split');
    try {
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/en/groups/${groupId}/expenses/new`);
      await page.getByLabel('Description').fill('Ramen');

      const amount = page.getByLabel('Amount', { exact: true });
      await amount.fill('1000.50');
      await expect(page.getByTestId('amount-whole-units')).toHaveText('JPY has no decimals: enter a whole amount.');
      await expect(page.getByRole('button', { name: 'Add Expense' })).toBeDisabled();

      // Each person's row shows the share that's saved, and they add up to ¥1,000
      await amount.fill('1000');
      await expect(page.getByTestId('amount-whole-units')).toHaveCount(0);
      await expect(page.getByText('¥334', { exact: true })).toHaveCount(1);
      await expect(page.getByText('¥333', { exact: true })).toHaveCount(2);
      await page.getByRole('button', { name: 'Add Expense' }).click();
      await page.waitForURL(new RegExp(`/en/groups/${groupId}$`));

      // Bob's debt opens the payment dialog on it in whole yen, which settles it exactly
      const bobsDebt = page.getByRole('button', { name: /^Bob Smith.*Alice Johnson.*¥33[34]/ });
      const owed = /¥(33[34])/.exec((await bobsDebt.textContent()) ?? '')?.[1];
      expect(owed).toBeDefined();
      await bobsDebt.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Amount')).toHaveValue(owed!);
      await dialog.getByTestId('record-payment-btn').click();
      await expect(dialog).not.toBeVisible();
      // Paid off exactly: no debt left either way
      await expect(page.getByRole('button', { name: /^Bob Smith.*Alice Johnson/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Alice Johnson.*Bob Smith/ })).toHaveCount(0);
    } finally {
      await dispose();
    }
  });

  test('the server refuses yen with decimals and converts into whole yen', async () => {
    const { owner, groupId, memberIds, dispose } = await yenGroup('Yen API');
    const aliceId = memberIds[users.alice.email]!;
    const bobId = memberIds[users.bob.email]!;
    try {
      const refused = await trpcMutation(owner, 'expenses.create', {
        groupId,
        title: 'Ramen',
        amount: 100050,
        currency: 'JPY',
        paidById: aliceId,
        splitMode: 'EXACT',
        shares: [{ userId: bobId, amount: 100050 }],
      });
      expect(refused.ok()).toBe(false);
      expect((await trpcError(refused)).message).toBe('Amounts in JPY must be whole units, with no decimals.');

      // $10.00 at 150.3271 yen to the dollar is ¥1,503.271
      const converted = await trpcMutation(owner, 'expenses.create', {
        groupId,
        title: 'Coffee',
        amount: 1000,
        currency: 'USD',
        exchangeRate: 150.3271,
        paidById: aliceId,
        splitMode: 'EXACT',
        shares: [{ userId: bobId, amount: 1000 }],
      });
      expect(converted.ok()).toBe(true);
      expect((await converted.json()).result.data.json.baseCurrencyAmount).toBe(150300);

      const payment = await trpcMutation(owner, 'settlements.create', {
        groupId,
        fromId: bobId,
        toId: aliceId,
        amount: 150350,
        currency: 'JPY',
      });
      expect(payment.ok()).toBe(false);
      expect((await trpcError(payment)).message).toBe('Amounts in JPY must be whole units, with no decimals.');
    } finally {
      await dispose();
    }
  });
});
