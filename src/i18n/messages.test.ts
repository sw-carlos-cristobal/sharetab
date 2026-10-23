import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  isPluralElement,
  isSelectElement,
  isTagElement,
  parse,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser';
import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { hasPluralForms, messageEntries } from '../../scripts/lib/message-check';
import { routing, type Locale } from './routing';

const messagesDir = join(import.meta.dirname, '../../messages');

type Values = Record<string, string | number | ((chunks: string) => string)>;

function load(locale: Locale, namespace: string): AbstractIntlMessages {
  return JSON.parse(readFileSync(join(messagesDir, locale, `${namespace}.json`), 'utf-8')) as AbstractIntlMessages;
}

// Renders with t.markup, so messages with tags (<b>) come out as plain text too
function translator(locale: Locale, namespace: string): (key: string, values?: Values) => string {
  const t = createTranslator({
    locale,
    messages: { [namespace]: load(locale, namespace) },
    namespace,
    onError: (error) => {
      throw error;
    },
  }) as unknown as { markup: (key: string, values?: Values) => string };
  return (key, values) => t.markup(key, values);
}

const tag = (chunks: string) => chunks;

// #441: messages that show a count, with the values the pages pass them (dashboard.members has no caller today)
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
  ['admin', 'tools.cleanupStats', (n) => ({ expired: n, total: n + 3 })],
  ['admin', 'serverLogs.entries', (n) => ({ count: n })],
  ['admin', 'audit.filesDeleted', (n) => ({ count: n })],
  ['split', 'claim.claimConflict', (n) => ({ count: n, names: 'Ana' })],
  ['split', 'assign.assignAllItems', (n) => ({ remaining: n })],
  ['expenses', 'receipt.assignAllItems', (n) => ({ remaining: n })],
  ['dashboard', 'members', (n) => ({ count: n })],
  ['dashboard', 'archivedGroups', (n) => ({ count: n })],
  ['groups', 'list.memberCount', (n) => ({ count: n })],
  ['groups', 'list.expenseCount', (n) => ({ count: n })],
  ['auth', 'invite.invitedBy', (n) => ({ inviter: 'Ana', group: 'Trip', count: n, name: tag, b: tag })],
  ['auth', 'invite.invited', (n) => ({ group: 'Trip', count: n, b: tag })],
];

// Plural messages left out of COUNT_MESSAGES, and why
const NOT_COUNT_MESSAGES: Record<string, string> = {
  'groups.list.showAll': 'only shown for more than 12 groups (GROUPS_PER_PAGE), so never for one',
};

const pluralLocales = routing.locales.filter(hasPluralForms);

function hasPlural(elements: MessageFormatElement[]): boolean {
  return elements.some(
    (element) =>
      isPluralElement(element) ||
      (isTagElement(element) && hasPlural(element.children)) ||
      (isSelectElement(element) && Object.values(element.options).some((option) => hasPlural(option.value))),
  );
}

describe('count messages', () => {
  it('include every English message with a plural', () => {
    const listed = new Set([...COUNT_MESSAGES.map(([ns, key]) => `${ns}.${key}`), ...Object.keys(NOT_COUNT_MESSAGES)]);
    const plurals = readdirSync(join(messagesDir, 'en'))
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => {
        const namespace = file.slice(0, -'.json'.length);
        return messageEntries(load('en', namespace) as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string' && hasPlural(parse(value)))
          .map(([key]) => `${namespace}.${key}`);
      });
    expect(plurals.filter((id) => !listed.has(id))).toEqual([]);
  });

  it.each(routing.locales)('render in %s for none, one and several', (locale) => {
    for (const [namespace, key, values] of COUNT_MESSAGES) {
      const t = translator(locale, namespace);
      for (const n of [0, 1, 2, 5]) {
        expect(t(key, values(n)), `${namespace}.${key} with ${n}`).toContain(String(n));
      }
    }
  });

  // The snapshot shows each message for 0, 1 and 2, so a review sees every singular (French and
  // Brazilian Portuguese use it for 0 too)
  it.each(pluralLocales)('read as they should for none, one and two in %s', (locale) => {
    const rendered = Object.fromEntries(
      COUNT_MESSAGES.map(([namespace, key, values]) => {
        const t = translator(locale, namespace);
        return [`${namespace}.${key}`, [0, 1, 2].map((n) => t(key, values(n)))];
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
    expect(translator('en', 'groups')('list.showAll', { count: 13 })).toBe('Show all 13 groups');
  });

  it.each(pluralLocales)('group the digits of a large count in %s', (locale) => {
    expect(translator(locale, 'admin')('serverLogs.entries', { count: 1234567 })).toContain(
      new Intl.NumberFormat(locale).format(1234567),
    );
  });

  it.each(pluralLocales)('show all of more than 12 groups in %s', (locale) => {
    expect(translator(locale, 'groups')('list.showAll', { count: 13 })).toContain('13');
  });
});

describe('admin.meridianAuth.step2Instruction', () => {
  it('keeps the apostrophe before the emphasized URL in French', () => {
    expect(
      translator('fr', 'admin')('meridianAuth.step2Instruction', { emphasis: (chunks) => `<em>${chunks}</em>` }),
    ).toBe(
      "Après avoir autorisé, copiez l'<em>URL de la barre d'adresse de votre navigateur</em> et collez-la ci-dessous.",
    );
  });
});
