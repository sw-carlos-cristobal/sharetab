import NextAuth from 'next-auth';
import type { Adapter } from 'next-auth/adapters';
import type { Provider } from 'next-auth/providers';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import Nodemailer from 'next-auth/providers/nodemailer';
import type { SMTPTransportOptions } from 'nodemailer';
import { db } from './db';
import { logger } from './lib/logger';
import { parseAuthConfig } from './lib/auth-config';
import { GOOGLE_PROVIDER_ID, checkGoogleSignIn, googleProviderOptions } from './lib/google-sign-in';
import { OIDC_PROVIDER_ID, checkOidcSignIn, mapOidcProfile } from './lib/oidc-sign-in';
import { authorizePasswordLogin } from './lib/password-login';
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
  // Checked against nodemailer's own type: Auth.js types `server` as `any`
  // under nodemailer 10, whose transport modules are namespaces that
  // @auth/core's declarations use as types.
  const server = {
    host: process.env.EMAIL_SERVER_HOST,
    port: parseInt(process.env.EMAIL_SERVER_PORT ?? '587'),
    secure: parseInt(process.env.EMAIL_SERVER_PORT ?? '587') === 465,
    auth: {
      ...(process.env.EMAIL_SERVER_USER !== undefined ? { user: process.env.EMAIL_SERVER_USER } : {}),
      ...(process.env.EMAIL_SERVER_PASSWORD !== undefined ? { pass: process.env.EMAIL_SERVER_PASSWORD } : {}),
    },
  } satisfies SMTPTransportOptions;
  providers.push(
    Nodemailer({
      server,
      from: process.env.EMAIL_FROM ?? 'ShareTab <noreply@sharetab.local>',
    }),
  );
}

if (authConfig.oidc) {
  const oidc = authConfig.oidc;
  providers.push({
    id: OIDC_PROVIDER_ID,
    name: oidc.displayName,
    type: 'oidc',
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

const LOGIN_EVENTS: Record<string, string> = {
  [OIDC_PROVIDER_ID]: 'auth.oidc_login',
  [GOOGLE_PROVIDER_ID]: 'auth.google_login',
};

/**
 * Who is already signed in in this browser, so the OIDC and Google policies
 * never attach a new identity to someone else's account.
 */
async function sessionCookieUserId(): Promise<string | null> {
  return (await auth())?.user?.id ?? null;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter,
  session: { strategy: 'jwt' },
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
      }
      // Always refresh profile fields from DB to pick up profile changes.
      if (token.id) {
        try {
          const fresh = await db.user.findUnique({
            where: { id: token.id as string },
            select: { name: true, locale: true },
          });
          if (fresh?.name) token.name = fresh.name;
          if (fresh?.locale) token.locale = fresh.locale;
        } catch (error) {
          // Keep the session with the fields it has. A throw here makes auth()
          // return no session, and the OIDC and Google policies would then
          // miss that someone is signed in while Auth.js itself still sees them.
          logger.warn('auth.session_refresh_failed', { error: error instanceof Error ? error.name : 'unknown' });
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
