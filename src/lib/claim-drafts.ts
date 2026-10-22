/**
 * A person's unsaved claim changes: for each item tapped, whether it's claimed (true) or not
 * (false). Only the changes are kept, not a copy of the person's whole claim set, so the page
 * shows claims another device saved meanwhile on the other items, and a save sends just the
 * items added and removed, which the server applies to whatever is stored then (#226).
 */
export type ClaimEdits = ReadonlyMap<number, boolean>;

/**
 * The claim page keeps unsaved claim edits by person id, since a person's index changes when
 * someone listed before them is removed. The session it polls lists claims by index, so this
 * puts each draft at its person's index in the people list the page has now, and drops the
 * drafts of people who are no longer in it.
 */
export function draftsByIndex<T>(drafts: ReadonlyMap<string, T>, people: readonly { id: string }[]): Map<number, T> {
  const byIndex = new Map<number, T>();
  people.forEach((person, index) => {
    const draft = drafts.get(person.id);
    if (draft !== undefined) byIndex.set(index, draft);
  });
  return byIndex;
}

/** A person's claims as shown: their saved claims with their unsaved changes applied. */
export function withEdits(saved: ReadonlySet<number>, edits: ClaimEdits | undefined): Set<number> {
  const claims = new Set(saved);
  for (const [item, claimed] of edits ?? []) {
    if (claimed) claims.add(item);
    else claims.delete(item);
  }
  return claims;
}

/**
 * A person's changes after tapping an item: it flips from how it's shown. A change that puts
 * the item back to how it's saved is dropped.
 */
export function toggleEdit(
  saved: ReadonlySet<number>,
  edits: ClaimEdits | undefined,
  item: number,
): Map<number, boolean> {
  const next = new Map(edits);
  const claimed = !(edits?.get(item) ?? saved.has(item));
  if (claimed === saved.has(item)) next.delete(item);
  else next.set(item, claimed);
  return next;
}

/**
 * Whether a person's changes differ from their saved claims. A change can come to match them,
 * e.g. when another device saved the same thing.
 */
export function hasEdits(saved: ReadonlySet<number>, edits: ClaimEdits | undefined): boolean {
  for (const [item, claimed] of edits ?? []) {
    if (saved.has(item) !== claimed) return true;
  }
  return false;
}

/** What saving a person's changes sends to guest.claimItems. */
export function editsToSave(edits: ClaimEdits): { addItemIndices: number[]; removeItemIndices: number[] } {
  const addItemIndices: number[] = [];
  const removeItemIndices: number[] = [];
  for (const [item, claimed] of edits) {
    (claimed ? addItemIndices : removeItemIndices).push(item);
  }
  return { addItemIndices, removeItemIndices };
}

/**
 * A person's changes after a save didn't go through: the changes it sent come back as unsaved,
 * under any made while it was in flight (those were judged against the claims as they'd be once
 * it landed, so they win). Changes that match the saved claims are dropped.
 */
export function restoreEdits(
  saved: ReadonlySet<number>,
  sent: ClaimEdits,
  since: ClaimEdits | undefined,
): Map<number, boolean> {
  const restored = new Map<number, boolean>();
  for (const item of new Set([...sent.keys(), ...(since?.keys() ?? [])])) {
    const claimed = since?.get(item) ?? sent.get(item);
    if (claimed !== undefined && claimed !== saved.has(item)) restored.set(item, claimed);
  }
  return restored;
}

/**
 * Newer changes stacked over older ones, keeping every change (none is compared with the saved
 * claims). editsAfterSave uses it wherever the claims the page has may not show what's stored,
 * since comparing with them could drop changes that undo what a save stored.
 */
export function stackEdits(older: ClaimEdits, newer: ClaimEdits | undefined): Map<number, boolean> {
  return new Map([...older, ...(newer ?? [])]);
}

/**
 * How a save ended: stored ('saved'), refused by the server (an error answer that settles it:
 * nothing was stored, or for a retry, what an earlier attempt stored no longer matters), or
 * unknown (no answer, e.g. a dropped connection or a proxy's error page, or a server error: the
 * server may have stored it). The claim page sends an unknown save again with the same save key
 * until it learns which, and after SAVE_ATTEMPTS parks it (see claim-save.ts).
 */
export type SaveOutcome = 'saved' | 'refused' | 'unknown';

/**
 * A person's unsaved changes once a save of `sent` has ended and the page has reloaded (or
 * tried to), given the changes made meanwhile (`since`, judged against the claims with the save
 * applied, so they are kept as they are except after a refusal, see below):
 * - saved: the sent changes are stored, so only the changes made since remain. If no reload
 *   landed, the claims shown catch up at the next poll;
 * - unknown (the page gave up): the save is parked, still shown under the changes made since,
 *   and sent again with its own key before the page's next save (#241). None of its
 *   changes become unsaved changes: saved again under a new key, one that was stored and then
 *   changed back by another device would undo that device's change (#238);
 * - refused and reloaded: nothing was stored (or it no longer matters), so the sent changes come
 *   back under the newer ones, and any of either that the reload already shows are dropped
 *   (restoreEdits);
 * - refused without a reload: every change is kept as it is (stackEdits).
 */
export function editsAfterSave(save: {
  outcome: SaveOutcome;
  reloaded: boolean;
  savedNow: ReadonlySet<number>;
  sent: ClaimEdits;
  since: ClaimEdits | undefined;
}): Map<number, boolean> {
  if (save.outcome !== 'refused') return new Map(save.since);
  if (!save.reloaded) return stackEdits(save.sent, save.since);
  return restoreEdits(save.savedNow, save.sent, save.since);
}

/**
 * The changes a person has sent that the page doesn't yet know were stored, by person id: a save
 * parked for them (#241), with a save in flight over it. What their unsaved changes are shown
 * over and judged by.
 */
export function pendingEdits(
  parked: ReadonlyMap<string, { sent: ClaimEdits }>,
  saving: ReadonlyMap<string, ClaimEdits>,
): Map<string, ClaimEdits> {
  const pending = new Map<string, ClaimEdits>();
  for (const personId of new Set([...parked.keys(), ...saving.keys()])) {
    pending.set(personId, stackEdits(parked.get(personId)?.sent ?? new Map(), saving.get(personId)));
  }
  return pending;
}
