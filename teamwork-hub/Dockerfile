
# Teamwork Hub — production image (one image, three commands):
#   web:      pnpm start                (default CMD; listens on $PORT, default 3000)
#   worker:   pnpm jobs:work            (background job worker)
#   migrate:  pnpm db:migrate           (run before each deploy; safe to re-run)
#
# Why not `output: "standalone"`: the worker and migrations run the TypeScript sources with tsx
# and need the full production dependency tree, so one image with production node_modules serves
# web + worker + migrations with identical code. Dev dependencies are not in the final image.
#
# Build:  docker build -t teamwork-hub .        (context = this directory)
# Run:    docker run --env-file .env -p 3000:3000 teamwork-hub

ARG NODE_VERSION=22.22.0
ARG PNPM_VERSION=10.28.0

# ---------- base: Node + pnpm (installed globally so the non-root runtime user can run it) ----------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app

# ---------- deps: full install (build needs dev deps: typescript, tailwind, eslint config) ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- prod-deps: production dependencies only ----------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---------- build ----------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time placeholders only: pages render per request, nothing touches the database while
# building. Real values come from the runtime environment.
RUN DATABASE_URL=postgres://build:build@localhost:5432/build \
    SESSION_SECRET=build-time-placeholder-not-a-secret-000000000000 \
    APP_MODE=production NODE_ENV=production \
    pnpm build

# ---------- runtime ----------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# tini: proper signal handling so the worker drains on SIGTERM during deploys.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/.next ./.next
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.ts tsconfig.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node drizzle ./drizzle
# Drop the build cache and the local-storage dir; uploads go to S3 (STORAGE_BACKEND=s3) or a
# mounted disk at STORAGE_DIR.
RUN rm -rf .next/cache && mkdir -p /app/.storage && chown node:node /app/.storage

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "exec node_modules/.bin/next start -p ${PORT:-3000} -H ${HOSTNAME:-0.0.0.0}"]
