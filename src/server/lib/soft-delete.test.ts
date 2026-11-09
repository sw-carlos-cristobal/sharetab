import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// #327: a deleted expense or payment keeps its row, so every read of these tables has to
// decide whether a deleted one counts (soft-delete.ts). Missing one skews balances without
// any error, so this lists the files that read them and how many matches each has. When a
// count below changes, check what the new read is for: a list or a balance spreads
// `notDeleted` into its where (and its test says so); anything else says why a deleted row
// still counts.
const READS: Record<string, { count: number; why: string }> = {
  'src/app/api/admin/export/route.ts': { count: 3, why: 'counts them: a full dump, deletedAt included' },
  'src/server/lib/group-balances.ts': { count: 2, why: 'skips them: every balance check reads this' },
  'src/server/lib/group-delete.ts': { count: 5, why: 'counts them: placeholders still named by a row stay' },
  'src/server/lib/placeholder-merge.ts': { count: 6, why: 'counts them: a merge hands deleted records over too' },
  'src/server/lib/receipt-cleanup.ts': { count: 2, why: 'counts them: a deleted expense keeps its receipt' },
  'src/server/trpc/routers/admin.ts': { count: 6, why: 'counts them: stored rows, as with removed members' },
  'src/server/trpc/routers/balances.ts': { count: 4, why: 'skips them: the dashboard balances' },
  'src/server/trpc/routers/expenses.ts': {
    count: 9,
    why: 'list skips them (or lists only them); get returns one; update, delete and restore check deletedAt',
  },
  'src/server/trpc/routers/groups.ts': {
    count: 12,
    why: 'expense counts skip them; the currency lock, history checks and saved receipts count them',
  },
  'src/server/trpc/routers/receipts.ts': { count: 4, why: 'counts them: a deleted expense keeps its receipt' },
  'src/server/trpc/routers/settlements.ts': {
    count: 4,
    why: 'list skips them (or lists only them); delete and restore check deletedAt',
  },
};

// Files that name these tables without reading them
const NOT_READS = new Set([
  'src/server/lib/balance-calculator.ts', // computeBalances' parameters
  'src/server/trpc/router.ts', // the router names
  'src/types/next-intl.d.ts', // the message namespaces
]);

const PATTERNS = [
  // Reads through the model
  /\.(?:expense|settlement|expenseShare)\.(?:findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy)\b/g,
  // Reads and filters through a relation: a group's or a user's expenses and payments
  /\b(?:expenses|settlements|expensesPaid|expensesAdded|expenseShares|settlementsPaid|settlementsFor|expensesDeleted|settlementsDeleted)\s*:/g,
  // A share's or a receipt's expense
  /\bexpense\s*:\s*(?:\{|null|true)/g,
  // Raw SQL
  /"(?:Expense|Settlement|ExpenseShare)"/g,
];

const root = fileURLToPath(new URL('../../../', import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'generated') continue;
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('reads of expenses and payments (#327)', () => {
  test('each one is listed with whether deleted rows count', () => {
    const found: Record<string, number> = {};
    for (const path of sourceFiles(join(root, 'src'))) {
      const file = relative(root, path).split('\\').join('/');
      if (NOT_READS.has(file)) continue;
      const text = readFileSync(path, 'utf8');
      const count = PATTERNS.reduce((sum, re) => sum + [...text.matchAll(re)].length, 0);
      if (count > 0) found[file] = count;
    }
    const expected = Object.fromEntries(Object.entries(READS).map(([file, { count }]) => [file, count]));
    expect(found).toEqual(expected);
  });
});
