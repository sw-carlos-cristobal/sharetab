import { getToken } from 'next-auth/jwt';

/** The secrets Auth.js signs sessions with: AUTH_SECRET, else NEXTAUTH_SECRET, else AUTH_SECRET_3..1 */
function sessionSecrets(): string[] {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (secret) return [secret];
  return [3, 2, 1].map((i) => process.env[`AUTH_SECRET_${i}`]).filter((s): s is string => !!s);
}

/**
 * The user id in the Auth.js session cookie of a request's cookie header, or null. Reads the
 * cookie as Auth.js does when it links a new sign-in to the browser's user: its secrets, and
 * never an Authorization header. Both cookie names are tried (Auth.js picks the __Secure- one
 * from the configured URL or the request's protocol): only a cookie Auth.js encrypted decodes,
 * and finding one only ever refuses a sign-in (`isSessionConflict`).
 */
export async function sessionCookieSubject(cookie: string): Promise<string | null> {
  const secret = sessionSecrets();
  if (secret.length === 0) return null;
  const req = { headers: new Headers({ cookie }) };
  for (const secureCookie of [true, false]) {
    const token = await getToken({ req, secret, secureCookie });
    if (token?.sub) return token.sub;
  }
  return null;
}
