# Splitit

Open-source, self-hosted Splitwise alternative with AI-powered receipt scanning.

## Features

- **Group expense tracking** with multiple split modes (equal, percentage, shares, exact, item-level)
- **AI receipt scanning** — photograph a receipt, AI extracts line items, assign items to group members with proportional tax/tip
- **Pluggable AI providers** — OpenAI (GPT-4o), Claude, or local Ollama
- **Cross-group dashboard** — see all your balances at a glance
- **Debt simplification** — minimize the number of payments needed
- **Invite links** — share a link to add friends to your groups
- **PWA** — installable on mobile with app-like experience
- **Self-hosted** — Docker Compose deployment, designed for Unraid

## Screenshots

> Coming soon — the app is in active development.

## Quick Start (Docker)

All-in-one container — PostgreSQL is bundled inside, no external database needed.

```bash
cd docker
cp ../.env.example .env
# Edit .env with your settings (at minimum set NEXTAUTH_SECRET/AUTH_SECRET)
docker compose up -d
```

The app will be available at `http://localhost:3000`.

**Backup:** `docker compose exec splitit su-exec postgres pg_dump -U splitit splitit > backup.sql`

## Development

```bash
# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Start PostgreSQL (requires Docker)
docker compose -f docker/docker-compose.yml up db -d

# Run database migrations
npx prisma migrate dev

# Seed demo data (optional)
npm run db:seed

# Start dev server
npm run dev
```

Demo accounts after seeding: `alice@example.com`, `bob@example.com`, `charlie@example.com` (password: `password123`)

## Project Structure

```
src/
├── app/                    # Next.js App Router
│   ├── (auth)/             # Login, register pages
│   ├── (app)/              # Authenticated pages (dashboard, groups, expenses, settings)
│   ├── api/                # API routes (auth, tRPC, health, upload)
│   └── invite/[token]/     # Invite join page
├── components/
│   ├── ui/                 # shadcn/ui primitives
│   ├── layout/             # Sidebar, navigation
│   ├── groups/             # Group-specific components
│   └── expenses/           # Split mode components (equal, exact, percentage, shares)
├── server/
│   ├── auth.ts             # NextAuth v5 configuration
│   ├── db.ts               # Prisma client singleton
│   └── trpc/               # tRPC routers (auth, groups, expenses, balances, settlements, activity)
├── lib/                    # Client utilities (tRPC hooks, money formatting)
└── generated/prisma/       # Auto-generated Prisma client (gitignored)
```

## Tech Stack

- **Next.js 15** (App Router) + TypeScript
- **tRPC v11** — end-to-end type-safe API
- **Prisma 7** + PostgreSQL (via `@prisma/adapter-pg`)
- **NextAuth v5** — email/password + OAuth
- **TailwindCSS 4** + shadcn/ui
- **Docker** — multi-stage build for production

## Roadmap

- [x] Foundation (auth, database schema, tRPC API, Docker)
- [x] Groups & Expenses UI (CRUD, 4 split modes, invites, balances)
- [x] Settlement recording UI
- [x] AI receipt scanning with item-level delegation (OpenAI, Claude, Ollama)
- [x] PWA support + mobile hamburger menu
- [x] Auth middleware + demo seed data
- [x] Unraid community template + production Docker hardening

## License

MIT
