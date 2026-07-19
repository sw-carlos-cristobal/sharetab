import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import Nodemailer from 'next-auth/providers/nodemailer';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from './db';
import { logger } from './lib/logger';
import { checkRateLimit, parsePositiveInt } from './lib/rate-limit';
import { getClientIp, FALLBACK_IP } from './lib/client-ip';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
    verifyRequest: '/verify-request',
  },
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, request) {
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
        const ip = getClientIp(request.headers);
        if (ip !== FALLBACK_IP) {
          const maxIpAttempts = parsePositiveInt(process.env.AUTH_IP_RATE_LIMIT_MAX, 30);
          const { allowed: ipAllowed } = checkRateLimit(`login-ip:${ip}`, maxIpAttempts, 15 * 60 * 1000);
          if (!ipAllowed) {
            logger.warn('auth.rate_limited_ip', { ip });
            return null;
          }
        }

        // Rate limit login attempts per email (configurable for CI/testing)
        const maxLoginAttempts = parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 5);
        const { allowed } = checkRateLimit(`login:${parsed.data.email}`, maxLoginAttempts, 15 * 60 * 1000);
        if (!allowed) {
          logger.warn('auth.rate_limited', { email: parsed.data.email });
          return null;
        }

        const user = await db.user.findUnique({
          where: { email: parsed.data.email },
        });
        if (!user?.passwordHash) return null;

        const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!valid) {
          logger.warn('auth.login_failed', { email: parsed.data.email, reason: 'invalid_password' });
          return null;
        }

        logger.info('auth.login', { userId: user.id, email: user.email });
        return { id: user.id, name: user.name, email: user.email, image: user.image, locale: user.locale };
      },
    }),
    // @ts-expect-error -- upstream next-auth type bug (not fixable from the call
    // site): NodemailerConfig["server"] is declared `server?: AllTransportOptions`,
    // but the base EmailConfig re-derives it via an indexed-access type
    // (`server?: NodemailerConfig["server"]`), which flattens the optional-property
    // bit into an explicit `AllTransportOptions | undefined` value type. Under
    // exactOptionalPropertyTypes that reads as "may be present-as-undefined", which
    // NodemailerConfig's own (correctly) optional `server?:` field does not accept.
    // TS attributes the diagnostic to this first spread element in the providers
    // array literal; see also the (related but not identical) upstream discussion
    // in nextauthjs/next-auth#9883 / #9890.
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
    // @ts-expect-error -- same upstream NodemailerConfig["server"] typing issue as above.
    ...(process.env.EMAIL_SERVER_HOST
      ? [
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
        ]
      : []),
  ],
  callbacks: {
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
