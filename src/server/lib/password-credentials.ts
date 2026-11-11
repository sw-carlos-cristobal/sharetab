/**
 * The Credentials provider's `authorize` as auth.ts registers it: `authorizePasswordLogin`, with a
 * refusal by a login limit turned into a `CredentialsSignin` whose `code` Auth.js hands to the login
 * page's `signIn()` result (#401), so the page says how long to wait rather than that the password
 * is wrong. Kept out of password-login.ts, which the routers import, so only auth.ts loads next-auth.
 */

import { CredentialsSignin } from 'next-auth';
import { rateLimitedSignInCode } from '@/lib/sign-in-rate-limit';
import { LoginRateLimited, authorizePasswordLogin } from './password-login';

export class SignInRateLimited extends CredentialsSignin {
  constructor(retryAfterMs: number) {
    super();
    this.code = rateLimitedSignInCode(retryAfterMs);
  }
}

export async function authorizeCredentials(credentials: unknown, request: Request) {
  try {
    return await authorizePasswordLogin(credentials, request.headers);
  } catch (error) {
    if (error instanceof LoginRateLimited) throw new SignInRateLimited(error.retryAfterMs);
    throw error;
  }
}
