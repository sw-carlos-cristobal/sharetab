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

3. **Register your locale** in `src/i18n/routing.ts`:
   ```ts
   export const locales = ["en", "es", "YOUR_LOCALE"] as const;

   export const languageConfig: Record<Locale, { flag: string; name: string }> = {
     en: { flag: "🇺🇸", name: "English" },
     es: { flag: "🇪🇸", name: "Español" },
     // Add yours:
     YOUR_LOCALE: { flag: "🇫🇷", name: "Français" },
   };
   ```

4. **Submit a PR.** The CI will validate that all keys match the English source.

## Updating Existing Translations

Edit the specific namespace file (e.g., `messages/es/groups.json`). Reference `messages/en/groups.json` as the source of truth for key names and structure.

## Rules

- **Keep ICU placeholders intact.** For example: `{name}`, `{count, plural, one {# member} other {# members}}`. These are variables — translate the surrounding text only.
- **Don't translate brand names.** "ShareTab" and "GitHub" stay as-is.
- **Use native script** for the language name in the switcher (e.g., "Français" not "French").
- **Match the tone** of the English source — ShareTab uses concise, friendly UI text.

## Testing Locally

```bash
npm run dev:full        # Start the app
# Navigate to /YOUR_LOCALE/login to see your translations
npm run lint:i18n       # Validate keys match English
```

## Validation

Run `npm run lint:i18n` to check that your locale has all the same keys as English. This also runs in CI on every PR that touches `messages/`.
