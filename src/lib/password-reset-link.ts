/**
 * Password reset links (#397): `/{locale}/reset-password#token=<token>`. The token rides in the
 * fragment, which browsers never send to a server, so it stays out of request URLs, proxy and
 * server logs, and Referer headers. Shared by the reset email, the admin's copied link and the
 * reset page.
 */

const RESET_TOKEN_PARAM = 'token';

// 32 random bytes in URL-safe base64 without padding (newResetToken in src/server/lib/password-reset.ts)
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function resetPasswordPath(locale: string, token: string): string {
  return `/${locale}/reset-password#${RESET_TOKEN_PARAM}=${token}`;
}

/** The token in a reset link's #fragment, or null if there isn't a valid one. */
export function readResetToken(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get(RESET_TOKEN_PARAM);
  return value && RESET_TOKEN_PATTERN.test(value) ? value : null;
}
