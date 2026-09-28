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
 * until it learns which, and gives up after SAVE_ATTEMPTS (see claim-save.ts).
 */
export type SaveOutcome = 'saved' | 'refused' | 'unknown';

/**
 * A person's unsaved changes once a save of `sent` has ended and the page has reloaded (or
 * tried to), given the changes made meanwhile (`since`, judged against the claims with the save
 * applied, so they are kept as they are except after a refusal, see below):
 * - saved: the sent changes are stored, so only the changes made since remain. If no reload
 *   landed, the claims shown catch up at the next poll;
 * - refused and reloaded: nothing was stored (or it no longer matters), so the sent changes come
 *   back under the newer ones, and any of either that the reload already shows are dropped
 *   (restoreEdits);
 * - unknown (the page gave up) and reloaded: the sent changes the reload already shows are
 *   dropped (stored, or matched by another device), so they can't come back later to undo
 *   another device's change (#238); the rest stay, under the changes made since (stackEdits).
 *   The reload can't tell a change never stored from one stored and then changed back by another
 *   device before the reload (or one stored by an attempt that commits after it), so those can
 *   still leave a stale edit;
 * - refused or unknown without a reload: every change is kept as it is (stackEdits).
 */
export function editsAfterSave(save: {
  outcome: SaveOutcome;
  reloaded: boolean;
  savedNow: ReadonlySet<number>;
  sent: ClaimEdits;
  since: ClaimEdits | undefined;
}): Map<number, boolean> {
  if (save.outcome === 'saved') return new Map(save.since);
  if (!save.reloaded) return stackEdits(save.sent, save.since);
  if (save.outcome === 'refused') return restoreEdits(save.savedNow, save.sent, save.since);
  const notShown = [...save.sent].filter(([item, claimed]) => claimed !== save.savedNow.has(item));
  return stackEdits(new Map(notShown), save.since);
}
