# Local Dev Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `dev-start.sh` and `dev-stop.sh` scripts so the app can be run locally with a single command, without Docker, using a project-local PostgreSQL data directory.

**Architecture:** Mirror the Docker `entrypoint.sh` pattern — install PostgreSQL 16 system-wide once, then manage a project-local cluster in `.pgdata/`. `dev-start.sh` initializes the cluster on first run, starts Postgres, creates the database, sets up `.env`, pushes the Prisma schema, and launches `npm run dev`. Ctrl-C stops both. `dev-stop.sh` stops Postgres independently.

**Tech Stack:** Bash, PostgreSQL 16 (`pg_ctl`, `initdb`, `psql`, `pg_isready`), Prisma 7, Next.js 15

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `dev-start.sh` | Start Postgres + run migrations + start dev server |
| Create | `dev-stop.sh` | Stop the local Postgres cluster cleanly |
| Modify | `.gitignore` | Exclude `.pgdata/` from version control |

---

### Task 1: Update `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add `.pgdata/` to `.gitignore`**

Open `.gitignore` and add after the `# uploads` section:

```
# local dev postgres cluster
.pgdata/
```

- [ ] **Step 2: Verify**

```bash
grep -n "pgdata" .gitignore
```

Expected output:
```
57:# local dev postgres cluster
58:.pgdata/
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore local postgres data directory"
```

---

### Task 2: Create `dev-stop.sh`

**Files:**
- Create: `dev-stop.sh`

- [ ] **Step 1: Create `dev-stop.sh`**

```bash
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGDATA="$SCRIPT_DIR/.pgdata"

# Find pg_ctl
find_pg_bin() {
  if command -v "$1" &>/dev/null; then command -v "$1"; return; fi
  for ver in 16 15 14 13; do
    [ -x "/usr/lib/postgresql/$ver/bin/$1" ] && echo "/usr/lib/postgresql/$ver/bin/$1" && return
  done
  echo ""
}

PG_CTL=$(find_pg_bin pg_ctl)

if [ -z "$PG_CTL" ]; then
  echo "pg_ctl not found — PostgreSQL may not be installed."
  exit 1
fi

if "$PG_CTL" -D "$PGDATA" status > /dev/null 2>&1; then
  echo "Stopping PostgreSQL..."
  "$PG_CTL" -D "$PGDATA" stop
  echo "PostgreSQL stopped."
else
  echo "PostgreSQL is not running."
fi
```

- [ ] **Step 2: Make executable**

```bash
chmod +x dev-stop.sh
```

- [ ] **Step 3: Commit**

```bash
git add dev-stop.sh
git commit -m "feat: add dev-stop.sh to stop local postgres cluster"
```

---

### Task 3: Create `dev-start.sh`

**Files:**
- Create: `dev-start.sh`

- [ ] **Step 1: Create `dev-start.sh`**

```bash
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGDATA="$SCRIPT_DIR/.pgdata"
DB_USER="sharetab"
DB_PASSWORD="sharetab"
DB_NAME="sharetab"
PG_PORT="5432"

# ── Helpers ────────────────────────────────────────────────

find_pg_bin() {
  if command -v "$1" &>/dev/null; then command -v "$1"; return; fi
  for ver in 16 15 14 13; do
    [ -x "/usr/lib/postgresql/$ver/bin/$1" ] && echo "/usr/lib/postgresql/$ver/bin/$1" && return
  done
  echo ""
}

PG_CTL=$(find_pg_bin pg_ctl)
INITDB=$(find_pg_bin initdb)
PSQL=$(find_pg_bin psql)
PG_ISREADY=$(find_pg_bin pg_isready)

if [ -z "$PG_CTL" ] || [ -z "$INITDB" ] || [ -z "$PSQL" ] || [ -z "$PG_ISREADY" ]; then
  echo "❌ PostgreSQL tools not found. Install with:"
  echo "   sudo apt-get install -y postgresql-16"
  exit 1
fi

# ── Initialize cluster if needed ───────────────────────────

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Initializing PostgreSQL cluster at $PGDATA..."
  "$INITDB" -D "$PGDATA" --auth=trust -U postgres --no-instructions

  # Allow TCP connections from localhost
  echo "host all all 127.0.0.1/32 trust" >> "$PGDATA/pg_hba.conf"
  echo "host all all ::1/128 trust"       >> "$PGDATA/pg_hba.conf"

  # Set port
  sed -i "s/#port = 5432/port = $PG_PORT/" "$PGDATA/postgresql.conf"

  echo "PostgreSQL cluster initialized."
fi

# ── Start Postgres ──────────────────────────────────────────

if ! "$PG_CTL" -D "$PGDATA" status > /dev/null 2>&1; then
  echo "Starting PostgreSQL..."
  "$PG_CTL" -D "$PGDATA" -l "$PGDATA/logfile" start
fi

until "$PG_ISREADY" -h 127.0.0.1 -p "$PG_PORT" -U postgres -q; do
  echo "Waiting for PostgreSQL..."
  sleep 1
done
echo "PostgreSQL is ready."

# ── Create user and database ────────────────────────────────

if ! "$PSQL" -h 127.0.0.1 -p "$PG_PORT" -U postgres -tAc \
    "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  echo "Creating database user '$DB_USER'..."
  "$PSQL" -h 127.0.0.1 -p "$PG_PORT" -U postgres \
    -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"
fi

if ! "$PSQL" -h 127.0.0.1 -p "$PG_PORT" -U postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  echo "Creating database '$DB_NAME'..."
  "$PSQL" -h 127.0.0.1 -p "$PG_PORT" -U postgres \
    -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
  "$PSQL" -h 127.0.0.1 -p "$PG_PORT" -U postgres \
    -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"
fi

# ── Setup .env ──────────────────────────────────────────────

cd "$SCRIPT_DIR"

if [ ! -f ".env" ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
fi

# ── Run migrations ──────────────────────────────────────────

echo "Pushing Prisma schema..."
npx prisma db push --skip-generate 2>/dev/null || echo "Warning: Could not push schema"

# ── Stop Postgres on exit ───────────────────────────────────

cleanup() {
  echo ""
  echo "Stopping PostgreSQL..."
  "$PG_CTL" -D "$PGDATA" stop
  echo "Done."
}
trap cleanup EXIT

# ── Start dev server ────────────────────────────────────────

echo ""
echo "Starting ShareTab at http://localhost:3000"
echo "Press Ctrl-C to stop."
echo ""
npm run dev
```

- [ ] **Step 2: Make executable**

```bash
chmod +x dev-start.sh
```

- [ ] **Step 3: Commit**

```bash
git add dev-start.sh
git commit -m "feat: add dev-start.sh for local development without Docker"
```

---

### Task 4: Install PostgreSQL and do a first run

**Files:** (none — verification only)

- [ ] **Step 1: Install PostgreSQL 16**

```bash
sudo apt-get update && sudo apt-get install -y postgresql-16
```

Expected: installs without errors.

- [ ] **Step 2: Verify pg tools are findable**

```bash
find /usr/lib/postgresql -name pg_ctl
```

Expected output:
```
/usr/lib/postgresql/16/bin/pg_ctl
```

- [ ] **Step 3: Run dev-start.sh for the first time**

```bash
cd /root/workspace/sharetab
./dev-start.sh
```

Expected output (in order):
```
Initializing PostgreSQL cluster at .../sharetab/.pgdata...
PostgreSQL cluster initialized.
Starting PostgreSQL...
PostgreSQL is ready.
Creating database user 'sharetab'...
Creating database 'sharetab'...
Creating .env from .env.example...
Pushing Prisma schema...
Starting ShareTab at http://localhost:3000
```

Then Next.js dev output appears. App is reachable at `http://localhost:3000`.

- [ ] **Step 4: Verify in a second terminal — Postgres is running**

```bash
/usr/lib/postgresql/16/bin/pg_isready -h 127.0.0.1 -p 5432
```

Expected:
```
127.0.0.1:5432 - accepting connections
```

- [ ] **Step 5: Verify the database exists**

```bash
/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 5432 -U postgres -c "\l sharetab"
```

Expected: a table row for `sharetab` owned by `sharetab`.

- [ ] **Step 6: Stop with Ctrl-C and verify Postgres stops**

Press Ctrl-C in the terminal running `dev-start.sh`. Expected output:
```
Stopping PostgreSQL...
Done.
```

Then verify:
```bash
/usr/lib/postgresql/16/bin/pg_isready -h 127.0.0.1 -p 5432
```

Expected:
```
127.0.0.1:5432 - no response
```

- [ ] **Step 7: Test second run (no re-initialization)**

```bash
./dev-start.sh
```

Expected: no "Initializing" or "Creating database/user" lines — goes straight to "Starting PostgreSQL..." and then dev server.

- [ ] **Step 8: Test dev-stop.sh**

While dev-start.sh is running, open a second terminal:

```bash
cd /root/workspace/sharetab
./dev-stop.sh
```

Expected:
```
Stopping PostgreSQL...
PostgreSQL stopped.
```

- [ ] **Step 9: Test dev-stop.sh when already stopped**

```bash
./dev-stop.sh
```

Expected:
```
PostgreSQL is not running.
```
