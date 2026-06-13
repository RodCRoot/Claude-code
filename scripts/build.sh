#!/usr/bin/env bash
# Full production build for Vantage (server API + web client).
# Used by render.yaml and the Dockerfile. Run from the repo root.
set -euo pipefail

# Build tooling (TypeScript, Vite, Prisma CLI, ts-node) lives in devDependencies.
# Hosts that set NODE_ENV=production make `npm ci` skip devDependencies, so force
# them in for the build regardless of environment.
export NPM_CONFIG_INCLUDE=dev
export NPM_CONFIG_PRODUCTION=false

echo "==> Installing & building web client"
cd web
npm ci --include=dev
npm run build
cd ..

echo "==> Installing server & preparing database"
cd server
npm ci --include=dev
# Pick sqlite/postgres provider from DATABASE_URL, generate client, sync schema,
# and seed (the seed no-ops if the DB already has data).
npm run deploy:db
echo "==> Building server"
npm run build
cd ..

echo "==> Build complete."
