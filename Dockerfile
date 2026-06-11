# Multi-stage build: compiles the web client and server, then ships a lean
# runtime image that serves both. Works with the docker-compose Postgres or
# any external DATABASE_URL.

FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Web client
COPY web/package*.json web/
RUN cd web && npm ci
COPY web web
RUN cd web && npm run build

# Server (compile TypeScript; DB provider/client are finalized at runtime once
# DATABASE_URL is known).
COPY server/package*.json server/
RUN cd server && npm ci
COPY server server
RUN cd server && node scripts/prepare-db.js && npx prisma generate && npm run build

FROM node:20-slim AS runtime
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV WEB_DIST=/app/web/dist

COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/package*.json server/
COPY --from=build /app/server/prisma server/prisma
COPY --from=build /app/server/scripts server/scripts
COPY --from=build /app/web/dist web/dist

EXPOSE 4000
# On boot: match the Prisma provider to DATABASE_URL, sync schema, seed once
# (no-op if data already exists), then start the server.
CMD ["sh", "-c", "cd server && node scripts/prepare-db.js && npx prisma generate && npx prisma db push --skip-generate --accept-data-loss && npm run seed && node dist/index.js"]
