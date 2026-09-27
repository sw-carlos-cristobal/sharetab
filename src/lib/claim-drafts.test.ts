import { describe, expect, test } from 'vitest';
import { draftsByIndex, sameClaims } from './claim-drafts';

describe('draftsByIndex', () => {
  test("puts each person's unsaved claims at their index in the people list the page has now", () => {
    // B was removed: C is second now
    const drafts = new Map([
      ['c', new Set([0])],
      ['a', new Set([1, 2])],
    ]);
    expect(draftsByIndex(drafts, [{ id: 'a' }, { id: 'c' }])).toEqual(
      new Map([
        [1, new Set([0])],
        [0, new Set([1, 2])],
      ]),
    );
  });

  test("drops the drafts of people who aren't in the list (removed)", () => {
    const drafts = new Map([['b', new Set([0])]]);
    expect(draftsByIndex(drafts, [{ id: 'a' }, { id: 'c' }])).toEqual(new Map());
  });
});

describe('sameClaims', () => {
  test('compares as sets', () => {
    expect(sameClaims(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameClaims(new Set([1]), new Set([1, 2]))).toBe(false);
    expect(sameClaims(new Set([1, 3]), new Set([1, 2]))).toBe(false);
    expect(sameClaims(new Set(), new Set())).toBe(true);
  });
});
