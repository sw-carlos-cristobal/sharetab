import { getToken } from 'next-auth/jwt';

/** The secrets Auth.js signs sessions with: AUTH_SECRET, else NEXTAUTH_SECRET, else AUTH_SECRET_3..1 */
function sessionSecrets(): string[] {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (secret) return [secret];
  return [3, 2, 1].map((i) => process.env[`AUTH_SECRET_${i}`]).filter((s): s is string => !!s);
}

/**
 * Whether Auth.js names its session cookie __Secure-: by the configured URL's scheme, else by the
 * request's protocol as Next.js derives it (any x-forwarded-proto that includes https).
 */
function usesSecureCookie(requestHeaders: Headers): boolean {
  const configured = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (configured) {
    try {
      return new URL(configured).protocol === 'https:';
    } catch {
      // Auth.js would fail on it too; go by the request
    }
  }
  return requestHeaders.get('x-forwarded-proto')?.includes('https') ?? false;
}

/**
 * The user id in the Auth.js session cookie of a request, or null. Reads the one cookie Auth.js
 * reads when it links a new sign-in to the browser's user, as it reads it: its name, its secrets,
 * and never an Authorization header. A leftover cookie of the other name (from before a move to
 * https, say) is ignored, as Auth.js ignores it: signing out can't clear it.
 */
export async function sessionCookieSubject(requestHeaders: Headers): Promise<string | null> {
  const secret = sessionSecrets();
  if (secret.length === 0) return null;
  const token = await getToken({
    req: { headers: new Headers({ cookie: requestHeaders.get('cookie') ?? '' }) },
    secret,
    secureCookie: usesSecureCookie(requestHeaders),
  });
  return token?.sub ?? null;
}
