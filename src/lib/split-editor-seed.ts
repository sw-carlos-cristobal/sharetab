import { centsToDecimal } from './money';

/** The split modes the expense form can edit. A receipt (ITEM) split has no editor of its own. */
export type EditableSplitMode = 'EQUAL' | 'EXACT' | 'PERCENTAGE' | 'SHARES';

export type SavedShare = {
  userId: string;
  amount: number;
  shares?: number | undefined;
  percentage?: number | undefined;
};

export type SplitEditorSeed = {
  mode: EditableSplitMode;
  initialSelected?: string[];
  initialAmounts?: Record<string, string>;
  initialPercentages?: Record<string, string>;
  initialShareUnits?: Record<string, string>;
};

/**
 * The split editor the edit-expense form opens on, seeded with the saved
 * shares so that saving without touching the split keeps it as it was.
 * Only the opening mode is seeded; the other modes keep their new-expense
 * defaults. (percentage is stored in basis points: 5000 = 50%)
 *
 * A receipt (ITEM) split opens as EXACT with each person's saved amount: the
 * form can't edit item assignments, and the equal split it used to open on
 * charged every group member, including people who weren't on the receipt.
 */
export function splitEditorSeed(savedMode: EditableSplitMode | 'ITEM', savedShares: SavedShare[]): SplitEditorSeed {
  const mode: EditableSplitMode = savedMode === 'ITEM' ? 'EXACT' : savedMode;
  if (savedShares.length === 0) {
    return { mode };
  }
  switch (mode) {
    case 'EQUAL':
      return { mode, initialSelected: savedShares.map((s) => s.userId) };
    case 'EXACT':
      return {
        mode,
        initialAmounts: Object.fromEntries(savedShares.map((s) => [s.userId, centsToDecimal(s.amount)])),
      };
    case 'PERCENTAGE':
      return {
        mode,
        initialPercentages: Object.fromEntries(
          savedShares.map((s) => [s.userId, s.percentage != null ? String(s.percentage / 100) : '0']),
        ),
      };
    case 'SHARES':
      return {
        mode,
        initialShareUnits: Object.fromEntries(savedShares.map((s) => [s.userId, String(s.shares ?? 1)])),
      };
  }
}
