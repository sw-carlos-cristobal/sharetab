import { describe, test, expect } from 'vitest';
import { stripUndefined } from './strip-undefined';

describe('stripUndefined', () => {
  test('drops keys whose value is undefined', () => {
    const input = { a: 1, b: undefined, c: 'x' };
    expect(stripUndefined(input)).toEqual({ a: 1, c: 'x' });
  });

  test('keeps keys whose value is null', () => {
    const input = { a: null, b: undefined };
    expect(stripUndefined(input)).toEqual({ a: null });
  });

  test('keeps falsy-but-defined values (0, empty string, false)', () => {
    const input = { zero: 0, empty: '', flag: false, missing: undefined };
    expect(stripUndefined(input)).toEqual({ zero: 0, empty: '', flag: false });
  });

  test('returns an equivalent object when nothing is undefined', () => {
    const input = { a: 1, b: 'x' };
    expect(stripUndefined(input)).toEqual({ a: 1, b: 'x' });
  });

  test('returns an empty object when given an empty object', () => {
    expect(stripUndefined({})).toEqual({});
  });

  test('does not mutate the input object', () => {
    const input = { a: 1, b: undefined };
    stripUndefined(input);
    expect(input).toEqual({ a: 1, b: undefined });
  });
});
