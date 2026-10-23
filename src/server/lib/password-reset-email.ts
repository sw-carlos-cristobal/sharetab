/**
 * The password emails (#397): the reset link, and the notice that a password was changed, in the
 * account's language. Their text lives in messages/{locale}/emails.json, a server-only namespace
 * like errors.json.
 */

import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import type { Locale } from '@/i18n/routing';
import en from '../../../messages/en/emails.json';
import es from '../../../messages/es/emails.json';
import sv from '../../../messages/sv/emails.json';
import fr from '../../../messages/fr/emails.json';
import de from '../../../messages/de/emails.json';
import ptBR from '../../../messages/pt-BR/emails.json';
import ja from '../../../messages/ja/emails.json';
import zhCN from '../../../messages/zh-CN/emails.json';
import ko from '../../../messages/ko/emails.json';

const catalogs: Record<Locale, AbstractIntlMessages> = {
  en,
  es,
  sv,
  fr,
  de,
  'pt-BR': ptBR,
  ja,
  'zh-CN': zhCN,
  ko,
};

type Emails = typeof en;

/** One email's strings in a language, with `{email}` filled in */
function emailText<N extends keyof Emails>(locale: Locale, namespace: N, email: string) {
  // Typed loosely: the keys are checked by keyof Emails[N], and the catalogs aren't the app's Messages
  const translate = createTranslator({ locale, messages: catalogs[locale], namespace }) as unknown as (
    key: keyof Emails[N],
    values?: Record<string, string>,
  ) => string;
  return (key: keyof Emails[N]) => translate(key, { email });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The shared layout: a heading, paragraphs, a button, and smaller notes */
function emailHtml(heading: string, paragraphs: string[], button: { label: string; url: string }, notes: string[]) {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #10b981;">${escapeHtml(heading)}</h2>
      ${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n      ')}
      <p>
        <a href="${escapeHtml(button.url)}" style="display: inline-block; padding: 8px 16px; background: #10b981; color: white; text-decoration: none; border-radius: 6px;">
          ${escapeHtml(button.label)}
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">${notes.map(escapeHtml).join('<br/>')}</p>
    </div>
  `;
}

export function passwordResetEmail(locale: Locale, { email, url }: { email: string; url: string }) {
  const t = emailText(locale, 'passwordReset', email);
  const text = [t('intro'), '', `${t('action')}: ${url}`, '', t('expiry'), t('ignore')].join('\n');
  const html = emailHtml(t('heading'), [t('intro')], { label: t('action'), url }, [t('expiry'), t('ignore')]);
  return { subject: t('subject'), text, html };
}
