/**
 * The password reset email (#397), in the account's language. Its text lives in
 * messages/{locale}/emails.json, a server-only namespace like errors.json.
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

type PasswordResetKey = keyof typeof en.passwordReset;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function passwordResetEmail(locale: Locale, { email, url }: { email: string; url: string }) {
  // Typed loosely: the keys are checked by PasswordResetKey, and the catalogs aren't the app's Messages
  const translate = createTranslator({ locale, messages: catalogs[locale], namespace: 'passwordReset' }) as unknown as (
    key: PasswordResetKey,
    values?: Record<string, string>,
  ) => string;
  const t = (key: PasswordResetKey) => translate(key, { email });

  const text = [t('intro'), '', `${t('action')}: ${url}`, '', t('expiry'), t('ignore')].join('\n');
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #10b981;">${escapeHtml(t('heading'))}</h2>
      <p>${escapeHtml(t('intro'))}</p>
      <p>
        <a href="${escapeHtml(url)}" style="display: inline-block; padding: 8px 16px; background: #10b981; color: white; text-decoration: none; border-radius: 6px;">
          ${escapeHtml(t('action'))}
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">${escapeHtml(t('expiry'))}<br/>${escapeHtml(t('ignore'))}</p>
    </div>
  `;
  return { subject: t('subject'), text, html };
}
