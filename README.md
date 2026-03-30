# ShareTab

A self-hosted, open-source alternative to Splitwise with AI-powered receipt scanning.

ShareTab makes it easy to track shared expenses with friends, roommates, or travel groups. Snap a photo of a receipt, let AI extract the line items, and assign them to group members -- taxes and tips are split proportionally. Deploy it on your own server with a single Docker command.

## Features

- **Group expense tracking** with multiple split modes (equal, percentage, shares, exact, item-level)
- **AI receipt scanning** -- photograph a receipt, AI extracts line items, assign items to group members with proportional tax/tip
- **Guest bill splitting** -- no account needed, shareable summary links
- **Pluggable AI providers** -- OpenAI (GPT-4o), Claude, or local Ollama
- **Cross-group dashboard** -- see all your balances at a glance, with per-person debt breakdown
- **Debt simplification** -- minimize the number of payments needed
- **Dark mode** -- system-aware with manual toggle
- **Invite links** -- share a link to add friends to your groups
- **Magic link auth** -- passwordless email sign-in
- **PWA** -- installable on mobile with app-like experience
- **Self-hosted** -- Docker Compose deployment, designed for Unraid

## Quick Start

ShareTab ships as an all-in-one Docker container with PostgreSQL bundled inside. No external database needed.

```bash
cd docker
cp ../.env.example .env
```

Edit `.env` with your settings -- at minimum, generate real values for `NEXTAUTH_SECRET` and `AUTH_SECRET`:

```bash
# Generate a secret
openssl rand -base64 32
```

Then start the container:

```bash
docker compose up -d
```

The app will be available at `http://localhost:3000`.

**Backups:**

```bash
docker compose exec sharetab su-exec postgres pg_dump -U sharetab sharetab > backup.sql
```

## Configuration

All configuration is done through environment variables. Copy `.env.example` to `.env` and adjust as needed.

### Required

| Variable | Description |
|---|---|
| `NEXTAUTH_SECRET` | Session encryption key. Generate with `openssl rand -base64 32`. |
| `AUTH_SECRET` | Auth.js secret. Generate the same way. |

### AI Receipt Scanning

| Variable | Description |
|---|---|
| `AI_PROVIDER` | One of `openai`, `claude`, `claude-sdk`, or `ollama`. Defaults to `openai`. |
| `OPENAI_API_KEY` | Required when `AI_PROVIDER=openai`. |
| `ANTHROPIC_API_KEY` | Required when `AI_PROVIDER=claude`. |
| `OLLAMA_BASE_URL` | Ollama server URL. Defaults to `http://localhost:11434`. |
| `OLLAMA_MODEL` | Ollama model name. Defaults to `llava`. |

The `claude-sdk` provider uses a Claude Max/Pro subscription instead of an API key -- run `claude login` first.

### OAuth (optional)

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID for "Sign in with Google". |
| `GOOGLE_CLIENT_SECRET` | Corresponding client secret. |

### Other

| Variable | Default | Description |
|---|---|---|
| `NEXTAUTH_URL` | `http://localhost:3000` | Public URL of your instance. |
| `UPLOAD_DIR` | `./uploads` | Directory for receipt image uploads. |
| `MAX_UPLOAD_SIZE_MB` | `10` | Maximum upload file size. |
| `LOG_LEVEL` | `info` | Logging verbosity: `debug`, `info`, `warn`, or `error`. |

## Development

```bash
# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Start a dev database (option A: embedded-postgres, no Docker needed)
node scripts/start-test-db.mjs

# Start a dev database (option B: Docker)
docker compose -f docker/docker-compose.yml up db -d

# Push the schema to the database
npx prisma db push

# Seed demo data (optional)
npm run db:seed

# Start dev server
npm run dev
```

Demo accounts after seeding: `alice@example.com`, `bob@example.com`, `charlie@example.com` (password: `password123`).

Note: if you use the embedded-postgres script, the schema push and seed are run automatically.

## Contributing

Contributions are welcome. If you find a bug or have a feature request, please [open an issue](../../issues). Pull requests are appreciated -- feel free to pick up any open issue.

## License

MIT
