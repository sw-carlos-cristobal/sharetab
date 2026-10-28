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
      // nextCursor names the first UNSEEN row, not the last returned row: do not skip it.
      if (cursor) expect(data.expenses[0]?.id).toBe(cursor);
      expect(data.nextCursor).toBe(expected[offset + 10]?.id);
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

    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${history.groupId}`);
    const section = page.getByTestId('expenses-section');
    const search = section.getByRole('searchbox', { name: 'Search expenses', exact: true });
    const more = section.getByRole('button', { name: 'Show more', exact: true });
    await expect(search).toHaveAttribute('placeholder', 'Search titles and notes...');
    await expectRows(page, history.groupId, all.slice(0, 10));
    const sentinel = section.getByTestId('expense-history-sentinel');
    await sentinel.scrollIntoViewIfNeeded();
    await expectRows(page, history.groupId, all.slice(0, 20));
    await expect(more).toBeVisible();
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

  test('a tall viewport does not cascade-load while the sentinel remains in the prefetch margin', async ({
    page,
    history,
  }) => {
    const fixtures: ExpenseFixture[] = [];
    for (let i = 0; i < 25; i++) {
      fixtures.push(await createExpense(history, { title: `Tall viewport ${i}` }));
    }
    const all = newestFirst(fixtures);
    await page.setViewportSize({ width: 1280, height: 1800 });
    const cursorRequests: string[] = [];
    page.on('request', (request) => {
      const input = expenseListInput(new URL(request.url()));
      if (!input || input.groupId !== history.groupId || !input.cursor) return;
      cursorRequests.push(input.cursor);
    });
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${history.groupId}`);
    const section = page.getByTestId('expenses-section');
    const sentinel = section.getByTestId('expense-history-sentinel');
    const more = section.getByRole('button', { name: 'Show more', exact: true });

    await expectRows(page, history.groupId, all.slice(0, 20));
    expect(cursorRequests).toHaveLength(1);
    const remainsInPrefetchMargin = await sentinel.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top <= window.innerHeight + 300 && rect.bottom >= -300;
    });
    expect(remainsInPrefetchMargin).toBe(true);
    await page.waitForTimeout(350);
    await expectRows(page, history.groupId, all.slice(0, 20));
    expect(cursorRequests).toHaveLength(1);
    await expect(more).toBeVisible();

    await more.click();
    await expectRows(page, history.groupId, all);
    expect(cursorRequests).toHaveLength(2);
    await expect(more).toHaveCount(0);
  });

  test('manual Show more works when IntersectionObserver is unavailable', async ({ page, history }) => {
    const fixtures: ExpenseFixture[] = [];
    for (let i = 0; i < 12; i++) {
      fixtures.push(await createExpense(history, { title: `Manual fallback ${i}` }));
    }
    const all = newestFirst(fixtures);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: undefined });
    });
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${history.groupId}`);
    const section = page.getByTestId('expenses-section');
    await expectRows(page, history.groupId, all.slice(0, 10));
    await section.getByTestId('expense-history-sentinel').scrollIntoViewIfNeeded();
    await expectRows(page, history.groupId, all.slice(0, 10));
    const more = section.getByRole('button', { name: 'Show more', exact: true });
    await more.click();
    await expectRows(page, history.groupId, all);
    await expect(more).toHaveCount(0);
  });

  test('failed scroll page keeps existing rows and retries deliberately', async ({ page, history }) => {
    const fixtures: ExpenseFixture[] = [];
    for (let i = 0; i < 12; i++) {
      fixtures.push(await createExpense(history, { title: `Retry scroll ${i}` }));
    }
    const all = newestFirst(fixtures);
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${history.groupId}`);
    const section = page.getByTestId('expenses-section');
    await expectRows(page, history.groupId, all.slice(0, 10));

    const isExpenseList = (url: URL) => expenseListIndex(url) !== -1;
    let cursorRequests = 0;
    await page.route(isExpenseList, async (route) => {
      const url = new URL(route.request().url());
      const listInput = expenseListInput(url);
      if (!listInput?.cursor) return route.continue();
      const body = JSON.parse(url.searchParams.get('input')!);
      const index = url.searchParams.get('batch') === '1' ? expenseListIndex(url) : 0;
      body[index].json.search = 'x'.repeat(1001);
      cursorRequests++;
      url.searchParams.set('input', JSON.stringify(body));
      await route.continue({ url: url.toString() });
    });

    await section.getByTestId('expense-history-sentinel').scrollIntoViewIfNeeded();
    const alert = section.getByRole('alert');
    await expect(alert).toBeVisible();
    await expectRows(page, history.groupId, all.slice(0, 10));
    await expect.poll(() => cursorRequests).toBeGreaterThan(0);
    // React Query may retry the failed request; after the error alert appears,
    // scrolling must not trigger another page load until the user retries.
    const attemptsAfterFailure = cursorRequests;
    await page.waitForTimeout(350);
    expect(cursorRequests).toBe(attemptsAfterFailure);

    await page.unroute(isExpenseList);
    await alert.getByRole('button', { name: 'Retry', exact: true }).click();
    await expectRows(page, history.groupId, all);
    await expect(section.getByRole('alert')).toHaveCount(0);
  });

  test('UI distinguishes an empty history from a search with no matches', async ({ page, history }) => {
    await login(page, users.alice.email, users.alice.password);
    await page.goto(`/en/groups/${history.groupId}`);
    const section = page.getByTestId('expenses-section');
    await expect(section.getByText('No expenses yet.', { exact: true })).toBeVisible();
    await expect(section.getByText('No expenses match your search.', { exact: true })).toHaveCount(0);
    await expect(section.getByTestId('expense-row')).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);

    const expense = await createExpense(history, { title: 'Coffee break' });
    await page.reload();
    await expectRows(page, history.groupId, [expense]);
    const search = section.getByRole('searchbox', { name: 'Search expenses', exact: true });
    await search.fill('nothing-matches-this');
    await expect(section.getByText('No expenses match your search.', { exact: true })).toBeVisible();
    await expect(section.getByText('No expenses yet.', { exact: true })).toHaveCount(0);
    await expect(section.getByTestId('expense-row')).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);
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
