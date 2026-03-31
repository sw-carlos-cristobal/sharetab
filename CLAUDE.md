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
npx prisma generate  # Regenerate Prisma client after schema changes
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
- `prisma/seed.ts` — Demo data seed script (run with `npm run db:seed`)
- Prisma v7: datasource URL is configured in `prisma.config.ts`, not in `schema.prisma`
- Prisma v7: PrismaClient requires `@prisma/adapter-pg` adapter in constructor
- Prisma v7: import from `@/generated/prisma/client` (not `@/generated/prisma` — no index.ts)
- shadcn/ui v4: Button uses `render` prop for polymorphism, NOT `asChild`
- shadcn/ui v4: When rendering Button as a Link, add `nativeButton={false}`
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

- Use `BASE_URL=http://localhost:3000 npx playwright test --headed` for visual testing (accurate viewport)
- Do NOT rely on Chrome DevTools MCP viewport emulation for visual accuracy — it doesn't account for browser chrome
- Responsive tests cover: static viewport sizes, live resize behavior, horizontal overflow checks, scroll verification
- Run `npm run dev:full` to start embedded PostgreSQL + dev server for testing

## Docker

All-in-one container: PostgreSQL is bundled inside — no external database required.

```bash
cd docker && docker compose up -d    # Start app (PostgreSQL included)
docker compose exec sharetab su-exec postgres pg_dump -U sharetab sharetab > backup.sql  # Backup
```

## Implementation Status

### Phase 1: Foundation — COMPLETE
- Next.js 16 + TypeScript + TailwindCSS 4 + shadcn/ui
- Prisma 7 schema (14 models: User, Account, Session, VerificationToken, Group, GroupMember, GroupInvite, Expense, ExpenseShare, Receipt, ReceiptItem, ReceiptItemAssignment, Settlement, ActivityLog)
- NextAuth v5 with email/password (bcrypt) + optional Google OAuth + optional magic link (Nodemailer)
- tRPC v11 with 8 routers (auth, groups, expenses, balances, settlements, activity, receipts, guest)
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

### Phase 3: Settlements — COMPLETE
- Settle-up dialog on group detail page (click a debt row to pre-fill)
- Records payment, invalidates balance caches
- "Settle up" button in balances card header

### Phase 4: AI Receipt Scanning — COMPLETE
- Pluggable AI provider system: `src/server/ai/provider.ts` interface
- Four implementations: OpenAI (GPT-4o), Claude (API key), Meridian (Claude Max subscription, embedded proxy), Ollama (llava) in `src/server/ai/providers/`
- Provider registry with env-based selection (`AI_PROVIDER` env var)
- Receipt upload endpoint (`POST /api/upload`) with file validation
- Receipt processing tRPC router: upload → AI extraction → ReceiptItem creation
- Item assignment UI (`src/components/receipts/item-assignment.tsx`):
  - Shows extracted items with per-member toggle buttons
  - "Split all equally" quick action
  - Live per-person total calculation with proportional tax/tip
  - Tip override field
  - Creates expense with ITEM split mode
- Scan page accessible from group detail: `/groups/[groupId]/scan`
- All 18 routes building and type-checking clean

### Phase 5: Polish & PWA — COMPLETE
- PWA manifest (`public/manifest.json`) with generated icons (192px, 512px)
- Apple web app meta tags and viewport config
- Mobile-responsive hamburger menu (`src/components/layout/mobile-header.tsx`) using Sheet
- NextAuth middleware (`src/middleware.ts`) protecting `/dashboard`, `/groups`, `/settings`
- Seed script (`prisma/seed.ts`) with 3 demo users, 2 groups, 6 expenses
  - Run with `npm run db:seed` or `npx prisma db seed`
  - Login: alice@example.com / bob@example.com / charlie@example.com, password: password123

### Phase 6: Production Ready — COMPLETE
- Unraid community template XML (`unraid/sharetab.xml`)
- Receipt image serving endpoint (`GET /api/uploads/[...path]`) with auth + path traversal protection
- Docker entrypoint script with migration on startup
- Dockerfile hardened: `--omit=dev`, cache clean, HEALTHCHECK directive, `.dockerignore`
- All 19 routes building and type-checking clean

### Pending Receipts & Placeholder Members — COMPLETE
- **Placeholder members**: Add people to groups without accounts (`User.isPlaceholder`)
  - Created via group settings with just a name
  - Appear in all split modes and receipt assignment
  - Dashed border + "Pending" badge in UI
  - Optional merge into real user when they sign up (via linked invite)
- **Pending receipts**: Save processed receipts for later assignment
  - `Receipt.groupId` + `Receipt.savedById` link receipts to groups
  - "Save for Later" button on scan page after AI processing
  - Pending receipts section on group detail page with "Resume" links
  - Resume via `/groups/[groupId]/scan?receiptId=X`
- **Merge flow**: `groups.mergePlaceholder` reassigns all FKs in a transaction
  - Auto-merge via `GroupInvite.placeholderUserId` on invite acceptance
  - Manual merge available via API
- Schema: `User.isPlaceholder`, `User.placeholderName`, `User.createdByUserId`,
  `Receipt.groupId`, `Receipt.savedById`, `GroupInvite.placeholderUserId`

### Guest Bill Splitting & Shareable Links — COMPLETE
- **Guest split flow** at `/split` — no login required:
  - Upload receipt via camera or gallery (mobile-optimized with `capture="environment"`)
  - AI processes receipt (reuses existing pluggable AI providers)
  - Add people by name (just strings, no accounts)
  - Assign items to people with tap-to-toggle buttons
  - Proportional tax/tip distribution via shared `calculateSplitTotals()` utility
  - Creates `GuestSplit` record with 7-day expiry
- **Shareable summary** at `/split/[token]`:
  - Public read-only page showing per-person breakdown
  - Copy Link + Share buttons (Web Share API with clipboard fallback)
  - Per-person item details with tax/tip breakdown
  - CTA to create account or split own bill
- **Humorous loading messages** during AI processing (both guest and authenticated flows)
  - 25 rotating messages in `src/lib/loading-messages.ts`
- **Mobile-first design**: full-width buttons, 44px+ touch targets, sticky bottom nav, camera-first UX
- **Guest upload**: `/api/upload?guest=true` bypasses auth with IP-based rate limiting (10/hr)
- Schema: `GuestSplit` model with `shareToken`, JSON columns for items/people/assignments/summary
- Routes: `/split` (static), `/split/[token]` (dynamic)

### Magic Link Auth — COMPLETE
- **Email magic link sign-in** via NextAuth Nodemailer provider
  - Enabled when `EMAIL_SERVER_HOST` env var is set
  - Sends sign-in link to email, redirects to `/verify-request` page
  - Login page toggle between password and magic link modes
- **Environment variables**: `EMAIL_SERVER_HOST`, `EMAIL_SERVER_PORT`, `EMAIL_SERVER_USER`, `EMAIL_SERVER_PASSWORD`, `EMAIL_FROM`
- Link to guest splitting from login page ("Split without an account")

### Theme & Dark Mode — COMPLETE
- Emerald/teal accent color scheme (OKLCH) with neutral backgrounds
- Dark mode support via `next-themes` (class-based, system preference default)
- Theme toggle in sidebar and mobile menu (Sun/Moon icon)
- `src/components/layout/theme-toggle.tsx` — theme toggle component

### Dashboard Improvements — COMPLETE
- **Per-person debt breakdown**: `balances.getOverallDebts` tRPC endpoint aggregates simplified debts across all groups by person, netting cross-group debts
- Dashboard shows "People who owe you" and "People you owe" cards with avatar initials, names, and amounts
- **Group search/filter**: Groups page has a search input for client-side filtering by group name

### Recent Improvements — COMPLETE
- **Receipt image zoom/pan**: `src/components/receipts/item-assignment.tsx` — scroll wheel to zoom (1x–5x), drag to pan, pinch-to-zoom on mobile, double-click to reset; zoom % indicator + Reset button
- **Settle-up From/To fields**: `SettleDialog` now shows explicit From and To dropdowns (pre-populated from debt row); `settlements.create` accepts optional `fromId` (defaults to current user)
- **Placeholder member edit/delete**: Group settings page has inline rename (pencil icon) and delete (trash icon) for placeholder members; new `groups.renamePlaceholder` tRPC mutation
- **Settings page pre-population**: Name field now syncs with session via `useEffect` so it's pre-filled on every visit
- **Meridian AI provider**: Embedded `@rynfar/meridian` proxy runs in-process, converting Claude Max subscription into standard Anthropic API (~16s receipt scans with opus). No separate container or API key needed — just mount `~/.claude/.credentials.json`. Set `AI_PROVIDER=meridian`.
- **Configurable model**: `ANTHROPIC_MODEL` env var (default: `claude-opus-4-6`) for claude/meridian providers
