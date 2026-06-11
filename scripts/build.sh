#!/usr/bin/env bash
# Full production build for Vantage (server API + web client).
# Used by render.yaml and the Dockerfile. Run from the repo root.
set -euo pipefail

echo "==> Installing & building web client"
cd web
npm ci
npm run build
cd ..

echo "==> Installing server & preparing database"
cd server
npm ci
# Pick sqlite/postgres provider from DATABASE_URL, generate client, sync schema,
# and seed (the seed no-ops if the DB already has data).
npm run deploy:db
echo "==> Building server"
npm run build
cd ..

echo "==> Build complete."
