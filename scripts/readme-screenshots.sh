#!/bin/bash
# Regenerates docs/images/ for the README from a freshly seeded database
# (app_readme), so the screenshots show the demo and nothing a test run left
# behind. Mock mode, offline. Your dev database is not touched.
#   scripts/readme-screenshots.sh        (stop `make dev` first: same ports)
# Port 3000 taken? WEB_PORT=3300 scripts/readme-screenshots.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
# Development defaults (.env.example), then the fresh database on top.
set -a
# shellcheck source=/dev/null
. "$ROOT/.env.example"
# shellcheck source=/dev/null # optional, and absent on CI
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
set +a

WEB_PORT=${WEB_PORT:-3000}
DB=app_readme
PG="postgres://%s@localhost:${POSTGRES_HOST_PORT}/$DB"
export WEB_PORT PUBLIC_APP_URL="http://localhost:$WEB_PORT"
# shellcheck disable=SC2059 # the format is the URL template above
{
  DATABASE_SUPERUSER_URL=$(printf "$PG" postgres:postgres)
  DATABASE_MIGRATOR_URL=$(printf "$PG" app_migrator:app_migrator_dev)
  DATABASE_URL=$(printf "$PG" app_user:app_user_dev)
  DATABASE_PLATFORM_URL=$(printf "$PG" app_platform:app_platform_dev)
}
export DATABASE_SUPERUSER_URL DATABASE_MIGRATOR_URL DATABASE_URL DATABASE_PLATFORM_URL
export REDIS_URL="redis://localhost:${REDIS_HOST_PORT}/3" QUEUE_PREFIX=readme
export MEDIA_STORAGE_DIR="$ROOT/.data/readme-media" APP_MODE=mock SEED_BULK_CONVERSATIONS=0

docker compose up -d --wait postgres redis >/dev/null
docker compose exec -T postgres psql -U postgres -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
docker compose exec -T redis redis-cli -n 3 flushdb >/dev/null
rm -rf "$MEDIA_STORAGE_DIR"

pnpm build >/dev/null
pnpm --filter @app/db run provision
pnpm --filter @app/api run seed
mkdir -p docs/images
(cd apps/web && pnpm exec playwright test -c playwright.readme.config.ts)

docker compose exec -T postgres psql -U postgres -qc "DROP DATABASE $DB WITH (FORCE)"
rm -rf "$MEDIA_STORAGE_DIR"
echo "docs/images updated"
