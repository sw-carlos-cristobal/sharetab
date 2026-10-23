# Contributing Translations

Thank you for helping translate ShareTab! This guide explains how to add a new language or update existing translations.

## How i18n Works

ShareTab uses [next-intl](https://next-intl.dev) for internationalization. Translation files are JSON, organized by namespace:

```
messages/
  en/              # English (source language)
    common.json    # Navigation, buttons, shared labels
    auth.json      # Login, register pages
    dashboard.json # Dashboard
    groups.json    # Groups
    expenses.json  # Expenses
    settings.json  # Settings
    admin.json     # Admin panel
    split.json     # Guest bill splitting and claim sessions
    splits.json    # My Splits (a signed-in user's guest splits)
    errors.json    # Server error messages
  es/              # Spanish
    ...
```

## Adding a New Language

1. **Copy the English folder:**

   ```bash
   cp -r messages/en messages/YOUR_LOCALE
   ```

   Use a BCP 47 locale code (e.g., `fr`, `de`, `pt-BR`, `ja`, `zh-CN`).

2. **Translate all values** in each JSON file. Never change the keys — only the values.

3. **Register your locale** in `src/i18n/routing.ts` (add it to both `locales` and `languageConfig`), and add its number-formatting locale to `moneyLocales` in `src/lib/money.ts` (the type check fails until you do):

   ```ts
   export const locales = ['en', 'es', 'YOUR_LOCALE'] as const;

   export const languageConfig: Record<Locale, { flag: string; name: string }> = {
     en: { flag: '🇺🇸', name: 'English' },
     es: { flag: '🇪🇸', name: 'Español' },
     // Add yours:
     YOUR_LOCALE: { flag: '🇫🇷', name: 'Français' },
   };
   ```

4. **Run `npm run lint:i18n`** to confirm your locale has exactly the keys English has, its files are valid JSON and its messages valid ICU, and counts named `count` follow the plural rules below.

5. **Run `npx vitest run src/i18n`.** For a language with plural forms, it adds your language to `src/i18n/__snapshots__/messages.test.ts.snap`, showing the messages listed in the test's `COUNT_MESSAGES` for 0, 1 and 2. Check that the singulars read right, commit the file (CI fails without it), then **submit a PR.**

## Updating Existing Translations

Edit the specific namespace file (e.g., `messages/es/groups.json`). Reference `messages/en/groups.json` as the source of truth for key names and structure.

## Rules

- **Keep ICU placeholders intact.** For example: `{name}`, `{count, plural, one {# member} other {# members}}`. These are variables — translate the surrounding text only.
- **Put a count before a word only inside a plural.** `{count} items` reads "1 items"; write `{count, plural, one {# item} other {# items}}`, with your language's forms in the branches (keep both branches even when the word doesn't change, as in German `{count, plural, one {# Artikel} other {# Artikel}}`). Japanese, Chinese and Korean have one form, so `{count}件` is fine there. The lint catches this for arguments named `count` (or ending in `Count`); check other numbers, such as `{remaining}`, yourself. A plural needs a `one` branch in every language that has that form (`=1` doesn't replace it: French and Brazilian Portuguese use `one` for 0 too).
- **Double an apostrophe that comes right before `{`, `}`, `<` or `>`, or before `#` inside a plural.** In ICU an apostrophe there starts quoted text, shown as written (`l'{name}` shows "l{name}"), so write `l''<emphasis>` for "l'" followed by emphasized text. The lint only catches this when it leaves the message unparseable.
- **Don't translate brand names.** "ShareTab" and "GitHub" stay as-is.
- **Use native script** for the language name in the switcher (e.g., "Français" not "French").
- **Match the tone** of the English source — ShareTab uses concise, friendly UI text.

## Testing Locally

First complete the dev environment setup in [CONTRIBUTING.md](CONTRIBUTING.md#dev-environment-setup) (`npm install`, `npx prisma generate`, and `cp .env.example .env`). Then:

```bash
npm run lint:i18n       # Validate keys, JSON and ICU, and that counts named count use plurals
npx vitest run src/i18n # Check the messages that show a count (see Validation)
npm run dev:full        # Start the app (keeps running; stop it with Ctrl+C)
# Navigate to /YOUR_LOCALE/login to see your translations
```

## Validation

Run `npm run lint:i18n` to check that your locale has exactly the same keys as English (no missing or extra keys), that every file is valid JSON and every message valid ICU (the app would show a broken one as its key), and that counts named `count` follow the plural rules above (other numbers, such as `{remaining}`, are yours to check). CI runs it too, so run it before you open a PR.

`src/i18n/messages.test.ts` keeps a snapshot of the messages listed in its `COUNT_MESSAGES` (those with a plural, except any it gives a reason for, plus a few that show a count another way), for 0, 1 and 2, in every language with plural forms. If you change one of those messages, `npx vitest run src/i18n` fails until you update the snapshot with `npx vitest run src/i18n -u`; check that the singulars in the snapshot's diff read right.
