import { test, expect } from '@playwright/test';
import { login, users, createTestGroup, trpcMutation, trpcError } from './helpers';

function getSessionUrl(token: unknown) {
  return `/api/trpc/guest.getSession?batch=1&input=${encodeURIComponent(JSON.stringify({ '0': { json: { token } } }))}`;
}

// #266: text that stayed in English, or showed a raw value, on pages in another language
test.describe('Server errors in the page language', () => {
  test('a request that sends its language gets the error in it, with a key; one without gets English', async ({
    request,
  }) => {
    const de = await trpcError(await request.get(getSessionUrl('no-such-token'), { headers: { 'x-locale': 'de' } }));
    expect(de?.data?.code).toBe('NOT_FOUND');
    expect(de?.data?.messageKey).toBe('sessionNotFound');
    expect(de?.message).toBe('Session nicht gefunden');

    const en = await trpcError(await request.get(getSessionUrl('no-such-token')));
    expect(en?.data?.messageKey).toBe('sessionNotFound');
    expect(en?.message).toBe('Session not found');
  });

  test('input that fails validation gets a plain message, not the validator output', async ({ request }) => {
    const err = await trpcError(await request.get(getSessionUrl(42), { headers: { 'x-locale': 'de' } }));
    expect(err?.data?.code).toBe('BAD_REQUEST');
    expect(err?.data?.messageKey).toBeNull();
    expect(err?.message).toBe('Diese Anfrage war ungültig. Laden Sie die Seite neu und versuchen Sie es erneut.');
  });

  test('a German member who owes money is told to settle up in German', async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Errors Leave Owing DE',
    );
    const aliceId = memberIds[users.alice.email]!;
    const bobId = memberIds[users.bob.email]!;
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
    try {
      await login(page, users.bob.email, users.bob.password);
      await page.goto(`/de/groups/${groupId}/settings`);
      await page.getByRole('button', { name: /Gruppe verlassen/ }).click();
      await page
        .getByRole('alertdialog', { name: 'Diese Gruppe verlassen?' })
        .getByRole('button', { name: 'Gruppe verlassen' })
        .click();

      await expect(
        page.getByText(
          'Sie haben in dieser Gruppe noch offene Beträge. Gleichen Sie diese aus, bevor Sie die Gruppe verlassen.',
        ),
      ).toBeVisible();
      await expect(page.getByText('Settle up before you leave', { exact: false })).toHaveCount(0);
    } finally {
      await dispose();
    }
  });
});

test.describe('Labels in the page language', () => {
  test("an expense's split mode and a dialog's close button are translated", async ({ page }) => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Labels DE',
    );
    const aliceId = memberIds[users.alice.email]!;
    const bobId = memberIds[users.bob.email]!;
    const created = await trpcMutation(owner, 'expenses.create', {
      groupId,
      title: 'Split evenly',
      amount: 1000,
      paidById: aliceId,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 500 },
        { userId: bobId, amount: 500 },
      ],
    });
    const expenseId = (await created.json()).result.data.json.id as string;
    try {
      await login(page, users.alice.email, users.alice.password);
      await page.goto(`/de/groups/${groupId}/expenses/${expenseId}`);
      await expect(page.getByText('Gleichmäßig', { exact: true })).toBeVisible();
      await expect(page.getByText('EQUAL', { exact: true })).toHaveCount(0);

      await page.goto(`/de/groups/${groupId}`);
      await page.getByRole('button', { name: 'Einladen' }).click();
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Schließen' })).toBeVisible();
    } finally {
      await dispose();
    }
  });
});
