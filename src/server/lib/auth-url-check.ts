import { logger } from './logger';
import { configuredAuthUrl } from './session-cookie';

type Scheme = 'http' | 'https';

export interface AuthUrlSchemeMismatch {
  /** The variable in effect: AUTH_URL, else NEXTAUTH_URL */
  setting: 'AUTH_URL' | 'NEXTAUTH_URL';
  /** Its origin, without user info or path */
  configured: string;
  /** The scheme the browser used, as Next.js reads it from x-forwarded-proto */
  requestScheme: Scheme;
}

/**
 * The configured auth URL and the request's scheme, when they differ (#409). Auth.js names and
 * marks its cookies by the configured URL's scheme, so an https URL reached over http has the
 * browser drop the Secure sign-in cookies (sign-in fails with MissingCSRF), and an http URL
 * reached over https gets cookies that aren't marked Secure. Null when they agree, when nothing
 * is configured, or when the request carries no x-forwarded-proto (Next.js always sets one).
 * The host isn't compared: reaching one instance by a LAN address and a public name is a
 * working setup, and sign-in doesn't depend on it.
 */
export function authUrlSchemeMismatch(requestHeaders: Headers): AuthUrlSchemeMismatch | null {
  const configured = configuredAuthUrl();
  const forwarded = requestHeaders.get('x-forwarded-proto');
  if (!configured || forwarded === null) return null;
  const configuredScheme: Scheme = configured.url.protocol === 'https:' ? 'https' : 'http';
  const requestScheme: Scheme = forwarded.includes('https') ? 'https' : 'http';
  if (configuredScheme === requestScheme) return null;
  return { setting: configured.setting, configured: configured.url.origin, requestScheme };
}

const warned = new Set<Scheme>();

/** Logs `auth.url_scheme_mismatch` the first time each direction of mismatch is seen in this process */
export function warnOnAuthUrlSchemeMismatch(requestHeaders: Headers): void {
  const mismatch = authUrlSchemeMismatch(requestHeaders);
  if (!mismatch || warned.has(mismatch.requestScheme)) return;
  warned.add(mismatch.requestScheme);
  const { setting, requestScheme } = mismatch;
  const hint =
    requestScheme === 'https'
      ? `ShareTab was reached over https, but ${setting} is http, so its sign-in cookies aren't marked Secure. Set ${setting} to the https address people use.`
      : `ShareTab was reached over plain http, but ${setting} is https. Browsers drop the Secure sign-in cookies over http (except on localhost), so sign-in fails. Open ShareTab at its https address, or set ${setting} to the address people use.`;
  logger.warn('auth.url_scheme_mismatch', { ...mismatch, hint });
}
