# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Splitit — open-source, self-hosted Splitwise alternative with AI receipt scanning. Targets Unraid (Docker).

## Tech Stack

- **Framework:** Next.js 15 (App Router) + TypeScript
- **API:** tRPC v11 (end-to-end type-safe)
- **ORM:** Prisma 7 + PostgreSQL 16 (via `@prisma/adapter-pg`)
- **Auth:** NextAuth v5 (email/password + OAuth)
- **UI:** TailwindCSS 4 + shadcn/ui (v4, uses `@base-ui/react` — use `render` prop instead of `asChild`)
- **AI:** Pluggable providers (OpenAI, Claude, Ollama) — not yet implemented

## Commands

```bash
npm run dev          # Start dev server (turbopack)
npm run build        # Production build
npm run start        # Start production server
npm run lint         # ESLint
npx prisma generate  # Regenerate Prisma client after schema changes
npx prisma migrate dev --name <name>  # Create migration
npx prisma db push   # Push schema without migration (dev only)
```

## Architecture

- `src/server/` — Backend: auth config, Prisma client, tRPC routers, AI providers, pure calculation libs
- `src/server/db.ts` — Prisma client singleton (uses `@prisma/adapter-pg` with `PrismaPg`)
- `src/server/auth.ts` — NextAuth v5 config (Credentials + optional Google OAuth)
- `src/server/trpc/init.ts` — tRPC context, `publicProcedure`, `protectedProcedure`, `groupMemberProcedure`
- `src/server/trpc/router.ts` — Root app router (exports `AppRouter` type)
- `src/server/trpc/routers/` — Individual routers: auth, groups, expenses, balances, settlements, activity
- `src/app/` — Next.js App Router pages. `(auth)/` for login/register, `(app)/` for authenticated pages
- `src/components/` — React components organized by domain
- `src/components/providers.tsx` — Client-side tRPC + React Query + SessionProvider wrapper
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
- AI providers will implement the `AIProvider` interface in `src/server/ai/provider.ts`
- Prisma v7: datasource URL is configured in `prisma.config.ts`, not in `schema.prisma`
- Prisma v7: PrismaClient requires `@prisma/adapter-pg` adapter in constructor
- Prisma v7: import from `@/generated/prisma/client` (not `@/generated/prisma` — no index.ts)
- shadcn/ui v4: Button uses `render` prop for polymorphism, NOT `asChild`
- `next.config.ts` has `output: "standalone"` for Docker builds

## Docker

```bash
cd docker && docker compose up -d    # Start app + PostgreSQL
docker compose exec db pg_dump -U splitit splitit > backup.sql  # Backup
```

## Implementation Status

### Phase 1: Foundation — COMPLETE
- Next.js 15 + TypeScript + TailwindCSS 4 + shadcn/ui
- Prisma 7 schema (14 models: User, Account, Session, VerificationToken, Group, GroupMember, GroupInvite, Expense, ExpenseShare, Receipt, ReceiptItem, ReceiptItemAssignment, Settlement, ActivityLog)
- NextAuth v5 with email/password (bcrypt) + optional Google OAuth
- tRPC v11 with 6 routers (auth, groups, expenses, balances, settlements, activity)
- Auth pages (login, register)
- Dashboard page with balance summary + group list
- App layout with sidebar navigation
- Health check endpoint (`/api/health`)
- Docker multi-stage Dockerfile + docker-compose.yml
- Production build passes (`npm run build`)

### Phase 2: Groups & Expenses UI — COMPLETE
- Groups: list, create, detail (with members + balances + expenses), settings (edit/delete)
- Expenses: create with 4 split modes (equal, exact, percentage, shares), detail view, delete
- Split mode components: `src/components/expenses/{equal,exact,percentage,shares}-split.tsx`
- Invite system: generate link dialog, join-by-invite page (`/invite/[token]`)
- Group detail page shows simplified debts and paginated expense list
- Settings page for user profile
- Shared money utilities in `src/lib/money.ts`
- All 15 routes building and type-checking clean

### Phase 3: Balances & Settlements — NOT STARTED
### Phase 4: AI Receipt Scanning — NOT STARTED
### Phase 5: Polish & PWA — NOT STARTED
### Phase 6: Production Ready — NOT STARTED
