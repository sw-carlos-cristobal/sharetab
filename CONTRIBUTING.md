# Contributing to ShareTab

Thanks for your interest in contributing! Here's everything you need to get started.

## Dev Environment Setup

### Prerequisites

- Node.js 20+
- npm 10+
- Git

### Install dependencies

```bash
git clone https://github.com/sw-carlos-cristobal/sharetab.git
cd sharetab
npm install
npx prisma generate
```

### Start the dev server

The easiest way is the all-in-one script — it starts an embedded PostgreSQL instance and the Next.js dev server together:

```bash
npm run dev:full
```

Or if you have your own PostgreSQL running, copy `.env.example` to `.env`, set `DATABASE_URL`, then:

```bash
npm run dev
```

### Seed demo data

```bash
npm run db:seed
```

This creates three demo users you can log in with:

| Email | Password |
|---|---|
| alice@example.com | password123 |
| bob@example.com | password123 |
| charlie@example.com | password123 |

## Running Tests

### Unit tests

```bash
npm test
```

Runs ~222 fast Vitest tests (under 1 second). These cover money utilities, split calculations, balance computation, AI providers, admin routes, and more.

### E2E tests

```bash
npm run dev:full   # in one terminal
BASE_URL=http://localhost:3000 npx playwright test   # in another
```

Tip: set `AUTH_RATE_LIMIT_MAX=9999` and `GUEST_RATE_LIMIT_MAX=9999` in `.env` to avoid rate limiting during test runs.

### Linting

```bash
npm run lint
```

## Making Changes

### Prisma schema changes

After editing `prisma/schema.prisma`:

```bash
npx prisma db push      # apply to dev DB
npx prisma generate     # regenerate the client
```

**Breaking schema changes** (enum conversions, column type changes, data migrations) can't be handled by `prisma db push` alone. For these, add an idempotent `.sql` file in `prisma/migrations/`. The Docker entrypoint runs all `*.sql` files in that directory before `prisma db push`, so they execute automatically on container startup. Name the file descriptively (e.g., `guest_split_status_enum.sql`) and make it safe to re-run.

### Adding a tRPC route

Routers live in `src/server/trpc/routers/`. Add your procedure there and wire it into `src/server/trpc/router.ts`.

## Pull Request Guidelines

- **One concern per PR** — bug fixes, features, and refactors should be separate PRs.
- **Describe what and why** — the PR description should explain the motivation, not just restate the diff.
- **Add tests** — new logic should have unit tests where possible; new user flows should have e2e coverage.
- **Pass CI** — make sure `npm run lint`, `npm test`, and `npm run build` all pass before opening a PR.
- **Conventional commits** — use prefixes like `feat:`, `fix:`, `chore:`, `docs:`, `refactor:` in commit messages.

## Project Structure

```
src/
  app/           # Next.js App Router pages
  components/    # React components (organized by domain)
  server/        # tRPC routers, Prisma client, auth, AI providers
  lib/           # Shared utilities (money, splits, etc.)
prisma/
  schema.prisma  # Database schema
docker/          # Dockerfile + docker-compose
```

See [CLAUDE.md](CLAUDE.md) for a full architecture reference.

## Questions?

Open a [GitHub Discussion](https://github.com/sw-carlos-cristobal/sharetab/discussions) or file an issue.
