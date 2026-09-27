import { describe, expect, test } from 'vitest';
import { assignPersonIds, findTargetIndex, hasPersonIds } from './guest-people';

const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const ID_C = 'aaaaaaaa-0000-4000-8000-000000000003';

describe('hasPersonIds', () => {
  test('is true when every person has an id', () => {
    expect(
      hasPersonIds([
        { id: ID_A, name: 'A' },
        { id: ID_B, name: 'B' },
      ]),
    ).toBe(true);
  });

  test('is false when anyone was saved before person ids existed', () => {
    expect(hasPersonIds([{ id: ID_A, name: 'A' }, { name: 'B' }])).toBe(false);
  });

  test('treats an empty id as missing', () => {
    expect(hasPersonIds([{ id: '', name: 'A' }])).toBe(false);
  });

  test("treats an id that isn't a UUID as missing (requests can only name people by UUID)", () => {
    expect(hasPersonIds([{ id: 'not-a-uuid', name: 'A' }])).toBe(false);
  });
});

describe('assignPersonIds', () => {
  test('gives each person without an id a new one and keeps existing ids', () => {
    let n = 0;
    const ids = [ID_B, ID_C];
    const people = assignPersonIds(
      [{ id: ID_A, name: 'A', personToken: 't' }, { name: 'B', groupSize: 2 }, { name: 'C' }],
      () => ids[n++]!,
    );
    expect(people).toEqual([
      { id: ID_A, name: 'A', personToken: 't' },
      { id: ID_B, name: 'B', groupSize: 2 },
      { id: ID_C, name: 'C' },
    ]);
  });

  test("replaces an id that isn't a UUID", () => {
    expect(assignPersonIds([{ id: 'not-a-uuid', name: 'A' }], () => ID_A)).toEqual([{ id: ID_A, name: 'A' }]);
  });

  test('mints distinct random UUIDs by default', () => {
    const people = assignPersonIds([{ name: 'A' }, { name: 'B' }]);
    expect(people[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(people[0]!.id).not.toBe(people[1]!.id);
  });
});

describe('findTargetIndex', () => {
  // B was removed: C moved down one place
  const people = [
    { id: ID_A, name: 'A' },
    { id: ID_C, name: 'C' },
  ];

  test('finds a person by id wherever they are now', () => {
    expect(findTargetIndex(people, { id: ID_C })).toBe(1);
  });

  test('is -1 for an id nobody has (the person was removed)', () => {
    expect(findTargetIndex(people, { id: ID_B })).toBe(-1);
  });

  test('takes an index as is when it is in range', () => {
    expect(findTargetIndex(people, { index: 1 })).toBe(1);
  });

  test('is -1 for an index past the end', () => {
    expect(findTargetIndex(people, { index: 2 })).toBe(-1);
  });

  test('never matches a person without an id', () => {
    const noIds: { id?: string; name: string }[] = [{ name: 'A' }];
    expect(findTargetIndex(noIds, { id: ID_A })).toBe(-1);
  });
});
