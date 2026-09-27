/**
 * The claim page keeps unsaved claim edits by person id, since a person's index changes when
 * someone listed before them is removed. The session it polls lists claims by index, so this
 * puts each draft at its person's index in the people list the page has now, and drops the
 * drafts of people who are no longer in it.
 */
export function draftsByIndex(
  drafts: ReadonlyMap<string, Set<number>>,
  people: readonly { id: string }[],
): Map<number, Set<number>> {
  const byIndex = new Map<number, Set<number>>();
  people.forEach((person, index) => {
    const draft = drafts.get(person.id);
    if (draft) byIndex.set(index, draft);
  });
  return byIndex;
}

/** Whether two sets of claimed item indexes hold the same items */
export function sameClaims(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
