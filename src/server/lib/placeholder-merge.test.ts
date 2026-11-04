import { describe, test, expect } from 'vitest';
import { combineShares } from './placeholder-merge';

// #276: when the placeholder and the person it's merged into are both in an
// expense, their shares become one. Share units or percentages recomputed for
// the merged person can land a cent away from what's stored (the form's
// rounding depends on member order), so the stored amounts are kept as an
// exact split, and saving the expense unchanged moves nothing.
describe('combineShares', () => {
  const share = (amount: number, shares = 1, percentage: number | null = null) => ({ amount, shares, percentage });

  test.each([['EXACT'], ['EQUAL'], ['SHARES'], ['PERCENTAGE']] as const)(
    'a split %s becomes an exact split of the two amounts added up',
    (mode) => {
      expect(combineShares(mode, share(334, 2, 3340), share(333, 1, 3330))).toEqual({
        mode: 'EXACT',
        share: { amount: 667, shares: 1, percentage: null },
      });
    },
  );

  test('a receipt split keeps its mode, which the edit form already opens as exact amounts', () => {
    expect(combineShares('ITEM', share(1299), share(500))).toEqual({
      mode: 'ITEM',
      share: { amount: 1799, shares: 1, percentage: null },
    });
  });
});
