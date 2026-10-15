import { describe, test, expect } from 'vitest';
import { combineShares } from './placeholder-merge';

// #276: when the placeholder and the person it's merged into are both in an
// expense, their shares become one. Only adding the amounts left the split
// mode's own numbers (share units, percentages) at the person's old value, so
// the edit form opened on a different split and saving it moved money.
describe('combineShares', () => {
  test('an exact split adds the amounts', () => {
    expect(
      combineShares(
        'EXACT',
        { amount: 300, shares: 1, percentage: null },
        { amount: 450, shares: 1, percentage: null },
      ),
    ).toEqual({ mode: 'EXACT', share: { amount: 750, shares: 1, percentage: null } });
  });

  test('a split by shares adds the share units', () => {
    expect(
      combineShares(
        'SHARES',
        { amount: 400, shares: 2, percentage: null },
        { amount: 600, shares: 3, percentage: null },
      ),
    ).toEqual({ mode: 'SHARES', share: { amount: 1000, shares: 5, percentage: null } });
  });

  test('a split by percentage adds the percentages', () => {
    expect(
      combineShares(
        'PERCENTAGE',
        { amount: 250, shares: 1, percentage: 2500 },
        { amount: 333, shares: 1, percentage: 3333 },
      ),
    ).toEqual({ mode: 'PERCENTAGE', share: { amount: 583, shares: 1, percentage: 5833 } });
  });

  test('an equal split becomes a split by shares, the merged person holding both shares', () => {
    expect(
      combineShares(
        'EQUAL',
        { amount: 334, shares: 1, percentage: null },
        { amount: 333, shares: 1, percentage: null },
      ),
    ).toEqual({ mode: 'SHARES', share: { amount: 667, shares: 2, percentage: null } });
  });

  test('a receipt split keeps its mode and adds the amounts', () => {
    expect(
      combineShares(
        'ITEM',
        { amount: 1299, shares: 1, percentage: null },
        { amount: 500, shares: 1, percentage: null },
      ),
    ).toEqual({ mode: 'ITEM', share: { amount: 1799, shares: 1, percentage: null } });
  });
});
