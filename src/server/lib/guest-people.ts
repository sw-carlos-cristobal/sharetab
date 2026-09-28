import { randomUUID } from 'crypto';
import { z } from 'zod';

/** A person id as requests send it (personId / targetId), and as stored ids must be */
export const personIdSchema = z.string().uuid();

function isPersonId(id: unknown): id is string {
  return personIdSchema.safeParse(id).success;
}

/** A person in a guest claim session's `people` JSON. */
export type GuestSessionPerson = {
  // Identifies the person for as long as they are in the session. Their array index changes
  // when someone listed before them is removed, so the claim page targets people by id.
  // Public (getSession lists everyone's). People saved without one (claim sessions from before
  // ids existed, and quick splits from guest.createSplit) get one the first time getSession,
  // resumeSession or joinSession loads them (see assignPersonIds).
  id?: string;
  name: string;
  personToken?: string;
  groupSize?: number; // defaults to 1, > 1 means this person represents a group
  // The join that created (or first claimed) this person: its idempotency key and the normalized
  // name it was made with, replayable until expiresAt (epoch ms). See guest.joinSession.
  join?: { key: string; name: string; expiresAt: number };
};

export type IdentifiedGuestPerson = GuestSessionPerson & { id: string };

// An id that isn't a UUID counts as missing: no request could name that person
export function hasPersonIds(people: readonly GuestSessionPerson[]): people is IdentifiedGuestPerson[] {
  return people.every((p) => isPersonId(p.id));
}

/** The people with an id each: anyone without a valid one gets a new random id. */
export function assignPersonIds(
  people: readonly GuestSessionPerson[],
  newId: () => string = randomUUID,
): IdentifiedGuestPerson[] {
  return people.map((p) => (isPersonId(p.id) ? { ...p, id: p.id } : { ...p, id: newId() }));
}

/**
 * The index of the person a request targets, by their id, wherever that person is now (an index
 * could name whoever moved into that place after someone listed earlier was removed, #225).
 * -1 when nobody has the id, e.g. the person was removed.
 */
export function findTargetIndex(people: readonly { id?: string | undefined }[], id: string): number {
  return people.findIndex((p) => p.id === id);
}
