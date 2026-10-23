import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  isArgumentElement,
  isLiteralElement,
  isNumberElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  parse,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser';

// #441: a count written before a noun ("{count} items") shows "1 items"; a plural picks the form

// `count`, or a name ending in `Count` (`itemCount`)
const COUNT_NAME = /^(?:count|\w*Count)$/;
const FOLLOWED_BY_WORD = /^\s+\p{L}/u;

// Tags (<b>…</b>) don't separate a count from the word after it
function withoutTags(elements: MessageFormatElement[]): MessageFormatElement[] {
  return elements.flatMap((element) => (isTagElement(element) ? withoutTags(element.children) : [element]));
}

function textAfter(elements: MessageFormatElement[], index: number): string {
  let text = '';
  for (const element of elements.slice(index + 1)) {
    if (!isLiteralElement(element)) break;
    text += element.value;
  }
  return text;
}

function collect(elements: MessageFormatElement[], pluralized: ReadonlySet<string>, found: string[]): void {
  const flat = withoutTags(elements);
  flat.forEach((element, index) => {
    if (
      (isArgumentElement(element) || isNumberElement(element)) &&
      COUNT_NAME.test(element.value) &&
      !pluralized.has(element.value) &&
      FOLLOWED_BY_WORD.test(textAfter(flat, index))
    ) {
      found.push(element.value);
    } else if (isPluralElement(element)) {
      // A plural's branches already depend on its own argument (cardinal or ordinal)
      const inside = new Set([...pluralized, element.value]);
      for (const option of Object.values(element.options)) collect(option.value, inside, found);
    } else if (isSelectElement(element)) {
      for (const option of Object.values(element.options)) collect(option.value, pluralized, found);
    }
  });
}

/**
 * The count arguments in an ICU message that a word follows outside a plural on that argument,
 * in order. Parses the message as next-intl does, so it throws on one that isn't valid ICU.
 */
export function findUnpluralizedCounts(message: string): string[] {
  const found: string[] = [];
  collect(parse(message), new Set(), found);
  return found;
}

/** Whether a language has more than one plural form (Japanese, Chinese and Korean have one). */
export function hasPluralForms(locale: string): boolean {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories.length > 1;
}

/**
 * What lint:i18n reports for one message: that it isn't valid ICU (next-intl would show its key
 * instead), or each count a word follows outside a plural, in a language with plural forms.
 */
export function messageProblems(locale: string, message: string): string[] {
  let counts: string[];
  try {
    counts = findUnpluralizedCounts(message);
  } catch (error) {
    return [`isn't valid ICU: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (!hasPluralForms(locale)) return [];
  return counts.map(
    (name) => `{${name}} is followed by a word outside a plural; use {${name}, plural, one {# …} other {# …}}`,
  );
}

/** A namespace's messages as [dotted key, value] pairs. */
export function messageEntries(obj: Record<string, unknown>, prefix = ''): [string, unknown][] {
  return Object.entries(obj).flatMap(([key, value]): [string, unknown][] => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? messageEntries(value as Record<string, unknown>, fullKey)
      : [[fullKey, value]];
  });
}

/** `messageProblems` for every message in every locale under `messagesDir`, as "[locale/namespace] key: problem". */
export function findMessageProblems(messagesDir: string): string[] {
  const problems: string[] = [];
  for (const locale of readdirSync(messagesDir)) {
    const localeDir = join(messagesDir, locale);
    if (!statSync(localeDir).isDirectory()) continue;
    for (const file of readdirSync(localeDir).filter((f) => f.endsWith('.json'))) {
      const messages = JSON.parse(readFileSync(join(localeDir, file), 'utf-8')) as Record<string, unknown>;
      for (const [key, value] of messageEntries(messages)) {
        if (typeof value !== 'string') continue;
        for (const problem of messageProblems(locale, value)) {
          problems.push(`[${locale}/${file.replace('.json', '')}] ${key}: ${problem}`);
        }
      }
    }
  }
  return problems;
}
