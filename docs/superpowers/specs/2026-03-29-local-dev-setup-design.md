# Local Dev Setup Design

**Date:** 2026-03-29
**Status:** Approved

## Problem

The app bundles PostgreSQL inside Docker via `entrypoint.sh`. Running `npm run dev` locally requires an external Postgres instance, which contradicts the project's self-contained design philosophy.

## Goal

A single command (`./dev-start.sh`) that starts everything needed for local development — Postgres and the Next.js dev server — with no Docker and no manual database setup.

## Approach

Mirror the Docker `entrypoint.sh` pattern for local dev: install PostgreSQL 16 system-wide (one-time), but run it against a project-local data directory (`.pgdata/`) rather than a system daemon.

## Files

### `dev-start.sh` (project root)

Responsibilities:
1. Check `pg_ctl` is available; exit with install instructions if not
2. Initialize `.pgdata/` via `initdb` if it doesn't exist
3. Create `pg_hba.conf` + `postgresql.conf` entries for local connections
4. Start Postgres pointed at `.pgdata/` on port 5432
5. Wait until `pg_isready`
6. Create the `sharetab` user and database if they don't exist
7. Copy `.env.example` → `.env` if no `.env` exists
8. Run `npx prisma migrate dev` (or `db push` as fallback)
9. Trap `EXIT` to stop Postgres on Ctrl-C, then exec `npm run dev`

### `dev-stop.sh` (project root)

Stops the Postgres process pointed at `.pgdata/` cleanly via `pg_ctl stop`.

### `.gitignore` additions

```
.pgdata/
uploads/
```

## Workflow

```
# One-time system install
sudo apt-get install -y postgresql-16

# Every dev session
./dev-start.sh     # initializes db on first run, starts postgres + dev server
# Ctrl-C stops both
```

Subsequent runs skip initdb and db creation — just start Postgres, run migrations, start Next.js.

## Credentials

Matches `.env.example` defaults — no manual config needed:
- User: `sharetab`
- Password: `sharetab`
- DB: `sharetab`
- Port: `5432`
- `DATABASE_URL`: `postgresql://sharetab:sharetab@localhost:5432/sharetab`

## Out of Scope

- Seeding demo data (user can run `npm run db:seed` manually after first start)
- Windows/macOS support (Ubuntu 24.04 target)
- Multiple Postgres versions
