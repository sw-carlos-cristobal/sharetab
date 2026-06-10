import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "./db";
import { logger } from "./lib/logger";
import { checkRateLimit, parsePositiveInt } from "./lib/rate-limit";
import { getClientIp } from "./lib/client-ip";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
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
        const ip = getClientIp(request.headers);
        const maxIpAttempts = parsePositiveInt(process.env.AUTH_IP_RATE_LIMIT_MAX, 30);
        const { allowed: ipAllowed } = checkRateLimit(
          `login-ip:${ip}`,
          maxIpAttempts,
          15 * 60 * 1000
        );
        if (!ipAllowed) {
          logger.warn("auth.rate_limited_ip", { ip });
          return null;
        }

        // Rate limit login attempts per email (configurable for CI/testing)
        const maxLoginAttempts = parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 5);
        const { allowed } = checkRateLimit(
          `login:${parsed.data.email}`,
          maxLoginAttempts,
          15 * 60 * 1000
        );
        if (!allowed) {
          logger.warn("auth.rate_limited", { email: parsed.data.email });
          return null;
        }

        const user = await db.user.findUnique({
          where: { email: parsed.data.email },
        });
        if (!user?.passwordHash) return null;

        const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!valid) {
          logger.warn("auth.login_failed", { email: parsed.data.email, reason: "invalid_password" });
          return null;
        }

        logger.info("auth.login", { userId: user.id, email: user.email });
        return { id: user.id, name: user.name, email: user.email, image: user.image, locale: user.locale };
      },
    }),
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
    ...(process.env.EMAIL_SERVER_HOST
      ? [
          Nodemailer({
            server: {
              host: process.env.EMAIL_SERVER_HOST,
              port: parseInt(process.env.EMAIL_SERVER_PORT ?? "587"),
              secure: parseInt(process.env.EMAIL_SERVER_PORT ?? "587") === 465,
              auth: {
                user: process.env.EMAIL_SERVER_USER,
                pass: process.env.EMAIL_SERVER_PASSWORD,
              },
            },
            from: process.env.EMAIL_FROM ?? "ShareTab <noreply@sharetab.local>",
          }),
        ]
      : []),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        token.id = user.id;
        token.name = user.name;
        token.locale = user.locale;
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
        session.user.name = (token.name as string | null | undefined) ?? session.user.name;
        session.user.locale = typeof token.locale === "string" ? token.locale : session.user.locale;
      }
      return session;
    },
  },
});
