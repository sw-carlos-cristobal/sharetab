FROM node:20-alpine AS base
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000

# --- Dependencies ---
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

# --- Builder ---
FROM base AS builder
WORKDIR /app
ENV DOCKER_BUILD=1
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN --mount=type=cache,target=/root/.npm npm ci --legacy-peer-deps && npm cache clean --force
COPY . .
RUN npx prisma generate
RUN npm run build

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
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/src/generated ./src/generated
# Copy OCR worker script (runs in child process, not bundled by Next.js)
COPY --from=builder /app/src/server/ai/providers/ocr-worker.mjs ./src/server/ai/providers/ocr-worker.mjs
# Copy tesseract.js for OCR fallback
COPY --from=builder /app/node_modules/tesseract.js ./node_modules/tesseract.js
# Copy meridian proxy (embedded, dynamically imported — not traced by Next.js bundler)
COPY --from=builder /app/node_modules/@rynfar/meridian ./node_modules/@rynfar/meridian
COPY --from=builder /app/node_modules/@anthropic-ai/claude-agent-sdk ./node_modules/@anthropic-ai/claude-agent-sdk
# Install Prisma CLI in isolated dir to avoid conflict with standalone node_modules
WORKDIR /prisma-cli
RUN --mount=type=cache,target=/root/.npm \
    npm init -y && \
    npm install --legacy-peer-deps prisma@7.6.0 dotenv@17.3.1 && \
    npm cache clean --force
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
ENV DATABASE_URL="postgresql://sharetab:sharetab@localhost:5432/sharetab"

VOLUME ["/var/lib/postgresql/data", "/app/uploads", "/app/claude", "/app/chatgpt"]

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
