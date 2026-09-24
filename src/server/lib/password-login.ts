/**
 * Email/password sign-in: the Credentials provider's `authorize` step.
 */

import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../db';
import { logger } from './logger';
import { checkRateLimit, parsePositiveInt } from './rate-limit';
import { getClientIp, FALLBACK_IP } from './client-ip';
import { AmbiguousEmailError, findUserByEmail } from './user-email';

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

  // Rate limit login attempts per email (configurable for CI/testing).
  // Lowercased like the lookup below, so case variants share a bucket.
  const maxLoginAttempts = parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 5);
  const { allowed } = checkRateLimit(`login:${parsed.data.email.toLowerCase()}`, maxLoginAttempts, 15 * 60 * 1000);
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
  return { id: user.id, name: user.name, email: user.email, image: user.image, locale: user.locale };
}
