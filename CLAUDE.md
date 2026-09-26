# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ShareTab — open-source, self-hosted Splitwise alternative with AI receipt scanning. Targets Unraid (Docker).

## Tech Stack

- **Framework:** Next.js 16 (App Router) + TypeScript
- **API:** tRPC v11 (end-to-end type-safe)
- **ORM:** Prisma 7 + PostgreSQL 16 (via `@prisma/adapter-pg`)
- **Auth:** NextAuth v5 (email/password + OAuth + generic OIDC)
- **UI:** TailwindCSS 4 + shadcn/ui (v4, uses `@base-ui/react` — use `render` prop instead of `asChild`) + next-themes (dark mode)
- **AI:** Pluggable providers (OpenAI, OpenAI-Codex, Claude, Meridian, Ollama) via `src/server/ai/`
- **i18n:** next-intl (9 locales: en, es, sv, fr, de, pt-BR, ja, zh-CN, ko)

## Commands

```bash
npm run dev          # Start dev server (turbopack)
npm run dev:full     # Start embedded PostgreSQL + dev server (all-in-one)
npm run build        # Production build
npm run start        # Start production server
npm run lint         # ESLint
npm run format       # Prettier (auto-fix)
npm run format:check # Prettier (check only)
npx tsc --noEmit     # Type check
npm test             # Run unit tests (Vitest)
npm run test:watch   # Unit tests in watch mode
npm run test:e2e     # Run Playwright e2e tests
npm run test:docker  # Build the Docker image and smoke test it (scripts/docker-smoke.sh; DOCKER_HOST=ssh://... for a remote daemon)
npm run lint:i18n    # Check translations for missing/extra keys
npx prisma generate  # Regenerate Prisma client after schema changes
npx prisma db push   # Push schema without migration (dev only)
```

## Architecture

- `src/server/` — Backend: auth config, Prisma client, tRPC routers, AI providers, pure calculation libs
- `src/server/db.ts` — Prisma client singleton (uses `@prisma/adapter-pg` with `PrismaPg`)
- `src/server/auth.ts` — NextAuth v5 config (Credentials unless `DISABLE_PASSWORD_LOGIN` + optional Google OAuth + optional Nodemailer magic link + optional generic OIDC); wraps the Prisma adapter so `getUserByEmail` is case-insensitive
- `src/server/lib/auth-config.ts` — Parses sign-in env vars (`OIDC_*`, `DISABLE_PASSWORD_LOGIN`) into `AuthConfig`; invalid values fall back to defaults with a logged warning
- `src/server/lib/oidc-sign-in.ts` — OIDC sign-in policy: `decideOidcSignIn` (pure allow/deny) + `gatherOidcFacts` (DB lookups); denials redirect to `/login?error=<code>` (mapped to messages by `src/lib/sign-in-errors.ts`)
- `src/server/lib/password-login.ts` — Credentials `authorize` (rate limits, case-insensitive lookup, bcrypt check)
- `src/server/lib/user-email.ts` — Case-insensitive user lookup by email (`findUsersByEmail` / `findUserByEmail`), shared by the Auth.js adapter, password login, `auth.register`, and the OIDC policy
- `src/server/lib/env.ts` — `parseBooleanValue`: the boolean env vocabulary (true/1/yes/on, false/0/no/off) shared by `auth-config.ts` and `guest-uploads.ts`
- `src/server/lib/guest-uploads.ts` — Guest receipt upload kill switch: admin toggle (`guestUploadsEnabled` SystemSetting, default on, cached 10s, save via `saveGuestUploadsSetting`) overridden by `DISABLE_GUEST_UPLOADS=true` (the admin save is refused while it is set; an unrecognized value logs a warning and is ignored). When off, `canUseGuestUploads` refuses anonymous callers at `/api/upload?guest=true` (403) and `guest.processReceipt` (FORBIDDEN); signed-in users with an active (not suspended) account share the Quick Split path and keep access
- `src/server/lib/guest-join-limit.ts` — `checkJoinRateLimit` for `guest.joinSession`: 10 joins/min per person (share token + normalized name) and 200/min per share token (twice the 100-person session cap). The session budget is peeked before the person budget is spent, so a refused call consumes nothing. A client rotating names can use up the per-token budget (accepted, like the other per-token guest limits)
- `src/server/trpc/init.ts` — tRPC context, `publicProcedure`, `protectedProcedure`, `groupMemberProcedure`
- `src/server/trpc/router.ts` — Root app router (exports `AppRouter` type)
- `src/server/trpc/routers/` — Individual routers: auth, groups, expenses, balances, settlements, activity, receipts, guest, admin
- `src/server/lib/balance-calculator.ts` — Pure functions for debt simplification and balance computation (extracted for testability)
- `src/app/[locale]/` — Next.js App Router pages under i18n locale segment. `(auth)/` for login/register, `(app)/` for authenticated pages
- `src/components/` — React components organized by domain
- `src/components/providers.tsx` — Client-side tRPC + React Query + SessionProvider + ThemeProvider wrapper
- `src/lib/trpc.ts` — Client-side tRPC React hooks
- `src/lib/utils.ts` — `cn()` utility for Tailwind class merging
- `src/generated/prisma/` — Auto-generated Prisma client (do not edit, gitignored)
- `prisma/schema.prisma` — Database schema (money stored as Int cents)
- `prisma.config.ts` — Prisma v7 config (datasource URL lives here, not in schema.prisma)
- `src/i18n/routing.ts` — Locale list, default locale, and next-intl routing config
- `src/i18n/request.ts` — Server-side locale resolution for next-intl
- `src/i18n/navigation.ts` — Locale-aware `Link`, `redirect`, `usePathname`, `useRouter`
- `messages/{locale}/` — Translation files with namespaces: admin, auth, common, dashboard, expenses, groups, settings
- `docker/` — Dockerfile (multi-stage) + docker-compose.yml

## Key Conventions

- All monetary amounts are stored as integers in cents (e.g., $12.99 = 1299)
- tRPC routers live in `src/server/trpc/routers/`
- `protectedProcedure` requires auth; `groupMemberProcedure` requires group membership
- AI providers implement the `AIProvider` interface in `src/server/ai/provider.ts`
- `src/middleware.ts` — NextAuth middleware protecting authenticated routes
- `prisma/seed.ts` — Demo data seed script (run with `npm run db:seed`); idempotent — skips if data already exists
- Hand-written SQL, run by `docker/entrypoint.sh` on every start: `prisma/migrations/*.sql` before `prisma db push` (idempotent, and a no-op on an empty database since a fresh install has no tables yet), `prisma/after-push/*.sql` after it (idempotent; log a warning instead of failing, since any error stops startup). `prisma/after-push/user_email_lower_unique.sql` holds the unique index on `lower(email)` that Prisma's schema can't express; `prisma db push` leaves it alone. `scripts/docker-smoke.sh` boots the image on an empty volume to test both phases
- Prisma v7: datasource URL is configured in `prisma.config.ts`, not in `schema.prisma`
- Prisma v7: PrismaClient requires `@prisma/adapter-pg` adapter in constructor
- Prisma v7: import from `@/generated/prisma/client` (not `@/generated/prisma` — no index.ts)
- shadcn/ui v4: Button uses `render` prop for polymorphism, NOT `asChild`
- shadcn/ui v4: When rendering Button as a Link, add `nativeButton={false}` — **every** `render={<Link>}` needs this
- Split components (`equal-split`, `exact-split`, `percentage-split`, `shares-split`): `useEffect` deps must only include user-controlled state (`selected`, `amounts`, etc.) and `totalCents` — never `members` or `onChange` (causes infinite re-renders)
- Dark mode: class-based via `next-themes` ThemeProvider; toggle in sidebar and mobile menu
- Theme: emerald/teal accent color (OKLCH), neutral backgrounds — defined in `globals.css`
- `scripts/dev.mjs` — All-in-one dev script: starts embedded-postgres + Next.js dev server
- `next.config.ts` sets `output: "standalone"` conditionally when `DOCKER_BUILD=1` (set by `docker/Dockerfile`)
- The standalone trace follows static imports and requires but not a require whose name is computed at runtime (libsql loads its platform-native `@libsql/<target>` package that way) or a binary a package locates at runtime (Meridian finds `@anthropic-ai/claude-code/bin/claude.exe`). `docker/Dockerfile` stages the whole dependency closure of such a package with `docker/stage-runtime-deps.mjs`; stage any new package that loads native code or binaries that way there. `scripts/docker-smoke.sh` starts the Meridian proxy inside the built image to catch a missing one

## Responsive Layout Architecture

- **Sidebar**: hidden below `lg` (1024px), visible at `lg+` with `lg:sticky lg:top-0 lg:h-dvh`; `overflow-hidden` + `overflow-y-auto` on nav + `shrink-0` on bottom section
- **Outer container**: `min-h-dvh lg:flex lg:h-dvh lg:flex-row` — block flow on mobile (natural scroll), flex on desktop (contained scroll)
- **Main**: `@container flex-1 min-w-0 lg:overflow-auto` — container query context; natural scroll on mobile, contained scroll on desktop
- **Content**: `w-full py-4 px-4 md:py-6 md:px-8 2xl:mx-auto 2xl:max-w-5xl` — full width with padding, max-width only at 2xl+
- **Card grids**: use CSS container queries (`@2xl:grid-cols-2`) NOT viewport breakpoints (`lg:grid-cols-2`) — they adapt to actual available space regardless of sidebar
- **Uniform card lists**: use auto-fit grids `grid-cols-[repeat(auto-fit,minmax(280px,1fr))]` — no breakpoints needed
- **Mobile header**: `lg:hidden` with frosted glass (`backdrop-blur-md`); uses Sheet for hamburger menu
- **Never** use `overflow-hidden` on layout containers — it clips content

## Testing

### Unit Tests (Vitest)

- `npm test` — run all unit tests (~490 tests, <2s)
- Tests live co-located with source: `src/**/*.test.ts`, plus `docker/**/*.test.mjs` for the Docker build scripts
- Covers: `money.ts`, `split-calculator.ts`, `rate-limit.ts`, `upload-dir.ts`, `balance-calculator.ts`, `ai/registry.ts`, `ai/providers/openai-codex.ts`, `ai/providers/meridian.ts`, `lib/normalize-date.ts`, `lib/meridian-login.ts`, `lib/receipt-processor.ts`, `lib/auth-health-poller.ts`, `lib/openai-codex-login.ts`, `lib/auth-config.ts`, `lib/oidc-sign-in.ts`, `lib/user-email.ts`, `lib/password-login.ts`, `trpc/routers/admin.ts`, `trpc/routers/auth.ts`, `src/lib/sign-in-errors.ts`, `lib/guest-uploads.ts`, `lib/guest-join-limit.ts`, `trpc/routers/guest.ts`, `app/api/upload/route.ts`, `docker/stage-runtime-deps.mjs`

### E2E Tests (Playwright)

- `BASE_URL=http://localhost:3000 npx playwright test` — run all e2e tests
- `BASE_URL=http://localhost:3000 npx playwright test --headed` — visual testing
- `RUN_AI_TESTS=1` — enable AI-dependent tests (requires configured AI provider)
- Run `npm run dev:full` to start embedded PostgreSQL + dev server for testing
- Set `AUTH_RATE_LIMIT_MAX=9999`, `AUTH_IP_RATE_LIMIT_MAX=9999`, and `GUEST_RATE_LIMIT_MAX=9999` in `.env` to avoid rate limiting during test runs (every local login shares one IP bucket — Next.js synthesizes `x-forwarded-for` for local requests)
- E2e tests use `navigateToGroup(page, name)` helper for pagination-safe group navigation
- `createTestGroup()` auto-deletes the group on `dispose()` to avoid test pollution
- Do NOT rely on Chrome DevTools MCP viewport emulation for visual accuracy — it doesn't account for browser chrome

## i18n

- Uses `next-intl` with `createNextIntlPlugin` in `next.config.ts`
- 9 locales defined in `src/i18n/routing.ts`: en, es, sv, fr, de, pt-BR, ja, zh-CN, ko (default: en)
- All routes under `src/app/[locale]/` — the `[locale]` segment is required
- Translation files: `messages/{locale}/{namespace}.json` (namespaces: admin, auth, common, dashboard, expenses, groups, settings)
- Use `useTranslations(namespace)` in client components, `getTranslations(namespace)` in server components
- Locale-aware navigation: import `Link`, `redirect`, `usePathname`, `useRouter` from `@/i18n/navigation`
- `LanguageSwitcher` component in sidebar and mobile menu
- User locale preference stored in `User.locale` field (Prisma schema)
- `npm run lint:i18n` checks for missing or extra translation keys
- To add a new language: add locale to `src/i18n/routing.ts`, create `messages/{locale}/` with all namespace files, add display config to `languageConfig`

## Docker

All-in-one container: PostgreSQL is bundled inside — no external database required. Requires `NEXTAUTH_SECRET` and `AUTH_SECRET` env vars.

Run `npm run test:docker` before pushing a change to `docker/`, the entrypoint, `prisma/` SQL, or dependencies. It builds the image and runs `scripts/docker-smoke.sh`: fresh install on an empty volume, upgrade restarts, and the Meridian provider starting and running through the app (it signs in as an admin and calls the admin "Test Receipt Extraction" endpoint). The container gets a unique name and publishes no ports, so it's safe on a host already running ShareTab; point `DOCKER_HOST=ssh://user@host` at a remote daemon when there's no local Docker (Docker access is root-equivalent on that host). CI runs the same script on pull requests (Docker Fresh Install), and `docker.yml` pushes the image it tested only after the script passes. `--meridian-auth <dir>` adds a live receipt extraction through Meridian using a scratch copy of a Claude login directory on the Docker host (local runs only; needs a token valid for 30+ minutes, and fails if the login was refreshed during the run).

```bash
cd docker && docker compose up -d    # Start app (PostgreSQL included)
docker compose exec sharetab su-exec postgres pg_dump -U sharetab sharetab > backup.sql  # Backup
```
