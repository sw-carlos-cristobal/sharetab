# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ShareTab — open-source, self-hosted Splitwise alternative with AI receipt scanning. Targets Unraid (Docker).

## Tech Stack

- **Framework:** Next.js 16 (App Router) + TypeScript
- **API:** tRPC v11 (end-to-end type-safe)
- **ORM:** Prisma 7 + PostgreSQL 16 (via `@prisma/adapter-pg`)
- **Auth:** NextAuth v5 (email/password + OAuth)
- **UI:** TailwindCSS 4 + shadcn/ui (v4, uses `@base-ui/react` — use `render` prop instead of `asChild`) + next-themes (dark mode)
- **AI:** Pluggable providers (OpenAI, Claude, Meridian, Ollama) via `src/server/ai/`

## Commands

```bash
npm run dev          # Start dev server (turbopack)
npm run dev:full     # Start embedded PostgreSQL + dev server (all-in-one)
npm run build        # Production build
npm run start        # Start production server
npm run lint         # ESLint
npm test             # Run unit tests (Vitest)
npm run test:watch   # Unit tests in watch mode
npm run test:e2e     # Run Playwright e2e tests
npx prisma generate  # Regenerate Prisma client after schema changes
npx prisma db push   # Push schema without migration (dev only)
```

## Architecture

- `src/server/` — Backend: auth config, Prisma client, tRPC routers, AI providers, pure calculation libs
- `src/server/db.ts` — Prisma client singleton (uses `@prisma/adapter-pg` with `PrismaPg`)
- `src/server/auth.ts` — NextAuth v5 config (Credentials + optional Google OAuth)
- `src/server/trpc/init.ts` — tRPC context, `publicProcedure`, `protectedProcedure`, `groupMemberProcedure`
- `src/server/trpc/router.ts` — Root app router (exports `AppRouter` type)
- `src/server/trpc/routers/` — Individual routers: auth, groups, expenses, balances, settlements, activity, receipts, guest
- `src/server/lib/balance-calculator.ts` — Pure functions for debt simplification and balance computation (extracted for testability)
- `src/app/` — Next.js App Router pages. `(auth)/` for login/register, `(app)/` for authenticated pages
- `src/components/` — React components organized by domain
- `src/components/providers.tsx` — Client-side tRPC + React Query + SessionProvider + ThemeProvider wrapper
- `src/lib/trpc.ts` — Client-side tRPC React hooks
- `src/lib/utils.ts` — `cn()` utility for Tailwind class merging
- `src/generated/prisma/` — Auto-generated Prisma client (do not edit, gitignored)
- `prisma/schema.prisma` — Database schema (money stored as Int cents)
- `prisma.config.ts` — Prisma v7 config (datasource URL lives here, not in schema.prisma)
- `docker/` — Dockerfile (multi-stage) + docker-compose.yml

## Key Conventions

- All monetary amounts are stored as integers in cents (e.g., $12.99 = 1299)
- tRPC routers live in `src/server/trpc/routers/`
- `protectedProcedure` requires auth; `groupMemberProcedure` requires group membership
- AI providers implement the `AIProvider` interface in `src/server/ai/provider.ts`
- `src/middleware.ts` — NextAuth middleware protecting authenticated routes
- `prisma/seed.ts` — Demo data seed script (run with `npm run db:seed`); idempotent — skips if data already exists
- Prisma v7: datasource URL is configured in `prisma.config.ts`, not in `schema.prisma`
- Prisma v7: PrismaClient requires `@prisma/adapter-pg` adapter in constructor
- Prisma v7: import from `@/generated/prisma/client` (not `@/generated/prisma` — no index.ts)
- shadcn/ui v4: Button uses `render` prop for polymorphism, NOT `asChild`
- shadcn/ui v4: When rendering Button as a Link, add `nativeButton={false}` — **every** `render={<Link>}` needs this
- Split components (`equal-split`, `exact-split`, `percentage-split`, `shares-split`): `useEffect` deps must only include user-controlled state (`selected`, `amounts`, etc.) and `totalCents` — never `members` or `onChange` (causes infinite re-renders)
- Dark mode: class-based via `next-themes` ThemeProvider; toggle in sidebar and mobile menu
- Theme: emerald/teal accent color (OKLCH), neutral backgrounds — defined in `globals.css`
- `scripts/dev.mjs` — All-in-one dev script: starts embedded-postgres + Next.js dev server
- `next.config.ts` has `output: "standalone"` for Docker builds

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
- `npm test` — run all unit tests (~59 tests, <1s)
- Tests live co-located with source: `src/**/*.test.ts`
- Covers: `money.ts`, `split-calculator.ts`, `rate-limit.ts`, `upload-dir.ts`, `balance-calculator.ts`, `ai/registry.ts`

### E2E Tests (Playwright)
- `BASE_URL=http://localhost:3000 npx playwright test` — run all e2e tests
- `BASE_URL=http://localhost:3000 npx playwright test --headed` — visual testing
- `RUN_AI_TESTS=1` — enable AI-dependent tests (requires configured AI provider)
- Run `npm run dev:full` to start embedded PostgreSQL + dev server for testing
- Set `AUTH_RATE_LIMIT_MAX=9999` in `.env` to avoid rate limiting during test runs
- E2e tests use `navigateToGroup(page, name)` helper for pagination-safe group navigation
- `createTestGroup()` auto-deletes the group on `dispose()` to avoid test pollution
- Do NOT rely on Chrome DevTools MCP viewport emulation for visual accuracy — it doesn't account for browser chrome

## Docker

All-in-one container: PostgreSQL is bundled inside — no external database required.

```bash
cd docker && docker compose up -d    # Start app (PostgreSQL included)
docker compose exec sharetab su-exec postgres pg_dump -U sharetab sharetab > backup.sql  # Backup
```
