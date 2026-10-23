import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { findMessageProblems, findUnpluralizedCounts, hasPluralForms, messageProblems } from './message-check';

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

  it('flags a count on either side of a rich-text tag', () => {
    expect(findUnpluralizedCounts('<b>{count}</b> users')).toEqual(['count']);
    expect(findUnpluralizedCounts('{count} <b>users</b>')).toEqual(['count']);
  });

  it('flags a count inside a select, which picks no plural form', () => {
    expect(findUnpluralizedCounts('{kind, select, receipt {{count} receipts} other {{count} files}}')).toEqual([
      'count',
      'count',
    ]);
  });

  it('flags a count inside a plural on another argument', () => {
    expect(findUnpluralizedCounts('{total, plural, one {{count} items of # total} other {{count} items}}')).toEqual([
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

  it('accepts a count repeated inside its own plural', () => {
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

  it('ignores a count quoted as literal text', () => {
    expect(findUnpluralizedCounts("'{count}' items")).toEqual([]);
  });

  it('ignores arguments that are not counts', () => {
    expect(findUnpluralizedCounts('{name} owes you')).toEqual([]);
    expect(findUnpluralizedCounts('{account} linked')).toEqual([]);
  });

  it('checks a count after a plural closes', () => {
    expect(findUnpluralizedCounts('{count, plural, one {# item} other {# items}}, {count} people')).toEqual(['count']);
  });

  it('throws on a message that is not valid ICU', () => {
    expect(() => findUnpluralizedCounts('{count, plural, one {# item}')).toThrow('MISSING_OTHER_CLAUSE');
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

describe('messageProblems', () => {
  it('reports a count outside a plural in a language with plural forms', () => {
    expect(messageProblems('fr', '{count} articles')).toEqual([
      '{count} is followed by a word outside a plural; use {count, plural, one {# …} other {# …}}',
    ]);
  });

  it('allows a count before a word in a language with one form', () => {
    expect(messageProblems('ko', '{count} 항목')).toEqual([]);
  });

  it('reports a message that does not parse, in every language', () => {
    // An apostrophe before a tag starts quoted text, so the closing tag has no opening one
    const message = "copiez l'<emphasis>URL de la barre d'adresse</emphasis>";
    expect(messageProblems('fr', message)).toEqual(["isn't valid ICU: UNMATCHED_CLOSING_TAG"]);
    expect(messageProblems('ja', '{count, plural, one {# item}')).toEqual(["isn't valid ICU: MISSING_OTHER_CLAUSE"]);
  });

  it('reports nothing for a valid message', () => {
    expect(messageProblems('en', '{count, plural, one {# item} other {# items}}')).toEqual([]);
  });
});

describe('findMessageProblems', () => {
  it("finds none in the app's messages", () => {
    expect(findMessageProblems(join(process.cwd(), 'messages'))).toEqual([]);
  });
});
