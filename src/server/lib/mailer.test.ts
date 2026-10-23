import { afterEach, describe, expect, test, vi } from 'vitest';
import { mailFrom, publicBaseUrl, smtpOptions } from './mailer';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('smtpOptions', () => {
  test('uses STARTTLS on 587 by default and TLS on 465', () => {
    vi.stubEnv('EMAIL_SERVER_HOST', 'smtp.example.com');
    vi.stubEnv('EMAIL_SERVER_PORT', undefined);
    expect(smtpOptions()).toMatchObject({ host: 'smtp.example.com', port: 587, secure: false });
    vi.stubEnv('EMAIL_SERVER_PORT', '465');
    expect(smtpOptions()).toMatchObject({ port: 465, secure: true });
  });

  test('leaves out credentials that are not set', () => {
    vi.stubEnv('EMAIL_SERVER_USER', undefined);
    vi.stubEnv('EMAIL_SERVER_PASSWORD', undefined);
    expect(smtpOptions().auth).toEqual({});
    vi.stubEnv('EMAIL_SERVER_USER', 'mailer');
    vi.stubEnv('EMAIL_SERVER_PASSWORD', 'secret');
    expect(smtpOptions().auth).toEqual({ user: 'mailer', pass: 'secret' });
  });
});

describe('mailFrom', () => {
  test('defaults to a ShareTab sender', () => {
    vi.stubEnv('EMAIL_FROM', undefined);
    expect(mailFrom()).toBe('ShareTab <noreply@sharetab.local>');
    vi.stubEnv('EMAIL_FROM', 'Tabs <tabs@example.com>');
    expect(mailFrom()).toBe('Tabs <tabs@example.com>');
  });
});

describe('publicBaseUrl', () => {
  test('takes AUTH_URL, then NEXTAUTH_URL, without a trailing slash', () => {
    vi.stubEnv('AUTH_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'https://tabs.example.com/');
    expect(publicBaseUrl()).toBe('https://tabs.example.com');
    vi.stubEnv('AUTH_URL', 'https://auth.example.com');
    expect(publicBaseUrl()).toBe('https://auth.example.com');
  });

  test('falls back to the documented default', () => {
    vi.stubEnv('AUTH_URL', '');
    vi.stubEnv('NEXTAUTH_URL', '');
    expect(publicBaseUrl()).toBe('http://localhost:3000');
  });
});
