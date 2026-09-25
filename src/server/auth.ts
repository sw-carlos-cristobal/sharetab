import NextAuth from 'next-auth';
import type { Adapter } from 'next-auth/adapters';
import type { Provider } from 'next-auth/providers';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import Nodemailer from 'next-auth/providers/nodemailer';
import { db } from './db';
import { logger } from './lib/logger';
import { parseAuthConfig } from './lib/auth-config';
import { OIDC_PROVIDER_ID, decideOidcSignIn, gatherOidcFacts, mapOidcProfile } from './lib/oidc-sign-in';
import { authorizePasswordLogin } from './lib/password-login';
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

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  );
}

if (authConfig.magicLink) {
  providers.push(
    // @ts-expect-error -- upstream next-auth type bug (not fixable from the call
    // site): NodemailerConfig["server"] is declared `server?: AllTransportOptions`,
    // but the base EmailConfig re-derives it via an indexed-access type
    // (`server?: NodemailerConfig["server"]`), which flattens the optional-property
    // bit into an explicit `AllTransportOptions | undefined` value type. Under
    // exactOptionalPropertyTypes that reads as "may be present-as-undefined", which
    // NodemailerConfig's own (correctly) optional `server?:` field does not accept.
    // See also the (related but not identical) upstream discussion in
    // nextauthjs/next-auth#9883 / #9890.
    Nodemailer({
      server: {
        host: process.env.EMAIL_SERVER_HOST,
        port: parseInt(process.env.EMAIL_SERVER_PORT ?? '587'),
        secure: parseInt(process.env.EMAIL_SERVER_PORT ?? '587') === 465,
        auth: {
          ...(process.env.EMAIL_SERVER_USER !== undefined ? { user: process.env.EMAIL_SERVER_USER } : {}),
          ...(process.env.EMAIL_SERVER_PASSWORD !== undefined ? { pass: process.env.EMAIL_SERVER_PASSWORD } : {}),
        },
      },
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
      if (account?.provider === OIDC_PROVIDER_ID) {
        logger.info('auth.oidc_login', { userId: user.id, email: user.email, isNewUser: isNewUser ?? false });
      }
    },
  },
  callbacks: {
    async signIn({ user, account }): Promise<boolean | string> {
      if (account?.provider !== OIDC_PROVIDER_ID || !authConfig.oidc) return true;

      // The session this browser already has, if any, so an unlinked IdP
      // identity is never attached to someone else's account.
      const session = await auth();
      const facts = await gatherOidcFacts(db, {
        providerAccountId: account.providerAccountId,
        email: user.email ?? null,
        sessionUserId: session?.user?.id ?? null,
        autoRegister: authConfig.oidc.autoRegister,
        allowEmailLinking: authConfig.oidc.allowEmailLinking,
        passwordLogin: authConfig.passwordLogin,
      });
      const decision = decideOidcSignIn(facts);
      if (decision.allow) return true;

      logger.warn('auth.oidc_denied', {
        error: decision.error,
        ...('reason' in decision ? { reason: decision.reason } : {}),
        email: user.email ?? null,
      });
      return `/login?error=${decision.error}`;
    },
    async jwt({ token, user }) {
      if (user?.id) {
        token.id = user.id;
        if (user.name !== undefined) token.name = user.name;
        if (user.locale !== undefined) token.locale = user.locale;
      }
      // Always refresh profile fields from DB to pick up profile changes.
      if (token.id) {
        const fresh = await db.user.findUnique({
          where: { id: token.id as string },
          select: { name: true, locale: true },
        });
        if (fresh?.name) token.name = fresh.name;
        if (fresh?.locale) token.locale = fresh.locale;
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
