// #441: a count written before a noun ("{count} items") shows "1 items"; a plural picks the form

// `count`, or a name ending in `Count` (`itemCount`), optionally formatted as a number
const SIMPLE_COUNT = /^\{\s*(count|\w*Count)\s*(?:,\s*number\b[^{}]*)?\}/;
const PLURAL_START = /^\{\s*\w+\s*,\s*(?:plural|selectordinal)\s*,/;
const FOLLOWED_BY_WORD = /^\s+\p{L}/u;

/**
 * The count arguments in an ICU message that a word follows outside a plural, in order.
 * Text inside a plural's branches is skipped: the branch already depends on the count.
 */
export function findUnpluralizedCounts(message: string): string[] {
  const found: string[] = [];
  // One entry per open brace: whether it opened a plural
  const open: boolean[] = [];
  let i = 0;
  while (i < message.length) {
    const char = message[i];
    if (char === '{') {
      const rest = message.slice(i);
      const count = SIMPLE_COUNT.exec(rest);
      if (count) {
        const after = message.slice(i + count[0].length);
        if (!open.includes(true) && FOLLOWED_BY_WORD.test(after)) found.push(count[1]!);
        i += count[0].length;
        continue;
      }
      open.push(PLURAL_START.test(rest));
    } else if (char === '}') {
      open.pop();
    }
    i++;
  }
  return found;
}

/** Whether a language has more than one plural form (Japanese, Chinese and Korean have one). */
export function hasPluralForms(locale: string): boolean {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories.length > 1;
}
