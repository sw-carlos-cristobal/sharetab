/**
 * The code a password sign-in refused by a login limit carries to the login page (#401): the
 * server throws Auth.js's `CredentialsSignin` with it (`password-login.ts`), and `signIn()` hands
 * it back as `result.code`, so the page can say how long to wait instead of that the password is
 * wrong. Shared by both so they agree on its shape.
 */

const PREFIX = 'rate_limited:';

/** The code for a refusal that lifts in `retryAfterMs`, in whole minutes rounded up (at least 1). */
export function rateLimitedSignInCode(retryAfterMs: number): string {
  return `${PREFIX}${Math.max(1, Math.ceil(retryAfterMs / 60_000))}`;
}

/** The minutes a rate-limited code carries, or null for any other code. */
export function rateLimitedMinutes(code: string | undefined): number | null {
  if (!code?.startsWith(PREFIX)) return null;
  const minutes = code.slice(PREFIX.length);
  if (!/^[1-9]\d*$/.test(minutes)) return null;
  return Number(minutes);
}
