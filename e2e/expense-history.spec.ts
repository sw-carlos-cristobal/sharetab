import { test as base, expect, type Page } from '@playwright/test';
import superjson from 'superjson';
import { createTestGroup, login, trpcError, trpcMutation, trpcQuery, users } from './helpers';

type TestGroup = Awaited<ReturnType<typeof createTestGroup>>;
type ExpenseFixture = { id: string; title: string; expenseDate: string };
type ListInput = { groupId: string; search?: string; cursor?: string; limit?: number };
type ExpensePage = { expenses: { id: string; groupId: string }[]; nextCursor?: string };
const SAME_DATE = '2025-06-15T12:00:00.000Z';

// Every test owns its data; failures still delete the group and dispose its API context.
const test = base.extend<{ history: TestGroup }>({
  history: async ({}, provide, testInfo) => {
    const group = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      `Expense history ${testInfo.testId}`,
    );
    try {
      await provide(group);
    } finally {
      await group.dispose();
    }
  },
});

async function createExpense(
  group: TestGroup,
  input: { title: string; description?: string; expenseDate?: string },
): Promise<ExpenseFixture> {
  const ownerId = Object.values(group.memberIds)[0];
  expect(ownerId).toEqual(expect.any(String));
  const expenseDate = input.expenseDate ?? SAME_DATE;
  const response = await trpcMutation(group.owner, 'expenses.create', {
    ...input,
    expenseDate,
    groupId: group.groupId,
    amount: 100,
    currency: 'USD',
    paidById: ownerId,
    splitMode: 'EQUAL',
    shares: [{ userId: ownerId, amount: 100 }],
  });
  expect(response.ok(), await response.text()).toBe(true);
  const expense = (await response.json()).result?.data?.json;
  expect(expense?.id).toEqual(expect.any(String));
  expect(expense.id).not.toBe('');
  return { id: expense.id, title: input.title, expenseDate };
}

async function listExpenses(group: TestGroup, input: Omit<ListInput, 'groupId'> = {}): Promise<ExpensePage> {
  const response = await trpcQuery(group.owner, 'expenses.list', { groupId: group.groupId, ...input });
  expect(response.ok(), await response.text()).toBe(true);
  // Preserve SuperJSON's undefined cursor: the raw JSON represents it as null.
  const body = await response.json();
  const data = superjson.deserialize<ExpensePage>(body[0].result.data);
  expect(Array.isArray(data?.expenses)).toBe(true);
  return data;
}

function newestFirst(expenses: ExpenseFixture[]) {
  return [...expenses].sort(
    (a, b) => b.expenseDate.localeCompare(a.expenseDate) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

async function expectRows(page: Page, groupId: string, expenses: ExpenseFixture[]) {
  const rows = page.getByTestId('expenses-section').getByTestId('expense-row');
  await expect(rows).toHaveCount(expenses.length);
  await expect
    .poll(() => rows.evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
    .toEqual(expenses.map((expense) => `/en/groups/${groupId}/expenses/${expense.id}`));
  await expect(rows).toContainText(expenses.map((expense) => expense.title));
}

function expenseListIndex(url: URL) {
  if (!url.pathname.startsWith('/api/trpc/')) return -1;
  return url.pathname.slice('/api/trpc/'.length).split(',').indexOf('expenses.list');
}

function expenseListInput(url: URL): ListInput | undefined {
  const index = expenseListIndex(url);
  if (index === -1) return undefined;
  const input = JSON.parse(url.searchParams.get('input') ?? 'null');
  return (url.searchParams.get('batch') === '1' ? input?.[index] : input)?.json;
}

test.describe('Expense history (#326)', () => {
  test('API walks every cursor in date-desc, id-desc order without gaps or duplicates', async ({ history }) => {
    // Create the newest first and oldest last, so id order alone cannot satisfy date order.
    const fixtures = [await createExpense(history, { title: 'Newest date', expenseDate: '2025-07-01T12:00:00.000Z' })];
    for (let i = 0; i < 23; i++) {
      fixtures.push(await createExpense(history, { title: `Same timestamp ${i}` }));
    }
    fixtures.push(await createExpense(history, { title: 'Oldest date', expenseDate: '2025-05-01T12:00:00.000Z' }));
    const expected = newestFirst(fixtures);
    const visited: string[] = [];
    let cursor: string | undefined;

    for (let offset = 0; offset < expected.length; offset += 10) {
      const data = await listExpenses(history, { limit: 10, ...(cursor ? { cursor } : {}) });
      expect(data.expenses.map((expense) => expense.id)).toEqual(
        expected.slice(offset, offset + 10).map((expense) => expense.id),
      );
      expect(data.expenses.every((expense) => expense.groupId === history.groupId)).toBe(true);
      expect(data.nextCursor === undefined).toBe(offset + 10 >= expected.length);
      visited.push(...data.expenses.map((expense) => expense.id));
      cursor = data.nextCursor;
    }

    expect(visited).toEqual(expected.map((expense) => expense.id));
    expect(new Set(visited).size).toBe(fixtures.length);
    expect(cursor).toBeUndefined();
  });

  test('API searches trimmed title and notes substrings case-insensitively, within authorized groups', async ({
    history,
  }) => {
    const other = await createTestGroup(users.bob.email, users.bob.password, [], 'Other expense history');
    try {
      const titleMatch = await createExpense(history, { title: 'Pizza night' });
      const notesMatch = await createExpense(history, {
        title: 'Dinner receipt',
        description: 'Shared a PIZZA with friends.',
      });
      const unrelated = await createExpense(history, { title: 'Train tickets' });
      await createExpense(other, { title: 'Pizza in another group', description: 'Private pizza notes' });
      const matches = newestFirst([titleMatch, notesMatch]).map((expense) => expense.id);

      for (const search of ['  pIzZa  ', 'zza']) {
        const data = await listExpenses(history, { search, limit: 10 });
        expect(data.expenses.map((expense) => expense.id)).toEqual(matches);
        expect(data.expenses.every((expense) => expense.groupId === history.groupId)).toBe(true);
        expect(data.nextCursor).toBeUndefined();
      }
      const allIds = newestFirst([titleMatch, notesMatch, unrelated]).map((expense) => expense.id);
      expect((await listExpenses(history)).expenses.map((expense) => expense.id)).toEqual(allIds);
      expect((await listExpenses(history, { search: ' \t\n ' })).expenses.map((expense) => expense.id)).toEqual(allIds);
      expect((await listExpenses(history, { search: 'x'.repeat(1000) })).expenses).toEqual([]);

      const tooLong = await trpcQuery(history.owner, 'expenses.list', {
        groupId: history.groupId,
        search: 'x'.repeat(1001),
      });
      expect(tooLong.ok()).toBe(false);
      expect((await trpcError(tooLong))?.data?.code).toBe('BAD_REQUEST');

      const forbidden = await trpcQuery(history.owner, 'expenses.list', { groupId: other.groupId, search: 'pizza' });
      expect(forbidden.ok()).toBe(false);
      expect((await trpcError(forbidden))?.data?.code).toBe('FORBIDDEN');
    } finally {
      await other.dispose();
    }
  });

  test('API paging survives the next expense being deleted or re-dated between pages (#478)', async ({ history }) => {
    const fixtures: ExpenseFixture[] = [];
    for (let i = 0; i < 8; i++) fixtures.push(await createExpense(history, { title: `Cursor row ${i}` }));
    const ids = newestFirst(fixtures).map((expense) => expense.id);
    const page = async (cursor?: string) => {
      const data = await listExpenses(history, { limit: 2, ...(cursor ? { cursor } : {}) });
      return { ids: data.expenses.map((expense) => expense.id), nextCursor: data.nextCursor };
    };

    const first = await page();
    expect(first.ids).toEqual(ids.slice(0, 2));
    // The cursor stands for ids[2], the first expense not shown yet: delete it.
    const deleted = await trpcMutation(history.owner, 'expenses.delete', {
      groupId: history.groupId,
      expenseId: ids[2],
    });
    expect(deleted.ok(), await deleted.text()).toBe(true);
    const second = await page(first.nextCursor);
    expect(second.ids).toEqual(ids.slice(3, 5));

    // Now it stands for ids[5]: move that expense to the oldest date.
    const moved = await trpcMutation(history.owner, 'expenses.update', {
      groupId: history.groupId,
      expenseId: ids[5],
      expenseDate: '2025-01-01T12:00:00.000Z',
    });
    expect(moved.ok(), await moved.text()).toBe(true);
    const third = await page(second.nextCursor);
    expect(third.ids).toEqual(ids.slice(6, 8));
    expect(await page(third.nextCursor)).toEqual({ ids: [ids[5]], nextCursor: undefined });
  });

  test('API search matches %, _ and \\ literally and refuses a NUL byte (#479)', async ({ history }) => {
    const percent = await createExpense(history, { title: 'Sale 50% off' });
    await createExpense(history, { title: '50 dollars' });
    const underscore = await createExpense(history, { title: 'tax_rate' });
    const backslash = await createExpense(history, { title: 'C:\\receipts' });
    const ids = async (search: string) =>
      (await listExpenses(history, { search })).expenses.map((expense) => expense.id);

    expect(await ids('50%')).toEqual([percent.id]);
    expect(await ids('%')).toEqual([percent.id]);
    expect(await ids('_')).toEqual([underscore.id]);
    expect(await ids('\\')).toEqual([backslash.id]);
    expect(await ids(':\\R')).toEqual([backslash.id]);

    const nul = await trpcQuery(history.owner, 'expenses.list', { groupId: history.groupId, search: 'a\u0000b' });
    expect(nul.ok()).toBe(false);
    expect((await trpcError(nul))?.data?.code).toBe('BAD_REQUEST');
  });

  test('UI pages the full history and keeps search results isolated when changing or clearing the search', async ({
    page,
    history,
  }) => {
    const matches: ExpenseFixture[] = [await createExpense(history, { title: 'Pizza night' })];
    for (let i = 0; i < 11; i++) {
      matches.push(await createExpense(history, { title: `Dinner receipt ${i}`, description: 'Notes mention PIZZA' }));
    }
    const fixtures = [...matches];
    for (let i = 0; i < 8; i++) fixtures.push(await createExpense(history, { title: `Groceries ${i}` }));
    const taxi = await createExpense(history, { title: 'Taxi home' });
    fixtures.push(taxi);
    const all = newestFirst(fixtures);
    const filtered = newestFirst(matches);

    const cursorRequests: string[] = [];
    page.on('request', (request) => {
      const input = expenseListInput(new URL(request.url()));
      if (input && input.groupId === history.groupId && input.cursor) cursorRequests.push(input.cursor);
    });
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${history.groupId}`);
    const section = page.getByTestId('expenses-section');
    const search = section.getByRole('searchbox', { name: 'Search expenses', exact: true });
    const more = section.getByRole('button', { name: 'Show more expenses', exact: true });
    await expect(search).toHaveAttribute('placeholder', 'Search titles and notes...');
    await expectRows(page, history.groupId, all.slice(0, 10));

    // Scrolling down to Payments, below the list, loads nothing more: only Show more does (#477).
    // On desktop <main> scrolls, on mobile the window does.
    await page.locator('main').evaluate((main) => main.scrollTo(0, main.scrollHeight));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500); // nothing to wait for when nothing should happen
    expect(cursorRequests).toEqual([]);
    await expectRows(page, history.groupId, all.slice(0, 10));

    await more.click();
    await expectRows(page, history.groupId, all.slice(0, 20));
    await more.click();
    await expectRows(page, history.groupId, all);
    await expect(more).toHaveCount(0);

    await search.fill('  pIzZa  ');
    await expectRows(page, history.groupId, filtered.slice(0, 10));
    await more.click();
    await expectRows(page, history.groupId, filtered);
    await expect(more).toHaveCount(0);

    await search.fill('taxi');
    await expectRows(page, history.groupId, [taxi]);
    await expect(more).toHaveCount(0);
    await search.fill('');
    // React Query restores pages already loaded for this filter, never another filter's rows.
    await expectRows(page, history.groupId, all);
    await expect(more).toHaveCount(0);
    await search.fill('pIzZa');
    await expectRows(page, history.groupId, filtered);
    await expect(more).toHaveCount(0);
  });

  test('a failed older page keeps the rows and reports the error next to Show more, which retries', async ({
    page,
    history,
  }) => {
    const fixtures: ExpenseFixture[] = [];
    for (let i = 0; i < 12; i++) {
      fixtures.push(await createExpense(history, { title: `Retry page ${i}` }));
    }
    const all = newestFirst(fixtures);
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${history.groupId}`);
    const section = page.getByTestId('expenses-section');
    const more = section.getByRole('button', { name: 'Show more expenses', exact: true });
    await expectRows(page, history.groupId, all.slice(0, 10));

    // Make only the older page fail, with a real server validation error.
    const isExpenseList = (url: URL) => expenseListIndex(url) !== -1;
    await page.route(isExpenseList, async (route) => {
      const url = new URL(route.request().url());
      if (!expenseListInput(url)?.cursor) return route.continue();
      const body = JSON.parse(url.searchParams.get('input')!);
      const index = url.searchParams.get('batch') === '1' ? expenseListIndex(url) : 0;
      body[index].json.search = 'x'.repeat(1001);
      url.searchParams.set('input', JSON.stringify(body));
      await route.continue({ url: url.toString() });
    });

    await more.click();
    // Beside the button the user just pressed, not above the list (#477). React Query
    // retries a failed request three times (about 7 s) before reporting it.
    const alert = more.locator('xpath=..').getByRole('alert');
    await expect(alert).toHaveText("That request wasn't valid. Reload the page and try again.", { timeout: 30_000 });
    await expect(section.getByRole('alert')).toHaveCount(1);
    await expect(section.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    await expectRows(page, history.groupId, all.slice(0, 10));

    await page.unroute(isExpenseList);
    await more.click();
    await expectRows(page, history.groupId, all);
    await expect(section.getByRole('alert')).toHaveCount(0);
    await expect(more).toHaveCount(0);
  });

  test('UI distinguishes an empty history from a search with no matches', async ({ page, history }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${history.groupId}`);
    const section = page.getByTestId('expenses-section');
    await expect(section.getByText('No expenses yet.', { exact: true })).toBeVisible();
    await expect(section.getByText('No expenses match your search.', { exact: true })).toHaveCount(0);
    await expect(section.getByTestId('expense-row')).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Show more expenses', exact: true })).toHaveCount(0);

    const expense = await createExpense(history, { title: 'Coffee break' });
    await page.reload();
    await expectRows(page, history.groupId, [expense]);
    const search = section.getByRole('searchbox', { name: 'Search expenses', exact: true });
    await search.fill('nothing-matches-this');
    await expect(section.getByText('No expenses match your search.', { exact: true })).toBeVisible();
    await expect(section.getByText('No expenses yet.', { exact: true })).toHaveCount(0);
    await expect(section.getByTestId('expense-row')).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Show more expenses', exact: true })).toHaveCount(0);
    await search.fill('');
    await expectRows(page, history.groupId, [expense]);
    await expect(section.getByText('No expenses match your search.', { exact: true })).toHaveCount(0);
  });

  test('UI debounces search requests for 300ms after the last edit', async ({ page, history }) => {
    const pizza = await createExpense(history, { title: 'Pizza night' });
    const coffee = await createExpense(history, { title: 'Coffee break' });
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${history.groupId}`);
    await expectRows(page, history.groupId, newestFirst([pizza, coffee]));

    await page.clock.install({ time: new Date('2025-08-01T12:00:00.000Z') });
    await page.clock.pauseAt(new Date('2025-08-01T12:00:01.000Z'));
    const searches: string[] = [];
    page.on('request', (request) => {
      const input = expenseListInput(new URL(request.url()));
      if (input && input.groupId === history.groupId && input.search) searches.push(input.search);
    });
    const search = page.getByRole('searchbox', { name: 'Search expenses', exact: true });
    for (const text of ['p', 'pi', 'pizza']) {
      await search.fill(text);
      await page.clock.runFor(299);
      expect(searches).toEqual([]);
    }
    const answered = page.waitForResponse((response) => {
      const input = expenseListInput(new URL(response.url()));
      return !!input && input.groupId === history.groupId && input.search === 'pizza';
    });
    await page.clock.runFor(1);
    await page.clock.resume();
    expect((await answered).ok()).toBe(true);
    await expectRows(page, history.groupId, [pizza]);
    expect(searches).toEqual(['pizza']);
  });

  test('UI shows the server error instead of an empty state and Retry recovers', async ({ page, history }) => {
    const expense = await createExpense(history, { title: 'Retry dinner' });
    await login(page, users.alice.email, users.alice.password);
    const isExpenseList = (url: URL) => expenseListIndex(url) !== -1;
    let failedRequests = 0;
    await page.route(isExpenseList, async (route) => {
      // Trigger a REAL server validation error only for expenses.list, preserving sibling
      // queries in the tRPC batch and the page's locale header. No canned error response.
      const url = new URL(route.request().url());
      const input = JSON.parse(url.searchParams.get('input')!);
      input[expenseListIndex(url)].json.search = 'x'.repeat(1001);
      url.searchParams.set('input', JSON.stringify(input));
      failedRequests += 1;
      await route.continue({ url: url.toString() });
    });
    await page.goto(`/en/groups/${history.groupId}`);
    const section = page.getByTestId('expenses-section');
    const error = section.getByText("That request wasn't valid. Reload the page and try again.", { exact: true });
    await expect(error).toBeVisible();
    expect(failedRequests).toBeGreaterThan(0);
    await expect(section.getByText('No expenses yet.', { exact: true })).toHaveCount(0);
    await expect(section.getByText('No expenses match your search.', { exact: true })).toHaveCount(0);
    await expect(section.getByTestId('expense-row')).toHaveCount(0);

    await page.unroute(isExpenseList);
    await section.getByRole('button', { name: 'Retry', exact: true }).click();
    await expectRows(page, history.groupId, [expense]);
    await expect(error).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  });
});
