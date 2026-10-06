#!/bin/sh
# Starts the built app on a fresh, empty database for the browser tests (npm run e2e).
# Needs: PostgreSQL reachable at E2E_DATABASE_URL's server, psql, ffmpeg, `npm run build` done.
set -e
cd "$(dirname "$0")/.."
DB_URL="${E2E_DATABASE_URL:-postgres://nx@127.0.0.1:5432/nxe2e}"
DB_NAME="${DB_URL##*/}"
ADMIN_URL="${DB_URL%/*}/postgres"
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $DB_NAME" -c "CREATE DATABASE $DB_NAME"
DATA="${E2E_DATA_DIR:-$(mktemp -d)}"
rm -rf "$DATA" && mkdir -p "$DATA"
cd apps/server
NODE_ENV=production DATABASE_URL="$DB_URL" PORT="${PORT:-8787}" NX_DATA_DIR="$DATA" \
  NX_WEB_DIR="$(cd ../web/dist && pwd)" COOKIE_SECURE=false NX_MOCK_MIN_SECONDS="${NX_MOCK_MIN_SECONDS:-4}" \
  exec node dist/main.js
