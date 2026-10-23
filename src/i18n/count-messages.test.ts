import { readFileSync } from 'fs';
import { join } from 'path';
import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { routing, type Locale } from './routing';

type Values = Record<string, string | number>;

function translator(locale: Locale, namespace: string): (key: string, values?: Values) => string {
  const path = join(process.cwd(), 'messages', locale, `${namespace}.json`);
  const messages = { [namespace]: JSON.parse(readFileSync(path, 'utf-8')) as AbstractIntlMessages };
  const t = createTranslator({
    locale,
    messages,
    namespace,
    onError: (error) => {
      throw error;
    },
  }) as unknown as (key: string, values?: Values) => string;
  return t;
}

// #441: messages that show a count, with the values the pages pass them
const COUNT_MESSAGES: [namespace: string, key: string, values: (n: number) => Values][] = [
  ['splits', 'people', (n) => ({ count: n })],
  ['splits', 'items', (n) => ({ count: n })],
  ['admin', 'users.count', (n) => ({ count: n })],
  ['admin', 'groups.count', (n) => ({ count: n })],
  ['admin', 'groups.expenses', (n) => ({ count: n })],
  ['admin', 'groups.settlements', (n) => ({ count: n })],
  ['admin', 'storage.filesOnDisk', (n) => ({ count: n })],
  ['admin', 'storage.cleanedUp', (n) => ({ count: n, size: '3 KB' })],
  ['admin', 'storage.unusedCleanedUp', (n) => ({ count: n })],
  ['admin', 'tools.cleanupSuccess', (n) => ({ count: n })],
  ['admin', 'tools.cleanupStats', (n) => ({ expired: n, total: n })],
  ['admin', 'serverLogs.entries', (n) => ({ count: n })],
  ['admin', 'audit.filesDeleted', (n) => ({ count: n })],
  ['split', 'claim.claimConflict', (n) => ({ count: n, names: 'Ana' })],
  ['split', 'assign.assignAllItems', (n) => ({ remaining: n })],
  ['expenses', 'receipt.assignAllItems', (n) => ({ remaining: n })],
  ['groups', 'list.showAll', (n) => ({ count: n })],
];

describe('count messages', () => {
  it.each(routing.locales)('render in %s for one and for several', (locale) => {
    for (const [namespace, key, values] of COUNT_MESSAGES) {
      const t = translator(locale, namespace);
      for (const n of [0, 1, 2, 5]) {
        expect(t(key, values(n)), `${namespace}.${key} with ${n}`).toContain(String(n));
      }
    }
  });

  it('use the singular for one in English', () => {
    const splits = translator('en', 'splits');
    expect(splits('people', { count: 1 })).toBe('1 person');
    expect(splits('people', { count: 3 })).toBe('3 people');
    expect(splits('items', { count: 1 })).toBe('1 item');
    expect(splits('items', { count: 3 })).toBe('3 items');

    const admin = translator('en', 'admin');
    expect(admin('users.count', { count: 1 })).toBe('1 user');
    expect(admin('users.count', { count: 2 })).toBe('2 users');
    expect(admin('groups.count', { count: 1 })).toBe('1 group');
    expect(admin('groups.expenses', { count: 1 })).toBe('1 expense');
    expect(admin('groups.settlements', { count: 1 })).toBe('1 settlement');
    expect(admin('storage.filesOnDisk', { count: 1 })).toBe('1 file on disk');
    expect(admin('storage.cleanedUp', { count: 1, size: '3 KB' })).toBe('Cleaned up 1 file (3 KB freed)');
    expect(admin('storage.unusedCleanedUp', { count: 1 })).toBe('Deleted 1 receipt');
    expect(admin('tools.cleanupSuccess', { count: 1 })).toBe('Deleted 1 expired split');
    expect(admin('tools.cleanupStats', { expired: 1, total: 1 })).toBe('Expired guest splits: 1 of 1.');
    expect(admin('serverLogs.entries', { count: 1 })).toBe('1 entry');
    expect(admin('serverLogs.entries', { count: 2 })).toBe('2 entries');
    expect(admin('audit.filesDeleted', { count: 1 })).toBe('1 file');

    const split = translator('en', 'split');
    expect(split('claim.claimConflict', { count: 1, names: 'Ana' })).toBe('1 item also claimed by Ana');
    expect(split('claim.claimConflict', { count: 2, names: 'Ana' })).toBe('2 items also claimed by Ana');

    const groups = translator('en', 'groups');
    expect(groups('list.showAll', { count: 13 })).toBe('Show all 13 groups');
  });

  it('use the singular for one in French', () => {
    expect(translator('fr', 'splits')('items', { count: 1 })).toBe('1 article');
    expect(translator('fr', 'splits')('items', { count: 2 })).toBe('2 articles');
    expect(translator('fr', 'admin')('users.count', { count: 1 })).toBe('1 utilisateur');
    expect(translator('fr', 'split')('claim.claimConflict', { count: 1, names: 'Ana' })).toBe(
      '1 article également réclamé par Ana',
    );
    expect(translator('fr', 'split')('assign.assignAllItems', { remaining: 1 })).toBe(
      'Attribuer tous les articles (1 restant)',
    );
  });
});
