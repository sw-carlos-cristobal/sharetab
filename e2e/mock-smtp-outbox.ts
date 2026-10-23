import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { expect } from '@playwright/test';

/** Where scripts/mock-smtp.mjs writes the mail it accepts (CI sets it). */
export const outbox = process.env.MOCK_SMTP_OUTBOX;

/** The messages mock-smtp received for this address, newest first, with quoted-printable undone. */
export function mailTo(email: string): string[] {
  if (!outbox) return [];
  return readdirSync(outbox)
    .filter((file) => file.endsWith('.eml'))
    .sort()
    .reverse()
    .map((file) => readFileSync(join(outbox, file), 'utf-8'))
    .filter((raw) => raw.split('\r\n').includes(`X-Rcpt-To: ${email}`))
    .map((raw) =>
      // Soft line breaks, then =XX escapes
      raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    );
}

/** The newest password reset link mock-smtp received for this address. */
export function readResetLink(email: string): string | null {
  for (const message of mailTo(email)) {
    const link = message.match(/https?:\/\/[^\s"<]+\/reset-password#token=[A-Za-z0-9_-]{43}/);
    if (link) return link[0];
  }
  return null;
}

/** How many "your password was changed" emails mock-smtp received for this address. */
export function passwordChangedEmails(email: string): number {
  return mailTo(email).filter((message) => /^Subject: Your ShareTab password was changed\r?$/m.test(message)).length;
}

/**
 * With email configured and the outbox kept, checks the account got one "password changed" email:
 * waits for it, then a moment more, so a second one would show. Checks nothing otherwise.
 */
export async function expectOnePasswordChangedEmail(email: string) {
  if (!process.env.EMAIL_SERVER_HOST || !outbox) return;
  await expect.poll(() => passwordChangedEmails(email), { timeout: 15000 }).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(passwordChangedEmails(email)).toBe(1);
}
