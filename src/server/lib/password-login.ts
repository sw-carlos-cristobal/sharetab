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
import { checkRateLimit, parsePositiveInt } from './rate-limit';
import { getClientIp, FALLBACK_IP } from './client-ip';
import { AmbiguousEmailError, findUserByEmail } from './user-email';

/** Refuses the password routes while password sign-in is off (`DISABLE_PASSWORD_LOGIN`). */
export function requirePasswordLogin() {
  const config = parseAuthConfig(process.env);
  if (!config.passwordLogin) {
    throw new AppError('FORBIDDEN', 'passwordLoginDisabled');
  }
  return config;
}

/**
 * The per-address login rate-limit key, also cleared by a password reset or a change in Settings.
 * Lowercased like the user lookup, so case variants share a bucket.
 */
export function loginRateLimitKey(email: string): string {
  return `login:${email.toLowerCase()}`;
}

/** Password attempts per address in LOGIN_WINDOW_MS (configurable for CI/testing). Settings shares it. */
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
  if (ip !== FALLBACK_IP) {
    const maxIpAttempts = parsePositiveInt(process.env.AUTH_IP_RATE_LIMIT_MAX, 30);
    const { allowed: ipAllowed } = checkRateLimit(`login-ip:${ip}`, maxIpAttempts, 15 * 60 * 1000);
    if (!ipAllowed) {
      logger.warn('auth.rate_limited_ip', { ip });
      return null;
    }
  }

  // Rate limit login attempts per email
  const { allowed } = checkRateLimit(loginRateLimitKey(parsed.data.email), loginAttemptsPerEmail(), LOGIN_WINDOW_MS);
  if (!allowed) {
    logger.warn('auth.rate_limited', { email: parsed.data.email });
    return null;
  }

  let user;
  try {
    user = await findUserByEmail(db, parsed.data.email);
  } catch (error) {
    if (!(error instanceof AmbiguousEmailError)) throw error;
    logger.warn('auth.login_failed', { email: parsed.data.email, reason: 'ambiguous_email' });
    return null;
  }
  if (!user?.passwordHash) return null;

  const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!valid) {
    logger.warn('auth.login_failed', { email: parsed.data.email, reason: 'invalid_password' });
    return null;
  }

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
