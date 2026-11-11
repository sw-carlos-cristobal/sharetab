/**
 * Email/password sign-in: the Credentials provider's `authorize` step, the per-address login limit
 * (whose count and window Settings password guesses reuse under a key of their own), and the
 * check that refuses the password routes while password sign-in is off.
 */

import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../db';
import { AppError } from './app-error';
import { parseAuthConfig } from './auth-config';
import { logger } from './logger';
import { checkRateLimit, clearRateLimit, parsePositiveInt, refundRateLimit } from './rate-limit';
import { getClientIp, FALLBACK_IP } from './client-ip';
import { AmbiguousEmailError, findUserByEmail } from './user-email';

/**
 * A sign-in refused by a login limit, which lifts in `retryAfterMs`. `password-credentials.ts`
 * turns it into the code the login page reads (#401); this module stays free of next-auth, whose
 * entry the routers' tests can't load.
 */
export class LoginRateLimited extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('Too many sign-in attempts');
    this.name = 'LoginRateLimited';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Refuses the password routes while password sign-in is off (`DISABLE_PASSWORD_LOGIN`). */
export function requirePasswordLogin() {
  const config = parseAuthConfig(process.env);
  if (!config.passwordLogin) {
    throw new AppError('FORBIDDEN', 'passwordLoginDisabled');
  }
  return config;
}

/**
 * The per-address login rate-limit key, cleared by a successful sign-in, a password reset or a
 * change in Settings.
 * Lowercased like the user lookup, so case variants share a bucket.
 */
export function loginRateLimitKey(email: string): string {
  return `login:${email.toLowerCase()}`;
}

/** The per-IP login rate-limit key. */
function loginIpRateLimitKey(ip: string): string {
  return `login-ip:${ip}`;
}

/** Failed password attempts per address in LOGIN_WINDOW_MS (configurable for CI/testing). Settings shares it. */
export function loginAttemptsPerEmail(): number {
  return parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 5);
}

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * Current-password guesses in Settings, per account: each counted before it's checked, as many in
 * LOGIN_WINDOW_MS as the login form allows; a right one clears the count.
 */
export function passwordChangeGuessKey(userId: string): string {
  return `password-change:${userId}`;
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function authorizePasswordLogin(credentials: unknown, headers: Headers) {
  const parsed = loginSchema.safeParse(credentials);
  if (!parsed.success) return null;

  // Both limits count only failed attempts (#401), yet each attempt is counted
  // here, before its password is checked, so guesses sent at once are held too;
  // a successful sign-in then clears the address's count and gives the IP back
  // its attempt (below). A refusal throws
  // LoginRateLimited, so the login page says to wait rather than that the
  // password is wrong.

  // Rate limit login attempts per IP — bounds password spraying across
  // many emails while staying generous for shared NATs/households.
  // Checked BEFORE the per-email bucket so attempts denied by the IP
  // cap don't also charge the email bucket: a user behind a rate-
  // limited shared IP who keeps retrying must not end up locked out
  // by their email bucket after the IP window clears.
  // Skipped when no proxy header identifies the client (direct
  // deployments without a reverse proxy): a single shared bucket
  // would let one client lock every user out of login, and the
  // per-email bucket below still bounds attempts in that case.
  const ip = getClientIp(headers);
  const ipKey = ip === FALLBACK_IP ? null : loginIpRateLimitKey(ip);
  if (ipKey) {
    const maxIpAttempts = parsePositiveInt(process.env.AUTH_IP_RATE_LIMIT_MAX, 30);
    const { allowed: ipAllowed, retryAfterMs } = checkRateLimit(ipKey, maxIpAttempts, LOGIN_WINDOW_MS);
    if (!ipAllowed) {
      logger.warn('auth.rate_limited_ip', { ip });
      throw new LoginRateLimited(retryAfterMs);
    }
  }

  // Rate limit login attempts per email
  const emailKey = loginRateLimitKey(parsed.data.email);
  const { allowed, retryAfterMs } = checkRateLimit(emailKey, loginAttemptsPerEmail(), LOGIN_WINDOW_MS);
  if (!allowed) {
    logger.warn('auth.rate_limited', { email: parsed.data.email });
    // No password was checked, so the IP gets back the attempt it was charged
    if (ipKey) refundRateLimit(ipKey);
    throw new LoginRateLimited(retryAfterMs);
  }

  let user;
  let valid;
  try {
    user = await findUserByEmail(db, parsed.data.email);
    if (!user?.passwordHash) return null;
    valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
  } catch (error) {
    if (error instanceof AmbiguousEmailError) {
      logger.warn('auth.login_failed', { email: parsed.data.email, reason: 'ambiguous_email' });
      return null;
    }
    // Not a wrong password (the database or bcrypt failed): both limits get back what this
    // attempt counted, so an outage doesn't use up an address's attempts
    refundRateLimit(emailKey);
    if (ipKey) refundRateLimit(ipKey);
    throw error;
  }
  if (!valid) {
    logger.warn('auth.login_failed', { email: parsed.data.email, reason: 'invalid_password' });
    return null;
  }

  // The address's count clears, as a right password does in Settings: only its
  // owner gets here. The IP's only gives back this attempt, so signing in to an
  // account of one's own can't reset the count of guesses at other addresses.
  clearRateLimit(emailKey);
  if (ipKey) refundRateLimit(ipKey);

  logger.info('auth.login', { userId: user.id, email: user.email });
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    locale: user.locale,
    // Read with the hash just verified: a reset that commits meanwhile ends this session (auth.ts)
    passwordChangedAt: user.passwordChangedAt,
  };
}
