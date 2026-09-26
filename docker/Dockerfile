FROM node:22-alpine AS base
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000

# --- Builder ---
FROM base AS builder
WORKDIR /app
ENV DOCKER_BUILD=1
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --legacy-peer-deps
# The standalone trace can't follow what Meridian loads at runtime: libsql's
# platform-native package (a computed require of @libsql/<target>) and the
# Claude Code binary it locates. So stage Meridian's whole dependency closure
# into /runtime-deps, outside /app so the build never sees it, for the runner
# (see docker/stage-runtime-deps.mjs). Meridian hands the agent SDK the binary
# it locates itself, @anthropic-ai/claude-code/bin/claude.exe (placed there by
# claude-code's postinstall, as a hardlink or a copy), so the Linux binary
# packages of both (each over 200 MiB) are left out.
COPY docker/stage-runtime-deps.mjs ./docker/
RUN node docker/stage-runtime-deps.mjs /runtime-deps @rynfar/meridian \
      --exclude '@anthropic-ai/claude-agent-sdk-linux-*' \
      --exclude '@anthropic-ai/claude-code-linux-*'
COPY . .
RUN npx prisma generate
RUN npm run build
ARG COMMIT_SHA=unknown
RUN echo "$COMMIT_SHA" > .commit-sha

# --- Runner ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install PostgreSQL
# hadolint ignore=DL3018
RUN apk add --no-cache postgresql16 postgresql16-contrib su-exec

# Create users
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy app
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.commit-sha ./.commit-sha
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/src/generated ./src/generated
# Meridian proxy and its dependencies (staged in the builder, see above)
COPY --from=builder /runtime-deps/node_modules ./node_modules
# Install Prisma CLI in isolated dir to avoid conflict with standalone node_modules
WORKDIR /prisma-cli
RUN npm init -y && \
    npm install --legacy-peer-deps prisma@7.6.0 dotenv@17.3.1
WORKDIR /app

COPY docker/entrypoint.sh /app/entrypoint.sh
COPY docker/claude /usr/local/bin/claude

# Create directories
RUN mkdir -p /app/uploads/receipts /app/chatgpt /var/lib/postgresql/data /run/postgresql && \
    chown -R nextjs:nodejs /app/uploads && \
    chown -R nextjs:nodejs /app/chatgpt && \
    chown -R postgres:postgres /var/lib/postgresql/data /run/postgresql && \
    chmod +x /app/entrypoint.sh /usr/local/bin/claude

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV PGDATA=/var/lib/postgresql/data

VOLUME ["/var/lib/postgresql/data", "/app/uploads", "/app/claude", "/app/chatgpt"]

# start-period covers first-boot initdb + user creation + schema push
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
