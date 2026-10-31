import { describe, expect, it } from 'vitest';
import { MAX_GROUP_SIZE, MIN_GROUP_SIZE, parseGroupSize } from './group-size';

describe('parseGroupSize', () => {
  it('reads a whole number from 1 to 20', () => {
    expect(parseGroupSize('1')).toBe(1);
    expect(parseGroupSize('2')).toBe(2);
    expect(parseGroupSize('20')).toBe(20);
  });

  it('allows spaces around the number and leading zeros', () => {
    expect(parseGroupSize(' 3 ')).toBe(3);
    expect(parseGroupSize('02')).toBe(2);
  });

  // #410: the field may be empty while someone types; that's not a group size of 1
  it('refuses an empty field', () => {
    expect(parseGroupSize('')).toBeNull();
    expect(parseGroupSize('   ')).toBeNull();
  });

  // Refused rather than clamped, so a typo isn't quietly turned into another size
  it('refuses a number outside 1 to 20', () => {
    expect(parseGroupSize('0')).toBeNull();
    expect(parseGroupSize('21')).toBeNull();
    expect(parseGroupSize('-2')).toBeNull();
    expect(parseGroupSize('99999999999999999999')).toBeNull();
  });

  it('refuses anything but a whole number', () => {
    expect(parseGroupSize('1.5')).toBeNull();
    expect(parseGroupSize('2.0')).toBeNull();
    expect(parseGroupSize('1e1')).toBeNull();
    expect(parseGroupSize('+2')).toBeNull();
    expect(parseGroupSize('2a')).toBeNull();
    expect(parseGroupSize('0x2')).toBeNull();
  });

  it('accepts the ends of the range and nothing past them', () => {
    expect(parseGroupSize(String(MIN_GROUP_SIZE))).toBe(MIN_GROUP_SIZE);
    expect(parseGroupSize(String(MAX_GROUP_SIZE))).toBe(MAX_GROUP_SIZE);
    expect(parseGroupSize(String(MIN_GROUP_SIZE - 1))).toBeNull();
    expect(parseGroupSize(String(MAX_GROUP_SIZE + 1))).toBeNull();
  });
});
