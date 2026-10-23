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

function unpluralizedCounts(elements: MessageFormatElement[]): string[] {
  const found: string[] = [];
  collect(elements, new Set(), found);
  return found;
}

/**
 * The count arguments in an ICU message that a word follows outside a plural on that argument,
 * in order. Parses the message with the parser next-intl's formatter uses, so it throws on one
 * that isn't valid ICU.
 */
export function findUnpluralizedCounts(message: string): string[] {
  return unpluralizedCounts(parse(message));
}

// The arguments of cardinal plurals with neither `one` nor `=1`, which show 1 in the `other` form
function pluralsWithoutOne(elements: MessageFormatElement[]): string[] {
  return withoutTags(elements).flatMap((element) => {
    if (!isPluralElement(element) && !isSelectElement(element)) return [];
    const inside = Object.values(element.options).flatMap((option) => pluralsWithoutOne(option.value));
    const missing =
      isPluralElement(element) &&
      element.pluralType === 'cardinal' &&
      !('one' in element.options) &&
      !('=1' in element.options);
    return missing ? [element.value, ...inside] : inside;
  });
}

function pluralCategories(locale: string): Intl.LDMLPluralRule[] {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
}

/** Whether a language has more than one plural form (Japanese, Chinese and Korean have one). */
export function hasPluralForms(locale: string): boolean {
  return pluralCategories(locale).length > 1;
}

// In ICU an apostrophe before one of these starts quoted text, shown as written; '' is an apostrophe
const QUOTING_APOSTROPHE = /(?<!')'(?=[{}<>#])/;

function describeParseError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const offset = (error as { location?: { start?: { offset?: number } } }).location?.start?.offset;
  return offset === undefined ? error.message : `${error.message} at character ${offset + 1}`;
}

/**
 * What lint:i18n reports for one message: that it isn't valid ICU (next-intl would show its key
 * instead); an apostrophe that starts quoted text; and, in a language with plural forms, each count
 * a word follows outside a plural, and each plural with no form for one.
 */
export function messageProblems(locale: string, message: string): string[] {
  let elements: MessageFormatElement[];
  try {
    elements = parse(message);
  } catch (error) {
    return [`isn't valid ICU: ${describeParseError(error)}`];
  }
  const problems: string[] = [];
  if (QUOTING_APOSTROPHE.test(message)) {
    problems.push("an apostrophe before {, }, <, > or # starts text that shows as written; write '' for an apostrophe");
  }
  const categories = pluralCategories(locale);
  if (categories.length > 1) {
    for (const name of unpluralizedCounts(elements)) {
      problems.push(`{${name}} is followed by a word outside a plural; use {${name}, plural, one {# …} other {# …}}`);
    }
  }
  if (categories.includes('one')) {
    for (const name of pluralsWithoutOne(elements)) {
      problems.push(`the plural on {${name}} has no 'one' form, so 1 reads like 2; add one {…}`);
    }
  }
  return problems;
}

function isLanguageTag(name: string): boolean {
  try {
    Intl.getCanonicalLocales(name);
    return true;
  } catch {
    return false;
  }
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

/**
 * `messageProblems` for every message in every locale folder under `messagesDir`, as
 * "[locale/namespace] key: problem", plus folders that aren't language tags and files that aren't JSON.
 */
export function findMessageProblems(messagesDir: string): string[] {
  const problems: string[] = [];
  for (const locale of readdirSync(messagesDir).sort()) {
    const localeDir = join(messagesDir, locale);
    if (!statSync(localeDir).isDirectory()) continue;
    if (!isLanguageTag(locale)) {
      problems.push(`[${locale}] isn't a language tag`);
      continue;
    }
    for (const file of readdirSync(localeDir)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      const label = `${locale}/${file.replace('.json', '')}`;
      let messages: Record<string, unknown>;
      try {
        messages = JSON.parse(readFileSync(join(localeDir, file), 'utf-8')) as Record<string, unknown>;
      } catch (error) {
        problems.push(`[${label}] isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const [key, value] of messageEntries(messages)) {
        if (typeof value !== 'string') continue;
        for (const problem of messageProblems(locale, value)) problems.push(`[${label}] ${key}: ${problem}`);
      }
    }
  }
  return problems;
}
