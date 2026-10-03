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

echo "==> Installing server & generating Prisma client"
cd server
npm ci --include=dev
# Pick sqlite/postgres provider from DATABASE_URL and generate the client the
# TypeScript build compiles against. Schema sync + seed happen at STARTUP
# (npm run start:deploy) — Render's build environment has no route to the
# private-network database, so touching it here fails the build.
node scripts/prepare-db.js
npx prisma generate
echo "==> Building server"
npm run build
cd ..

echo "==> Build complete."
