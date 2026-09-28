import { describe, expect, test } from 'vitest';
import {
  draftsByIndex,
  editsAfterSave,
  editsToSave,
  hasEdits,
  restoreEdits,
  stackEdits,
  toggleEdit,
  withEdits,
} from './claim-drafts';

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

  test('keeps a draft whose value is falsy', () => {
    expect(draftsByIndex(new Map([['a', 0]]), [{ id: 'a' }])).toEqual(new Map([[0, 0]]));
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

  test('tapping an item back while its save is in flight keeps the change, judged against the claims being saved', () => {
    // Claimed item 2 and pressed Save; before it lands, tapped item 2 again
    const saving = new Map([[2, true]]);
    const edits = toggleEdit(withEdits(new Set(), saving), saving, 2);
    expect(edits).toEqual(new Map([[2, false]]));
    // Once the save lands, the item shows unclaimed again, still to be saved
    expect(withEdits(new Set([2]), edits)).toEqual(new Set());
    expect(hasEdits(new Set([2]), edits)).toBe(true);
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

describe('restoreEdits', () => {
  test("a failed save's changes come back as unsaved", () => {
    expect(restoreEdits(new Set(), new Map([[2, true]]), undefined)).toEqual(new Map([[2, true]]));
  });

  test('changes made while it was in flight win over the ones it sent', () => {
    const sent = new Map([
      [1, true],
      [2, true],
    ]);
    const since = new Map([[2, false]]);
    expect(restoreEdits(new Set(), sent, since)).toEqual(new Map([[1, true]]));
  });

  test('tapping an item off and back on while its save was in flight keeps it claimed when the save fails', () => {
    // Claimed item 2 and pressed Save; tapped it off and on again (judged against the save in
    // flight, the second tap undid the first); then the save failed
    const sent = new Map([[2, true]]);
    const inFlight = withEdits(new Set(), sent);
    const since = toggleEdit(inFlight, toggleEdit(inFlight, undefined, 2), 2);
    expect(since).toEqual(new Map());
    const restored = restoreEdits(new Set(), sent, since);
    expect(withEdits(new Set(), restored)).toEqual(new Set([2]));
    expect(hasEdits(new Set(), restored)).toBe(true);
  });

  test('drops changes that match the saved claims', () => {
    expect(restoreEdits(new Set([2]), new Map([[2, true]]), new Map([[3, false]]))).toEqual(new Map());
  });
});

describe('stackEdits', () => {
  test('puts newer changes over older ones, keeping every change', () => {
    expect(
      stackEdits(
        new Map([
          [1, true],
          [2, true],
        ]),
        new Map([[2, false]]),
      ),
    ).toEqual(
      new Map([
        [1, true],
        [2, false],
      ]),
    );
    expect(stackEdits(new Map([[1, true]]), undefined)).toEqual(new Map([[1, true]]));
  });

  test('a tap made during a save that stored but did not reload survives the next poll', () => {
    // Saved item 2 (stored); tapped it off meanwhile; the reload failed, so the page still has
    // the claims from before the save
    const sent = new Map([[2, true]]);
    const since = toggleEdit(withEdits(new Set(), sent), undefined, 2);
    const kept = stackEdits(sent, since);
    expect(withEdits(new Set(), kept)).toEqual(new Set());
    // The next poll loads what the save stored: the tap-off is still there, waiting to be saved
    expect(withEdits(new Set([2]), kept)).toEqual(new Set());
    expect(hasEdits(new Set([2]), kept)).toBe(true);
  });
});

describe('editsAfterSave', () => {
  // Claimed item 2 and saved; tapped it off while the save was out
  const sent = new Map([[2, true]]);
  const since = new Map([[2, false]]);

  test('saved and reloaded: only the changes made since remain', () => {
    expect(editsAfterSave({ outcome: 'saved', reloaded: true, savedNow: new Set([2]), sent, since })).toEqual(since);
  });

  test('refused by the server (nothing stored): the sent changes come back under the newer ones', () => {
    const kept = editsAfterSave({
      outcome: 'refused',
      reloaded: true,
      savedNow: new Set(),
      sent: new Map([[1, true]]),
      since: undefined,
    });
    expect(kept).toEqual(new Map([[1, true]]));
  });

  test('no answer (it may still be stored): every change is kept, whatever the reload shows (#226 review)', () => {
    // The reload came back before the save committed, showing item 2 unclaimed
    const kept = editsAfterSave({ outcome: 'unknown', reloaded: true, savedNow: new Set(), sent, since });
    // Once the commit shows up, the tap-off still wins and is waiting to be saved
    expect(withEdits(new Set([2]), kept)).toEqual(new Set());
    expect(hasEdits(new Set([2]), kept)).toBe(true);
  });

  test('refused but not reloaded: every change is kept, since the claims the page has may be stale', () => {
    // Another device claimed item 2 meanwhile, but the page couldn't reload to see it
    const kept = editsAfterSave({ outcome: 'refused', reloaded: false, savedNow: new Set(), sent, since });
    expect(kept).toEqual(new Map([[2, false]]));
    expect(withEdits(new Set([2]), kept)).toEqual(new Set());
  });

  test('saved but not reloaded: every change is kept', () => {
    const kept = editsAfterSave({ outcome: 'saved', reloaded: false, savedNow: new Set(), sent, since });
    expect(kept).toEqual(new Map([[2, false]]));
  });
});
