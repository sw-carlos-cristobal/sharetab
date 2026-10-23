import { readFileSync } from 'fs';
import { join } from 'path';
import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { hasPluralForms } from '../../scripts/lib/message-check';
import { routing, type Locale } from './routing';

type Values = Record<string, string | number>;

function load(locale: Locale, namespace: string): AbstractIntlMessages {
  const path = join(import.meta.dirname, '../../messages', locale, `${namespace}.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as AbstractIntlMessages;
}

function create(locale: Locale, namespace: string) {
  return createTranslator({
    locale,
    messages: { [namespace]: load(locale, namespace) },
    namespace,
    onError: (error) => {
      throw error;
    },
  });
}

function translator(locale: Locale, namespace: string): (key: string, values?: Values) => string {
  return create(locale, namespace) as unknown as (key: string, values?: Values) => string;
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

const pluralLocales = routing.locales.filter(hasPluralForms);

describe('count messages', () => {
  it.each(routing.locales)('render in %s for none, one and several', (locale) => {
    for (const [namespace, key, values] of COUNT_MESSAGES) {
      const t = translator(locale, namespace);
      for (const n of [0, 1, 2, 5]) {
        expect(t(key, values(n)), `${namespace}.${key} with ${n}`).toContain(String(n));
      }
    }
  });

  // The snapshot shows each message for 1 and for 2, so a review sees every singular
  it.each(pluralLocales)('read as they should for one and for two in %s', (locale) => {
    const rendered = Object.fromEntries(
      COUNT_MESSAGES.map(([namespace, key, values]) => {
        const t = translator(locale, namespace);
        return [`${namespace}.${key}`, [t(key, values(1)), t(key, values(2))]];
      }),
    );
    expect(rendered).toMatchSnapshot();
  });

  it('use the singular for one in English', () => {
    expect(translator('en', 'splits')('items', { count: 1 })).toBe('1 item');
    expect(translator('en', 'admin')('users.count', { count: 1 })).toBe('1 user');
    expect(translator('en', 'admin')('groups.count', { count: 1 })).toBe('1 group');
    expect(translator('en', 'split')('claim.claimConflict', { count: 1, names: 'Ana' })).toBe(
      '1 item also claimed by Ana',
    );
  });

  it.each(pluralLocales)('group the digits of a large count in %s', (locale) => {
    expect(translator(locale, 'admin')('serverLogs.entries', { count: 1234 })).toContain(
      new Intl.NumberFormat(locale).format(1234),
    );
  });
});

describe('admin.meridianAuth.step2Instruction', () => {
  it('keeps the apostrophe before the emphasized URL in French', () => {
    const t = create('fr', 'admin') as unknown as {
      markup: (key: string, values: Record<string, (chunks: string) => string>) => string;
    };
    expect(t.markup('meridianAuth.step2Instruction', { emphasis: (chunks) => `<em>${chunks}</em>` })).toBe(
      "Après avoir autorisé, copiez l'<em>URL de la barre d'adresse de votre navigateur</em> et collez-la ci-dessous.",
    );
  });
});
