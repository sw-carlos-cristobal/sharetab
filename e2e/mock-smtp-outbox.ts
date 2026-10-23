import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

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
