import { afterEach, describe, expect, test, vi } from 'vitest';
import { describeMailError, mailFrom, publicBaseUrl, smtpOptions } from './mailer';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('smtpOptions', () => {
  test('connects plainly (upgraded by STARTTLS when the server offers it) except on 465, which is TLS', () => {
    vi.stubEnv('EMAIL_SERVER_HOST', 'smtp.example.com');
    vi.stubEnv('EMAIL_SERVER_PORT', undefined);
    expect(smtpOptions()).toMatchObject({ host: 'smtp.example.com', port: 587, secure: false });
    vi.stubEnv('EMAIL_SERVER_PORT', '465');
    expect(smtpOptions()).toMatchObject({ port: 465, secure: true });
    vi.stubEnv('EMAIL_SERVER_PORT', '2525');
    expect(smtpOptions()).toMatchObject({ port: 2525, secure: false });
  });

  test('leaves out credentials that are not set, also when set empty (as docker-compose does)', () => {
    vi.stubEnv('EMAIL_SERVER_USER', undefined);
    vi.stubEnv('EMAIL_SERVER_PASSWORD', undefined);
    expect(smtpOptions().auth).toStrictEqual({});
    // With either key nodemailer logs in when the server offers AUTH, and empty ones fail with EAUTH
    vi.stubEnv('EMAIL_SERVER_USER', '');
    vi.stubEnv('EMAIL_SERVER_PASSWORD', '');
    expect(smtpOptions().auth).toStrictEqual({});
    vi.stubEnv('EMAIL_SERVER_USER', 'mailer');
    vi.stubEnv('EMAIL_SERVER_PASSWORD', 'secret');
    expect(smtpOptions().auth).toEqual({ user: 'mailer', pass: 'secret' });
  });
});

describe('mailFrom', () => {
  test('defaults to a ShareTab sender, also when set empty (as docker-compose and the Unraid template do)', () => {
    vi.stubEnv('EMAIL_FROM', undefined);
    expect(mailFrom()).toBe('ShareTab <noreply@sharetab.local>');
    vi.stubEnv('EMAIL_FROM', '');
    expect(mailFrom()).toBe('ShareTab <noreply@sharetab.local>');
    vi.stubEnv('EMAIL_FROM', 'Tabs <tabs@example.com>');
    expect(mailFrom()).toBe('Tabs <tabs@example.com>');
  });
});

describe('describeMailError', () => {
  test("keeps nodemailer's code, SMTP response code and command, never the message", () => {
    const error = Object.assign(new Error('Invalid login: 535 for user@example.com'), {
      code: 'EAUTH',
      responseCode: 535,
      command: 'AUTH PLAIN',
      response: '535 5.7.8 user@example.com rejected',
    });
    expect(describeMailError(error)).toEqual({
      error: 'Error',
      code: 'EAUTH',
      responseCode: 535,
      command: 'AUTH PLAIN',
    });
  });

  test('leaves out fields that are missing or of the wrong type', () => {
    expect(describeMailError(Object.assign(new TypeError('x'), { code: 5 }))).toEqual({ error: 'TypeError' });
    expect(describeMailError('a string')).toEqual({ error: 'unknown' });
  });
});

describe('publicBaseUrl', () => {
  test('keeps only the origin of a URL with a path (Auth.js takes AUTH_URL=https://host/api/auth)', () => {
    vi.stubEnv('AUTH_URL', 'https://tabs.example.com/api/auth');
    expect(publicBaseUrl()).toBe('https://tabs.example.com');
  });

  test('returns a value that isn’t an http(s) URL as it is, for the reset email to refuse', () => {
    // new URL('sharetab.lan:3000').origin is the string "null"
    vi.stubEnv('AUTH_URL', 'sharetab.lan:3000');
    expect(publicBaseUrl()).toBe('sharetab.lan:3000');
    vi.stubEnv('AUTH_URL', 'not a url/');
    expect(publicBaseUrl()).toBe('not a url');
  });

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
