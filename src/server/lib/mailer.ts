/**
 * Outgoing email: the SMTP settings (`EMAIL_SERVER_*`, `EMAIL_FROM`) shared by the magic-link
 * provider, password reset emails, the admin test email and the auth-expiry alerts, and the
 * public URL that links in those emails point at.
 */

import nodemailer from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer';

// Whether email is set up at all is `parseAuthConfig(...).magicLink` (EMAIL_SERVER_HOST set)
export function smtpOptions() {
  const port = parseInt(process.env.EMAIL_SERVER_PORT ?? '587');
  return {
    host: process.env.EMAIL_SERVER_HOST,
    port,
    secure: port === 465,
    auth: {
      ...(process.env.EMAIL_SERVER_USER !== undefined ? { user: process.env.EMAIL_SERVER_USER } : {}),
      ...(process.env.EMAIL_SERVER_PASSWORD !== undefined ? { pass: process.env.EMAIL_SERVER_PASSWORD } : {}),
    },
  } satisfies SMTPTransportOptions;
}

export function createMailTransport() {
  return nodemailer.createTransport(smtpOptions());
}

export function mailFrom(): string {
  return process.env.EMAIL_FROM ?? 'ShareTab <noreply@sharetab.local>';
}

/**
 * The instance's public URL, for links in emails. Taken from configuration like Auth.js does
 * (`AUTH_URL`, then `NEXTAUTH_URL`), never from the request's Host header, which the sender of
 * a reset request controls.
 */
export function publicBaseUrl(): string {
  const configured = process.env.AUTH_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
  return configured.replace(/\/+$/, '');
}
