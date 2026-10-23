import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { findMessageProblems, messageEntries } from './lib/message-check';

const messagesDir = join(process.cwd(), 'messages');
const sourceLocale = 'en';

function getKeys(obj: Record<string, unknown>): string[] {
  return messageEntries(obj).map(([key]) => key);
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

// Messages next-intl can't parse, and (#441) counts outside a plural: "{count} items" reads "1 items"
for (const problem of findMessageProblems(messagesDir)) {
  hasErrors = true;
  console.error(problem);
}

if (hasErrors) {
  console.error('\nTranslation validation failed!');
  process.exit(1);
} else {
  console.log('All translations are in sync.');
}
