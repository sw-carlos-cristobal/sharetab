/**
 * Sign-in configuration parsed from environment variables.
 *
 * Parsing never throws: an invalid value falls back to its safe default and
 * adds a human-readable warning (logged when the auth module first loads),
 * so a typo in an optional auth setting can't take the whole app down.
 */

export type OidcTokenAuthMethod = 'client_secret_basic' | 'client_secret_post';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  displayName: string;
  autoRegister: boolean;
  allowEmailLinking: boolean;
  tokenAuthMethod: OidcTokenAuthMethod;
}

export interface AuthConfig {
  passwordLogin: boolean;
  magicLink: boolean;
  oidc: OidcConfig | null;
  warnings: string[];
}

type Env = Record<string, string | undefined>;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);
const TOKEN_AUTH_METHODS: readonly OidcTokenAuthMethod[] = ['client_secret_basic', 'client_secret_post'];

function read(env: Env, name: string): string {
  return env[name]?.trim() ?? '';
}

function parseBoolean(env: Env, name: string, fallback: boolean, warnings: string[]): boolean {
  const value = read(env, name).toLowerCase();
  if (value === '') return fallback;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  warnings.push(`${name} must be true or false; using the default (${fallback}).`);
  return fallback;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function parseTokenAuthMethod(env: Env, warnings: string[]): OidcTokenAuthMethod {
  const value = read(env, 'OIDC_TOKEN_AUTH_METHOD').toLowerCase();
  if (value === '') return 'client_secret_basic';
  const method = TOKEN_AUTH_METHODS.find((m) => m === value);
  if (method) return method;
  warnings.push(`OIDC_TOKEN_AUTH_METHOD must be one of ${TOKEN_AUTH_METHODS.join(', ')}; using client_secret_basic.`);
  return 'client_secret_basic';
}

function parseOidc(env: Env, warnings: string[]): OidcConfig | null {
  const issuer = read(env, 'OIDC_ISSUER');
  const clientId = read(env, 'OIDC_CLIENT_ID');
  const clientSecret = read(env, 'OIDC_CLIENT_SECRET');

  const required = { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret };
  const missing = Object.entries(required)
    .filter(([, value]) => value === '')
    .map(([name]) => name);
  if (missing.length === Object.keys(required).length) return null;
  if (missing.length > 0) {
    warnings.push(`OIDC sign-in is disabled: ${missing.join(', ')} not set.`);
    return null;
  }
  if (!isHttpUrl(issuer)) {
    warnings.push('OIDC sign-in is disabled: OIDC_ISSUER must be an http(s) URL.');
    return null;
  }

  return {
    // Kept exactly as given: discovery requires it to equal (as a URL) the
    // `issuer` the IdP publishes, and whether a path ends in a slash matters
    // (Authentik's does).
    issuer,
    clientId,
    clientSecret,
    displayName: read(env, 'OIDC_DISPLAY_NAME') || 'SSO',
    autoRegister: parseBoolean(env, 'OIDC_AUTO_REGISTER', true, warnings),
    allowEmailLinking: parseBoolean(env, 'OIDC_ALLOW_EMAIL_LINKING', false, warnings),
    tokenAuthMethod: parseTokenAuthMethod(env, warnings),
  };
}

export function parseAuthConfig(env: Env): AuthConfig {
  const warnings: string[] = [];
  const oidc = parseOidc(env, warnings);
  const magicLink = read(env, 'EMAIL_SERVER_HOST') !== '';

  let passwordLogin = !parseBoolean(env, 'DISABLE_PASSWORD_LOGIN', false, warnings);
  // Refuse to disable password login when no other sign-in method is
  // configured. (Whether existing accounts can use it is up to the admin; see
  // README.) Google doesn't count: the login page has no Google button.
  if (!passwordLogin && !oidc && !magicLink) {
    warnings.push('DISABLE_PASSWORD_LOGIN is ignored: neither OIDC nor magic link sign-in is configured.');
    passwordLogin = true;
  }

  return { passwordLogin, magicLink, oidc, warnings };
}
