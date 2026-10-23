import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(() => findUnpluralizedCounts('{count, plural, one {# item}')).toThrow();
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

  it('reports a message that does not parse, with where, in every language', () => {
    // The apostrophe before the tag starts quoted text that "d'" ends, so the closing tag has no opening one
    const message = "copiez l'<emphasis>URL de la barre d'adresse</emphasis>";
    expect(messageProblems('fr', message)).toEqual([expect.stringMatching(/^isn't valid ICU: \w+ at character \d+$/)]);
    expect(messageProblems('ja', '{count, plural, one {# item}')).toEqual([
      expect.stringMatching(/^isn't valid ICU: \w+ at character \d+$/),
    ]);
  });

  it('reports a plural without a form for one, where the language has one', () => {
    const problem = "the plural on {count} has no 'one' form, so 1 reads like 2; add one {…}";
    expect(messageProblems('en', '{count, plural, other {# items}}')).toEqual([problem]);
    expect(messageProblems('de', 'Mit {count, plural, other {# Personen}} teilen')).toEqual([problem]);
  });

  it('wants one rather than =1, which in French and Portuguese leaves 0 in the plural', () => {
    expect(messageProblems('fr', '{count, plural, =1 {# article} other {# articles}}')).toEqual([
      "the plural on {count} has no 'one' form, so 1 reads like 2; add one {…}",
    ]);
  });

  it('finds a plural without one inside a tag, a select or another plural', () => {
    const problem = (name: string) => `the plural on {${name}} has no 'one' form, so 1 reads like 2; add one {…}`;
    expect(messageProblems('en', '<b>{count, plural, other {# items}}</b>')).toEqual([problem('count')]);
    expect(messageProblems('en', '{kind, select, a {{count, plural, other {# items}}} other {x}}')).toEqual([
      problem('count'),
    ]);
    expect(
      messageProblems('en', '{n, plural, one {{count, plural, other {# items}}} other {{count, plural, other {#}}}}'),
    ).toEqual([problem('count'), problem('count')]);
  });

  it('accepts an ordinal, and a plural in a language with one form', () => {
    expect(messageProblems('en', '{count, selectordinal, other {#th}} place')).toEqual([]);
    expect(messageProblems('ja', '{count, plural, other {#件}}')).toEqual([]);
  });

  it('reports nothing for a valid message', () => {
    expect(messageProblems('en', '{count, plural, one {# item} other {# items}}')).toEqual([]);
  });
});

describe('findMessageProblems', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function writeTree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'messages-'));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  it('labels each problem with its locale, namespace and key', () => {
    const root = writeTree({
      'en/splits.json': JSON.stringify({ items: '{count} items', ok: '{n}', nested: { people: '{count} people' } }),
      'fr/splits.json': JSON.stringify({ items: '{count, plural, other {# articles}}' }),
      'ja/splits.json': JSON.stringify({ items: '{count} 件' }),
    });
    expect(findMessageProblems(root)).toEqual([
      '[en/splits] items: {count} is followed by a word outside a plural; use {count, plural, one {# …} other {# …}}',
      '[en/splits] nested.people: {count} is followed by a word outside a plural; use {count, plural, one {# …} other {# …}}',
      "[fr/splits] items: the plural on {count} has no 'one' form, so 1 reads like 2; add one {…}",
    ]);
  });

  it('skips values that are not messages and files that are not JSON', () => {
    const root = writeTree({
      'README.md': '{count} items',
      'en/notes.txt': '{count} items',
      'en/splits.json': JSON.stringify({ size: 3, list: ['{count} items'], none: null }),
    });
    expect(findMessageProblems(root)).toEqual([]);
  });

  it('reports a folder that is not a language, and a file that is not a JSON object', () => {
    const root = writeTree({
      'backup/splits.json': '{}',
      'pt_BR/splits.json': '{}',
      'en/splits.json': '{ "items": ',
      'en/common.json': 'null',
    });
    const problems = findMessageProblems(root);
    expect(problems).toEqual([
      "[backup] isn't a language this runtime supports",
      "[en/common] isn't a JSON object",
      expect.stringMatching(/^\[en\/splits\] isn't valid JSON: /),
      "[pt_BR] isn't a language this runtime supports",
    ]);
  });

  it("finds none in the app's messages", () => {
    expect(findMessageProblems(join(import.meta.dirname, '../../messages'))).toEqual([]);
  });
});
