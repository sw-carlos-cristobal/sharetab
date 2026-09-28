import { describe, expect, test } from 'vitest';
import { draftsByIndex, editsToSave, hasEdits, toggleEdit, withEdits } from './claim-drafts';

describe('draftsByIndex', () => {
  test("puts each person's unsaved claims at their index in the people list the page has now", () => {
    // B was removed: C is second now
    const drafts = new Map([
      ['c', new Map([[0, true]])],
      ['a', new Map([[1, false]])],
    ]);
    expect(draftsByIndex(drafts, [{ id: 'a' }, { id: 'c' }])).toEqual(
      new Map([
        [1, new Map([[0, true]])],
        [0, new Map([[1, false]])],
      ]),
    );
  });

  test("drops the drafts of people who aren't in the list (removed)", () => {
    const drafts = new Map([['b', new Map([[0, true]])]]);
    expect(draftsByIndex(drafts, [{ id: 'a' }, { id: 'c' }])).toEqual(new Map());
  });
});

describe('withEdits', () => {
  test('shows the saved claims with the unsaved changes applied', () => {
    const saved = new Set([0, 1]);
    const edits = new Map([
      [1, false],
      [2, true],
    ]);
    expect(withEdits(saved, edits)).toEqual(new Set([0, 2]));
  });

  test('shows claims another device saved since the edit started, on items not changed here (#226)', () => {
    // Ann tapped item 2 for Cat; Cat's phone has since saved items 0 and 1
    const edits = new Map([[2, true]]);
    expect(withEdits(new Set([0, 1]), edits)).toEqual(new Set([0, 1, 2]));
  });

  test('shows the saved claims when there are no changes', () => {
    expect(withEdits(new Set([3]), undefined)).toEqual(new Set([3]));
  });
});

describe('toggleEdit', () => {
  test('flips an item from how it is shown', () => {
    expect(toggleEdit(new Set([0]), undefined, 2)).toEqual(new Map([[2, true]]));
    expect(toggleEdit(new Set([0]), undefined, 0)).toEqual(new Map([[0, false]]));
  });

  test('drops the change when tapping puts the item back to how it is saved', () => {
    const edits = toggleEdit(new Set([0]), undefined, 2);
    expect(toggleEdit(new Set([0]), edits, 2)).toEqual(new Map());
  });

  test('keeps the other changes', () => {
    const edits = new Map([[1, true]]);
    expect(toggleEdit(new Set(), edits, 2)).toEqual(
      new Map([
        [1, true],
        [2, true],
      ]),
    );
    // The original is left as it was
    expect(edits).toEqual(new Map([[1, true]]));
  });
});

describe('hasEdits', () => {
  test('is true while a change differs from the saved claims', () => {
    expect(hasEdits(new Set([0]), new Map([[2, true]]))).toBe(true);
    expect(hasEdits(new Set([0]), new Map([[0, false]]))).toBe(true);
  });

  test('is false with no changes, or once the saved claims match them (e.g. saved from another device)', () => {
    expect(hasEdits(new Set([0]), undefined)).toBe(false);
    expect(hasEdits(new Set([0]), new Map())).toBe(false);
    expect(
      hasEdits(
        new Set([0, 2]),
        new Map([
          [2, true],
          [1, false],
        ]),
      ),
    ).toBe(false);
  });
});

describe('editsToSave', () => {
  test('lists the items to add and to remove', () => {
    const edits = new Map([
      [2, true],
      [0, false],
      [5, true],
    ]);
    expect(editsToSave(edits)).toEqual({ addItemIndices: [2, 5], removeItemIndices: [0] });
  });

  test('sends nothing for no changes', () => {
    expect(editsToSave(new Map())).toEqual({ addItemIndices: [], removeItemIndices: [] });
  });
});
