import { describe, test, expect } from 'vitest';
import { splitEditorSeed } from './split-editor-seed';

describe('splitEditorSeed', () => {
  test('EQUAL opens with the saved people selected', () => {
    const seed = splitEditorSeed('EQUAL', [
      { userId: 'a', amount: 500 },
      { userId: 'b', amount: 500 },
    ]);
    expect(seed).toEqual({ mode: 'EQUAL', initialSelected: ['a', 'b'] });
  });

  test('EXACT opens with each saved amount', () => {
    const seed = splitEditorSeed('EXACT', [
      { userId: 'a', amount: 1931 },
      { userId: 'b', amount: 1120 },
    ]);
    expect(seed).toEqual({ mode: 'EXACT', initialAmounts: { a: '19.31', b: '11.20' } });
  });

  test('PERCENTAGE opens with the saved basis points as percentages', () => {
    const seed = splitEditorSeed('PERCENTAGE', [
      { userId: 'a', amount: 3333, percentage: 3333 },
      { userId: 'b', amount: 6667, percentage: 6667 },
      { userId: 'c', amount: 0 },
    ]);
    expect(seed).toEqual({ mode: 'PERCENTAGE', initialPercentages: { a: '33.33', b: '66.67', c: '0' } });
  });

  test('SHARES opens with the saved units, 1 when a unit count is missing', () => {
    const seed = splitEditorSeed('SHARES', [
      { userId: 'a', amount: 750, shares: 3 },
      { userId: 'b', amount: 250 },
    ]);
    expect(seed).toEqual({ mode: 'SHARES', initialShareUnits: { a: '3', b: '1' } });
  });

  // #274: a receipt split used to open as EQUAL with no seed, so saving even a
  // title-only edit spread the expense equally over every group member.
  test('ITEM (receipt) opens as EXACT with each saved amount', () => {
    const seed = splitEditorSeed('ITEM', [
      { userId: 'a', amount: 1931 },
      { userId: 'b', amount: 918 },
      { userId: 'c', amount: 202 },
    ]);
    expect(seed).toEqual({ mode: 'EXACT', initialAmounts: { a: '19.31', b: '9.18', c: '2.02' } });
  });

  test('ITEM with no saved shares opens as EXACT on its defaults', () => {
    expect(splitEditorSeed('ITEM', [])).toEqual({ mode: 'EXACT' });
  });

  test('no saved shares leaves the editor on its defaults', () => {
    expect(splitEditorSeed('EXACT', [])).toEqual({ mode: 'EXACT' });
  });
});
