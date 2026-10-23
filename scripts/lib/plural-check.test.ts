import { describe, expect, it } from 'vitest';
import { findUnpluralizedCounts, hasPluralForms } from './plural-check';

describe('findUnpluralizedCounts', () => {
  it('flags a count followed by a word', () => {
    expect(findUnpluralizedCounts('{count} items')).toEqual(['count']);
    expect(findUnpluralizedCounts('Show all {count} groups')).toEqual(['count']);
    expect(findUnpluralizedCounts('Deleted {count} receipts')).toEqual(['count']);
  });

  it('flags an argument named like a count', () => {
    expect(findUnpluralizedCounts('{itemCount} items')).toEqual(['itemCount']);
  });

  it('flags a count formatted as a number', () => {
    expect(findUnpluralizedCounts('{count, number} items')).toEqual(['count']);
  });

  it('flags a count followed by a non-breaking space and a word', () => {
    expect(findUnpluralizedCounts('{count} fichiers')).toEqual(['count']);
  });

  it('flags a count followed by a word with an accent', () => {
    expect(findUnpluralizedCounts('{count} éléments')).toEqual(['count']);
  });

  it('flags a count inside a select, which picks no plural form', () => {
    expect(findUnpluralizedCounts('{kind, select, receipt {{count} receipts} other {{count} files}}')).toEqual([
      'count',
      'count',
    ]);
  });

  it('accepts a count in a plural', () => {
    expect(findUnpluralizedCounts('{count, plural, one {# item} other {# items}}')).toEqual([]);
    expect(findUnpluralizedCounts('Cleaned up {count, plural, one {# file} other {# files}} ({size} freed)')).toEqual(
      [],
    );
  });

  it('accepts a count repeated inside a plural branch', () => {
    expect(findUnpluralizedCounts('{count, plural, one {one item} other {{count} items}}')).toEqual([]);
  });

  it('accepts a count used as a selectordinal', () => {
    expect(findUnpluralizedCounts('{count, selectordinal, one {#st} other {#th}} place')).toEqual([]);
  });

  it('accepts a count not followed by a word', () => {
    expect(findUnpluralizedCounts('Items ({count})')).toEqual([]);
    expect(findUnpluralizedCounts('Total: {count}.')).toEqual([]);
    expect(findUnpluralizedCounts('{count}')).toEqual([]);
    expect(findUnpluralizedCounts('{count}件の支出')).toEqual([]);
  });

  it('ignores arguments that are not counts', () => {
    expect(findUnpluralizedCounts('{name} owes you')).toEqual([]);
    expect(findUnpluralizedCounts('{account} linked')).toEqual([]);
  });

  it('checks a count after a plural closes', () => {
    expect(findUnpluralizedCounts('{count, plural, one {# item} other {# items}}, {count} people')).toEqual(['count']);
  });
});

describe('hasPluralForms', () => {
  it('is true for languages whose nouns change with the count', () => {
    for (const locale of ['en', 'es', 'sv', 'fr', 'de', 'pt-BR']) {
      expect(hasPluralForms(locale)).toBe(true);
    }
  });

  it('is false for languages with one form for every count', () => {
    for (const locale of ['ja', 'zh-CN', 'ko']) {
      expect(hasPluralForms(locale)).toBe(false);
    }
  });
});
