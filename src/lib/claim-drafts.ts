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
 * claims). For a save that stored its changes but whose reload failed: the claims the page has
 * are from before it, so comparing with them would drop changes that undo what it stored.
 */
export function stackEdits(older: ClaimEdits, newer: ClaimEdits | undefined): Map<number, boolean> {
  return new Map([...older, ...(newer ?? [])]);
}

/**
 * How a save ended: stored ('saved'), refused by the server (an error answer: nothing was
 * stored), or unknown (no answer, e.g. a dropped connection or a proxy's error page: the server
 * may have stored it, even after the page reloaded).
 */
export type SaveOutcome = 'saved' | 'refused' | 'unknown';

/**
 * A person's unsaved changes once a save of `sent` has ended and the page has reloaded (or
 * tried to), given the changes made meanwhile (`since`, judged against the claims with the save
 * applied). Only when the answer settles what's stored are changes compared with the claims:
 * - saved and reloaded: the claims shown include it, so only the changes made since remain;
 * - refused and reloaded: nothing was stored, so the sent changes come back under the newer
 *   ones (restoreEdits, compared with the claims as reloaded);
 * - otherwise (no answer, or not reloaded): the claims the page has may not show what is stored,
 *   now or later, so every change is kept as it is (stackEdits).
 */
export function editsAfterSave(save: {
  outcome: SaveOutcome;
  reloaded: boolean;
  savedNow: ReadonlySet<number>;
  sent: ClaimEdits;
  since: ClaimEdits | undefined;
}): Map<number, boolean> {
  if (save.outcome === 'saved' && save.reloaded) return new Map(save.since);
  if (save.outcome === 'refused' && save.reloaded) return restoreEdits(save.savedNow, save.sent, save.since);
  return stackEdits(save.sent, save.since);
}
