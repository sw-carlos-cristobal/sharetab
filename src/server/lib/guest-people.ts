import { randomUUID } from 'crypto';

/** A person in a guest claim session's `people` JSON. */
export type GuestSessionPerson = {
  // Identifies the person for as long as they are in the session. Their array index changes
  // when someone listed before them is removed, so the claim page targets people by id.
  // Public (getSession lists everyone's). People saved before ids existed have none until a
  // read gives them one (see assignPersonIds).
  id?: string;
  name: string;
  personToken?: string;
  groupSize?: number; // defaults to 1, > 1 means this person represents a group
  // The join that created (or first claimed) this person: its idempotency key and the normalized
  // name it was made with, replayable until expiresAt (epoch ms). See guest.joinSession.
  join?: { key: string; name: string; expiresAt: number };
};

export type IdentifiedGuestPerson = GuestSessionPerson & { id: string };

export function hasPersonIds(people: readonly GuestSessionPerson[]): people is IdentifiedGuestPerson[] {
  return people.every((p) => typeof p.id === 'string' && p.id.length > 0);
}

/** The people with an id each: anyone without one gets a new random id. */
export function assignPersonIds(
  people: readonly GuestSessionPerson[],
  newId: () => string = randomUUID,
): IdentifiedGuestPerson[] {
  return people.map((p) => (p.id ? { ...p, id: p.id } : { ...p, id: newId() }));
}

/**
 * The index of the person a request targets: by id, wherever that person is now, or by array
 * index (older clients). -1 when there is no such person, e.g. the id's person was removed.
 */
export function findTargetIndex(
  people: readonly GuestSessionPerson[],
  target: { index?: number | undefined; id?: string | undefined },
): number {
  if (target.id !== undefined) return people.findIndex((p) => !!p.id && p.id === target.id);
  if (target.index !== undefined && target.index < people.length) return target.index;
  return -1;
}
