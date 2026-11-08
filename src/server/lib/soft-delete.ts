/**
 * Deleting an expense or a payment (#327) sets its `deletedAt` instead of removing the
 * row, so a group member can restore it exactly as it was. Spread `notDeleted` into the
 * `where` of every read that lists records or works out balances: missing one skews
 * balances without any error. ExpenseShare has no `deletedAt` of its own, so a read of
 * shares that has to skip deleted expenses filters on `expense: notDeleted`.
 *
 * Reads that skip deleted rows: loadGroupBalances (the group page's balances, the archive
 * and delete checks, the leave and removal checks, the removed-member payment rule),
 * the dashboard balances (balances.getOverallDebts, getDashboard), expenses.list and
 * settlements.list (unless asked for the deleted ones) and the groups lists' expense counts.
 *
 * Reads that still count them, because the row still exists, still names its people and
 * its receipt, and can come back: whether someone is in a group's history (they can't be
 * deleted while a deleted record names them), the group currency lock (a restored expense
 * keeps its conversion to the currency it was made in), placeholder merges (which hand
 * deleted records over too), the receipt checks (a deleted expense keeps its receipt and
 * the receipt's item assignments, so the receipt doesn't come back to the saved receipts
 * and restoring brings it back), the admin counts and export (stored rows, as with removed
 * members), and expenses.get (the detail page shows a deleted expense with Restore).
 *
 * soft-delete.test.ts lists every read of these tables, so a new one has to be put in one
 * group or the other.
 */
export const notDeleted = { deletedAt: null } as const;

/** The group page's Deleted section: only deleted rows. */
export const onlyDeleted = { deletedAt: { not: null } } as const;
