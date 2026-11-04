import NextAuth from 'next-auth';
import type { Adapter } from 'next-auth/adapters';
import type { Provider } from 'next-auth/providers';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import Nodemailer from 'next-auth/providers/nodemailer';
import { headers } from 'next/headers';
import { db } from './db';
import { logger } from './lib/logger';
import { mailFrom, smtpOptions } from './lib/mailer';
import { parseAuthConfig } from './lib/auth-config';
import { GOOGLE_PROVIDER_ID, checkGoogleSignIn, googleProviderOptions } from './lib/google-sign-in';
import { OIDC_PROVIDER_ID, checkOidcSignIn, mapOidcProfile } from './lib/oidc-sign-in';
import { authorizePasswordLogin } from './lib/password-login';
import { sessionCookieSubject } from './lib/session-cookie';
import { markPasswordVersionUnread } from './lib/session-endpoint';
import { readEmailVerified } from './lib/sign-in-identity';
import { findUserByEmail } from './lib/user-email';

const authConfig = parseAuthConfig(process.env);
for (const warning of authConfig.warnings) {
  logger.warn('auth.config', { warning });
}

// Auth.js lowercases OAuth and magic-link emails before looking users up,
// but password sign-ups keep the casing the user typed. Match
// case-insensitively so those users are found instead of duplicated; an
// ambiguous match throws, which fails the sign-in instead of creating
// another account.
const adapter: Adapter = {
  ...PrismaAdapter(db),
  getUserByEmail: (email) => findUserByEmail(db, email),
};

const providers: Provider[] = [];

if (authConfig.passwordLogin) {
  providers.push(
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: (credentials, request) => authorizePasswordLogin(credentials, request.headers),
    }),
  );
}

if (authConfig.google) {
  providers.push(Google(googleProviderOptions(authConfig.google)));
}

if (authConfig.magicLink) {
  providers.push(
    Nodemailer({
      // Checked against nodemailer's own type (smtpOptions): Auth.js types `server` as `any`
      // under nodemailer 10, whose transport modules are namespaces that @auth/core's
      // declarations use as types.
      server: smtpOptions(),
      from: mailFrom(),
    }),
  );
}

if (authConfig.oidc) {
  const oidc = authConfig.oidc;
  providers.push({
    id: OIDC_PROVIDER_ID,
    name: oidc.displayName,
    type: 'oidc',
    // Auth.js defaults a generic OIDC provider to `checks: ['pkce']`, so it would
    // send no `state`. Cloudflare Access (and the OAuth 2.0 spec's CSRF advice)
    // rejects such a request with "state is a required parameter"; opting in makes
    // Auth.js create, cookie-store and verify the state value like PKCE.
    checks: ['pkce', 'state'],
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    clientSecret: oidc.clientSecret,
    client: { token_endpoint_auth_method: oidc.tokenAuthMethod },
    // Validate the ID token, then take the profile from the UserInfo
    // endpoint: some IdPs (Authelia by default) keep email and name out of
    // the ID token.
    idToken: false,
    // Only reached after the signIn callback below has approved linking.
    allowDangerousEmailAccountLinking: oidc.allowEmailLinking,
    profile: (claims) => mapOidcProfile(claims),
  });
}

/**
 * A password version (#397): when the user's password last changed, in milliseconds, 0 if it never
 * has. A session carries the version it signed in under; one whose version is no longer the user's
 * has ended.
 */
function passwordStamp(changedAt: Date | null | undefined): number {
  return changedAt?.getTime() ?? 0;
}

const LOGIN_EVENTS: Record<string, string> = {
  [OIDC_PROVIDER_ID]: 'auth.oidc_login',
  [GOOGLE_PROVIDER_ID]: 'auth.google_login',
};

/**
 * Who is already signed in in this browser, so the OIDC and Google policies
 * never attach a new identity to someone else's account.
 */
async function sessionCookieUserId(): Promise<string | null> {
  const signedIn = (await auth())?.user?.id;
  if (signedIn) return signedIn;
  // auth() reports nobody once the jwt callback has ended the session (a password reset or
  // change, or a version it couldn't read, #397), but the cookie stays until the browser next
  // reads /api/auth/session, and Auth.js links a new identity to the cookie's user (it decodes
  // the cookie itself)
  return sessionCookieSubject(await headers());
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter,
  session: { strategy: 'jwt' },
  // Always on, so Auth.js never reads AUTH_TRUST_HOST (#417). Left to itself it refuses every
  // request in production while AUTH_TRUST_HOST and AUTH_URL are both unset (NEXTAUTH_URL doesn't
  // count), and reads any non-empty AUTH_TRUST_HOST, "false" included, as on. With AUTH_URL or
  // NEXTAUTH_URL set, next-auth takes every auth request's address from it. Without one, a route
  // handler's address is the one the server listens on (0.0.0.0:3000 in the Docker image), never
  // the Host header.
  trustHost: true,
  pages: {
    signIn: '/login',
    verifyRequest: '/verify-request',
    // Show every Auth.js error (expired magic link, OIDC misconfiguration,
    // ...) on the login page instead of Auth.js' built-in error page.
    error: '/login',
  },
  providers,
  events: {
    signIn({ user, account, isNewUser }) {
      // External identity providers: the log shows who signed in, and isNewUser when it made the account.
      const event = account?.provider ? LOGIN_EVENTS[account.provider] : undefined;
      if (event) logger.info(event, { userId: user.id, email: user.email, isNewUser: isNewUser ?? false });
    },
  },
  callbacks: {
    async signIn({ user, account, profile }): Promise<boolean | string> {
      if (account?.provider === GOOGLE_PROVIDER_ID) {
        return checkGoogleSignIn(db, {
          providerAccountId: account.providerAccountId,
          email: user.email ?? null,
          // Claims from Google's ID token.
          claims: profile ?? {},
          sessionUserId: await sessionCookieUserId(),
          adminEmail: process.env.ADMIN_EMAIL,
        });
      }

      if (account?.provider === OIDC_PROVIDER_ID && authConfig.oidc) {
        return checkOidcSignIn(db, {
          providerAccountId: account.providerAccountId,
          email: user.email ?? null,
          // Raw claims from the UserInfo endpoint (see `idToken: false` above).
          emailVerified: readEmailVerified(profile ?? {}),
          sessionUserId: await sessionCookieUserId(),
          autoRegister: authConfig.oidc.autoRegister,
          allowEmailLinking: authConfig.oidc.allowEmailLinking,
          passwordLogin: authConfig.passwordLogin,
        });
      }

      return true;
    },
    async jwt({ token, user }) {
      if (user?.id) {
        token.id = user.id;
        if (user.name !== undefined) token.name = user.name;
        if (user.locale !== undefined) token.locale = user.locale;
        // The password version this sign-in was checked against: password login passes the one
        // it read with the hash it verified, the other providers the user row they signed in to
        token.passwordStamp = passwordStamp(user.passwordChangedAt);
      }
      // Always refresh profile fields from DB to pick up profile changes.
      if (token.id) {
        try {
          const fresh = await db.user.findUnique({
            where: { id: token.id as string },
            select: { name: true, locale: true, passwordChangedAt: true },
          });
          // A password reset or change ends every session signed in under an earlier password
          // (#397), including a sign-in that checked the old password while the change committed.
          // Null makes auth() report no session and the session endpoint clear the cookie.
          // Sessions from before the version was recorded count as 0: they end once the
          // password changes.
          if (fresh && passwordStamp(fresh.passwordChangedAt) !== (token.passwordStamp ?? 0)) {
            return null;
          }
          if (fresh?.name) token.name = fresh.name;
          if (fresh?.locale) token.locale = fresh.locale;
        } catch (error) {
          logger.warn('auth.session_refresh_failed', { error: error instanceof Error ? error.name : 'unknown' });
          // A sign-in keeps its session: its provider just read the version, and the next check
          // reads it again. Otherwise the version can't be checked, so the session counts as
          // ended (#397) and every caller of auth() refuses it for this request. Only the
          // session endpoint would clear the cookie, and there keepSessionWhileDatabaseDown
          // (lib/session-endpoint.ts) answers 503 instead when told this read failed, so the
          // session works again once the database answers. The OIDC and Google policies still
          // see who is signed in: sessionCookieUserId reads the cookie itself.
          if (user?.id) return token;
          markPasswordVersionUnread();
          return null;
        }
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.name = (token.name as string | null | undefined) ?? session.user.name ?? null;
        if (typeof token.locale === 'string') {
          session.user.locale = token.locale;
        }
      }
      return session;
    },
  },
});
