import { describe, it, expect } from 'vitest';
import { avatarColor, guestAvatarColor, getInitials, chipLabels } from './avatar';

describe('avatarColor', () => {
  it('returns a Tailwind bg class', () => {
    expect(avatarColor('user-123')).toMatch(/^bg-\w+-500$/);
  });

  it('returns the same color for the same userId', () => {
    expect(avatarColor('abc')).toBe(avatarColor('abc'));
  });

  it('returns different colors for different userIds', () => {
    const colors = new Set(['a', 'b', 'c', 'd', 'e'].map(avatarColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe('guestAvatarColor', () => {
  it('returns a guest color class', () => {
    expect(guestAvatarColor(0)).toContain('bg-');
    expect(guestAvatarColor(0)).toContain('text-');
  });

  it('wraps around at palette length', () => {
    expect(guestAvatarColor(0)).toBe(guestAvatarColor(8));
  });

  it('handles negative index', () => {
    expect(guestAvatarColor(-1)).toMatch(/^bg-/);
  });

  it('handles non-integer index', () => {
    expect(guestAvatarColor(1.7)).toMatch(/^bg-/);
  });
});

describe('getInitials', () => {
  it('returns first letters of name parts', () => {
    expect(getInitials('Alice Johnson')).toBe('AJ');
  });

  it('limits to 2 characters', () => {
    expect(getInitials('Alice Bob Charlie')).toBe('AB');
  });

  it('falls back to email initial', () => {
    expect(getInitials(null, 'alice@test.com')).toBe('A');
  });

  it('returns ? when no name or email', () => {
    expect(getInitials(null, null)).toBe('?');
  });

  it('handles single name', () => {
    expect(getInitials('Alice')).toBe('A');
  });

  it('uppercases', () => {
    expect(getInitials('alice johnson')).toBe('AJ');
  });
});

// #277: the receipt-assignment chips showed only the first word of each name,
// so "Bob" and "Bob Real" both read "Bob"
describe('chipLabels', () => {
  it('shows first names when they tell everyone apart', () => {
    expect(chipLabels(['Alice Johnson', 'Bob Smith', 'Charlie'])).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('shows the full name of everyone who shares a first name', () => {
    expect(chipLabels(['Alice Johnson', 'Bob', 'Bob Real'])).toEqual(['Alice', 'Bob', 'Bob Real']);
  });

  it('compares first names without case', () => {
    expect(chipLabels(['bob smith', 'Bob Real'])).toEqual(['bob smith', 'Bob Real']);
  });

  it('collapses runs of spaces and trims', () => {
    expect(chipLabels(['  Bob   Smith ', 'Bob Real', ' Ann  Lee'])).toEqual(['Bob Smith', 'Bob Real', 'Ann']);
  });

  it('shows ? for a missing or blank name, and blank names share nothing', () => {
    expect(chipLabels([null, undefined, '  ', 'Bob'])).toEqual(['?', '?', '?', 'Bob']);
  });

  it('keeps one label per person, in order', () => {
    const names = ['ET Two', 'ET', 'Dana'];
    expect(chipLabels(names)).toEqual(['ET Two', 'ET', 'Dana']);
  });
});
