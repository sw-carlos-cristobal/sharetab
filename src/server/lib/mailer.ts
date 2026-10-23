/**
 * Outgoing email: the SMTP settings (`EMAIL_SERVER_*`, `EMAIL_FROM`) shared by the magic-link
 * provider, the admin test email and the auth-expiry alerts; the public URL
 * for links in the emails ShareTab builds; and what to log when a send fails.
 */

import nodemailer from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer';
import { logger } from './logger';

// Whether email is set up at all is `parseAuthConfig(...).magicLink` (EMAIL_SERVER_HOST set)
export function smtpOptions() {
  const port = parseInt(process.env.EMAIL_SERVER_PORT ?? '587');
  return {
    host: process.env.EMAIL_SERVER_HOST,
    port,
    secure: port === 465,
    // Empty counts as unset (docker-compose passes them empty): with either key, nodemailer logs in
    // whenever the server offers AUTH, and fails empty credentials as EAUTH "Missing credentials"
    auth: {
      ...(process.env.EMAIL_SERVER_USER ? { user: process.env.EMAIL_SERVER_USER } : {}),
      ...(process.env.EMAIL_SERVER_PASSWORD ? { pass: process.env.EMAIL_SERVER_PASSWORD } : {}),
    },
  } satisfies SMTPTransportOptions;
}

export function createMailTransport() {
  return nodemailer.createTransport(smtpOptions());
}

export function mailFrom(): string {
  // || not ??: docker-compose and the Unraid template pass EMAIL_FROM empty when it isn't set
  return process.env.EMAIL_FROM || 'ShareTab <noreply@sharetab.local>';
}

/**
 * What to log about a failed send: the error's name and nodemailer's code, SMTP response code
 * and command (e.g. EAUTH, 535, AUTH PLAIN, all fixed values), never its message or the server's
 * response, which can carry the address.
 */
export function describeMailError(error: unknown) {
  if (!(error instanceof Error)) return { error: 'unknown' };
  const { code, responseCode, command } = error as { code?: unknown; responseCode?: unknown; command?: unknown };
  return {
    error: error.name,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof responseCode === 'number' ? { responseCode } : {}),
    ...(typeof command === 'string' ? { command } : {}),
  };
}

/**
 * The instance's public URL, for the links in auth-expiry emails (Auth.js builds
 * magic links itself). Taken from configuration, `AUTH_URL` then `NEXTAUTH_URL` as Auth.js
 * prefers them (an empty value counts as unset here), never from the request's Host header,
 * which a request's sender controls. Throws, and logs why, when it isn't an http(s) URL.
 */
export function publicBaseUrl(): string {
  const configured = process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
  let url: URL | undefined;
  try {
    url = new URL(configured);
  } catch {
    // Refused below
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    // Logged here: a failed send's log (describeMailError) carries no message. Only
    // the scheme it was read with: a value without one can carry user:password@
    logger.warn('mail.public_url_invalid', { scheme: url?.protocol ?? null });
    throw new Error('AUTH_URL or NEXTAUTH_URL is not an http(s) URL');
  }
  // The origin only: Auth.js also takes AUTH_URL with its /api/auth path, and ShareTab's pages
  // have no base path
  return url.origin;
}
