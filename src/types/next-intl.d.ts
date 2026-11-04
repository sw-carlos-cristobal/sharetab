// Types t() keys against the English messages, so `tsc --noEmit` fails on a key that
// doesn't exist (lint:i18n only compares the other locales with en). A new namespace
// needs an entry here as well as in src/i18n/request.ts.
import type admin from '../../messages/en/admin.json';
import type auth from '../../messages/en/auth.json';
import type common from '../../messages/en/common.json';
import type dashboard from '../../messages/en/dashboard.json';
import type expenses from '../../messages/en/expenses.json';
import type groups from '../../messages/en/groups.json';
import type settings from '../../messages/en/settings.json';
import type split from '../../messages/en/split.json';
import type splits from '../../messages/en/splits.json';

declare module 'next-intl' {
  interface AppConfig {
    Messages: {
      admin: typeof admin;
      auth: typeof auth;
      common: typeof common;
      dashboard: typeof dashboard;
      expenses: typeof expenses;
      groups: typeof groups;
      settings: typeof settings;
      split: typeof split;
      splits: typeof splits;
    };
  }
}
