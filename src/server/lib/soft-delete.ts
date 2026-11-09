/**
 * Deleting an expense or a payment (#327) sets its `deletedAt` instead of removing the
 * row, so whoever may delete it can restore it as it was. Spread `notDeleted` into the
 * `where` of every read that lists records or works out balances: missing one skews
 * balances without any error. ExpenseShare has no `deletedAt` of its own, so a read of
 * shares that has to skip deleted expenses filters on `expense: notDeleted`.
 *
 * Reads that skip deleted rows: loadGroupBalances (the group page's balances, the archive
 * and delete checks, the leave and removal checks, the removed-member payment rule, and
 * the expense restore's former-member check), the dashboard balances (balances.getOverallDebts, getDashboard), expenses.list and
 * settlements.list (unless asked for the deleted ones) and the groups lists' expense counts.
 *
 * Reads that still count them, because the row still exists, still names its people and
 * its receipt, and can come back: whether someone is in a group's history (they can't be
 * deleted while a deleted record names them), the group currency lock (a restored expense's
 * amounts are in the group currency it was recorded in), placeholder merges (which hand
 * deleted records over too), the receipt checks (a deleted expense keeps its receipt and
 * the receipt's item assignments, so the receipt doesn't come back to the saved receipts
 * and restoring brings it back), the admin counts, totals and export (stored rows, as with
 * removed members), and expenses.get (the detail page shows a deleted expense with Restore).
 *
 * soft-delete.test.ts lists the files that read these tables and how many matches each has,
 * so a file whose count changes fails it until its count is updated; its `why` should then
 * say whether deleted rows count (only the count is checked).
 */
export const notDeleted = { deletedAt: null } as const;

/** The group page's Deleted section: only deleted rows. */
export const onlyDeleted = { deletedAt: { not: null } } as const;
