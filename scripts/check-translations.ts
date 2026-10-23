import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { findUnpluralizedCounts, hasPluralForms } from './lib/plural-check';

const messagesDir = join(process.cwd(), 'messages');
const sourceLocale = 'en';

function getKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...getKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function getEntries(obj: Record<string, unknown>, prefix = ''): [string, unknown][] {
  return Object.entries(obj).flatMap(([key, value]): [string, unknown][] => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? getEntries(value as Record<string, unknown>, fullKey)
      : [[fullKey, value]];
  });
}

function loadNamespace(locale: string, namespace: string): Record<string, unknown> {
  const filePath = join(messagesDir, locale, `${namespace}.json`);
  if (!existsSync(filePath)) return {};
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

const sourceDir = join(messagesDir, sourceLocale);
const namespaces = readdirSync(sourceDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''));

const locales = readdirSync(messagesDir).filter(
  (d) => d !== sourceLocale && statSync(join(messagesDir, d)).isDirectory(),
);

let hasErrors = false;

for (const locale of locales) {
  for (const namespace of namespaces) {
    const sourceKeys = getKeys(loadNamespace(sourceLocale, namespace));
    const targetKeys = getKeys(loadNamespace(locale, namespace));

    const missing = sourceKeys.filter((k) => !targetKeys.includes(k));
    const extra = targetKeys.filter((k) => !sourceKeys.includes(k));

    if (missing.length > 0) {
      hasErrors = true;
      console.error(`[${locale}/${namespace}] Missing ${missing.length} keys:`);
      missing.forEach((k) => console.error(`  - ${k}`));
    }

    if (extra.length > 0) {
      hasErrors = true;
      console.error(`[${locale}/${namespace}] Extra ${extra.length} keys:`);
      extra.forEach((k) => console.error(`  + ${k}`));
    }
  }

  for (const namespace of namespaces) {
    const filePath = join(messagesDir, locale, `${namespace}.json`);
    if (!existsSync(filePath)) {
      hasErrors = true;
      console.error(`[${locale}] Missing file: ${namespace}.json`);
    }
  }
}

// #441: "{count} items" reads "1 items"; a plural gives "1 item"
for (const locale of [sourceLocale, ...locales]) {
  if (!hasPluralForms(locale)) continue;
  for (const namespace of namespaces) {
    for (const [key, value] of getEntries(loadNamespace(locale, namespace))) {
      if (typeof value !== 'string') continue;
      for (const name of findUnpluralizedCounts(value)) {
        hasErrors = true;
        console.error(
          `[${locale}/${namespace}] ${key}: {${name}} is followed by a word outside a plural; use {${name}, plural, one {# …} other {# …}}`,
        );
      }
    }
  }
}

if (hasErrors) {
  console.error('\nTranslation validation failed!');
  process.exit(1);
} else {
  console.log('All translations are in sync.');
}
