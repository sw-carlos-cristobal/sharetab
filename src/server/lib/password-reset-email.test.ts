import { describe, expect, test } from 'vitest';
import { locales } from '@/i18n/routing';
import { passwordChangedEmail, passwordResetEmail } from './password-reset-email';

const URL = 'https://sharetab.example.com/en/reset-password#token=abc';
const RESET_URL = 'https://sharetab.example.com/en/forgot-password';

describe('passwordResetEmail', () => {
  test('carries the link and the account in plain text and HTML', () => {
    const mail = passwordResetEmail('en', { email: 'bob@example.com', url: URL });
    expect(mail.subject).toBe('Reset your ShareTab password');
    expect(mail.text).toContain(URL);
    expect(mail.text).toContain('bob@example.com');
    expect(mail.text).toContain('expires in 1 hour');
    expect(mail.html).toContain(`href="${URL}"`);
    expect(mail.html).toContain('bob@example.com');
  });

  test.each(locales)('renders completely in %s', (locale) => {
    const mail = passwordResetEmail(locale, { email: 'bob@example.com', url: URL });
    for (const part of [mail.subject, mail.text, mail.html]) {
      // A missing key renders as its path
      expect(part).not.toContain('passwordReset.');
    }
    expect(mail.text).toContain('bob@example.com');
    expect(mail.text).toContain(URL);
  });

  test('escapes what it puts into the HTML', () => {
    const mail = passwordResetEmail('en', { email: '"<b>"@example.com', url: 'https://x.example/?a=1&b="2"' });
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).toContain('&quot;&lt;b&gt;&quot;@example.com');
    expect(mail.html).toContain('href="https://x.example/?a=1&amp;b=&quot;2&quot;"');
  });
});

describe('passwordChangedEmail', () => {
  test('names the account and links to a reset', () => {
    const mail = passwordChangedEmail('en', { email: 'bob@example.com', resetUrl: RESET_URL });
    expect(mail.subject).toBe('Your ShareTab password was changed');
    expect(mail.text).toContain('bob@example.com');
    expect(mail.text).toContain(RESET_URL);
    expect(mail.html).toContain(`href="${RESET_URL}"`);
  });

  test.each(locales)('renders completely in %s', (locale) => {
    const mail = passwordChangedEmail(locale, { email: 'bob@example.com', resetUrl: RESET_URL });
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).not.toContain('passwordChanged.');
    }
    expect(mail.text).toContain('bob@example.com');
  });
});
