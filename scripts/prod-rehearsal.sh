#!/bin/bash
# Rehearse the production stack locally, offline, before it ever reaches AWS:
# the production images, deploy/compose.prod.yaml, the Caddyfile and the
# backup and restore scripts, with separate database passwords as on the
# instance. Mock mode, so nothing leaves the machine. What it proves:
#
#   1. provision and every service come up healthy within their memory limits
#   2. Caddy serves HTTPS (its local CA for "localhost") with HSTS
#   3. sign-in through Caddy sets a Secure session cookie; /api/me answers
#   4. the inbox socket upgrades to WebSocket through Caddy (D-051)
#   5. only Caddy publishes ports
#   6. backup, restore drill, and a full --replace-production restore
#   7. a client cannot choose its own address: spoofed X-Real-IP is replaced
#   8. the demo's simulator page needs its password, and a customer message
#      sent through it (via Caddy) is answered by the assistant (D-113)
#
#   make rehearsal        (needs Docker; builds the images first)
# Ports: 8081 and 8443 unless REHEARSAL_HTTP_PORT / REHEARSAL_HTTPS_PORT are set.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
export COMPOSE_PROJECT=support-desk-rehearsal
HTTPS_PORT=${REHEARSAL_HTTPS_PORT:-8443}
HTTP_PORT=${REHEARSAL_HTTP_PORT:-8081}
BASE="https://localhost:$HTTPS_PORT"
WORK=$(mktemp -d)
export APP_ENV=$WORK/app.env
export BACKUP_LOCAL_DIR=$WORK/backups BACKUP_S3_PREFIX="" CONFIRM=yes
PASSWORD=rehearsal-password-1
DEMO_PASSWORD=rehearsal-demo-password-1
SIM="https://sim.localhost:${REHEARSAL_HTTPS_PORT:-8443}"

# shellcheck source=deploy/bin/lib.sh
. "$ROOT/deploy/bin/lib.sh"

cleanup() {
  dc --profile ops down --volumes --remove-orphans >/dev/null 2>&1 || true
  # Postgres and Redis files belong to container users: remove them from a container.
  docker run --rm -v "$WORK:/work" alpine:3.22 rm -rf /work/data >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() {
  log "FAIL: $*"
  dc logs --tail 40 >&2 || true
  exit 1
}
step() { log "== $*"; }
hexkey() { openssl rand -hex "$1"; }

step "building the production images"
docker compose -f "$ROOT/compose.yaml" --profile app build api worker web simulator >/dev/null
for app in api worker web simulator; do
  docker tag "support-desk-$app" "rehearsal.local/support-desk/$app:rehearsal"
done

cat >"$APP_ENV" <<ENV
APP_MODE=mock
LOG_LEVEL=warn
IMAGE_TAG=rehearsal
ECR_REGISTRY=rehearsal.local
DOMAIN=localhost
PUBLIC_APP_URL=$BASE
DATA_DIR=$WORK/data
HTTP_PORT=$HTTP_PORT
HTTPS_PORT=$HTTPS_PORT
AWS_REGION=ap-south-1
MEDIA_BUCKET=rehearsal-unused
BEDROCK_CHAT_MODEL=mock
BEDROCK_EMBED_MODEL=mock
POSTGRES_PASSWORD=$(hexkey 24)
DB_MIGRATOR_PASSWORD=$(hexkey 24)
DB_USER_PASSWORD=$(hexkey 24)
DB_PLATFORM_PASSWORD=$(hexkey 24)
BETTER_AUTH_SECRET=$(hexkey 32)
CREDENTIALS_KEY=$(openssl rand -base64 32)
META_APP_SECRET=$(hexkey 16)
META_VERIFY_TOKEN=$(hexkey 16)
SEED_PASSWORD=$PASSWORD
SIMULATOR_ACCESS_TOKEN=$(hexkey 24)
SIMULATOR_APP_SECRET=$(hexkey 24)
SIMULATOR_VERIFY_TOKEN=$(hexkey 24)
SIM_DOMAIN=sim.localhost
DEMO_USER=demo
DEMO_PASSWORD_HASH_B64=$(printf '%s' "$DEMO_PASSWORD" | docker run --rm -i caddy:2.11.9 caddy hash-password | tail -n 1 | base64 -w0)
DEMO_AUTH_FILE=$WORK/demo-auth.caddy
ENV
export DEMO_AUTH_FILE=$WORK/demo-auth.caddy
render_demo_auth
mkdir -p "$WORK/data/postgres" "$WORK/data/redis" "$WORK/data/caddy" "$BACKUP_LOCAL_DIR"

step "1. provision, seed and start (as deploy/bin/deploy does)"
dc up --wait postgres redis >/dev/null 2>&1 || fail "postgres and redis did not start"
dc run --rm provision >/dev/null || fail "provision failed"
dc run --rm seed >/dev/null || fail "seed failed"
dc up --detach --wait --wait-timeout 180 >/dev/null 2>&1 || fail "the stack did not become healthy"
# shellcheck disable=SC2046 # one argument per container ID
docker stats --no-stream --format '  {{.Name}}: {{.MemUsage}}' $(dc ps --quiet) |
  sed "s/$COMPOSE_PROJECT-//" >&2

step "2. HTTPS through Caddy, with HSTS"
headers=$(curl -sk -o /dev/null -D - "$BASE/health") || fail "no answer on $BASE"
grep -q '^HTTP/[0-9.]* 200' <<<"$headers" || fail "web /health through Caddy: $(head -1 <<<"$headers")"
grep -qi '^strict-transport-security: max-age=31536000' <<<"$headers" || fail "no HSTS header"

step "3. sign-in sets a Secure cookie; /api/me answers"
sign_in() {
  curl -sk -o /dev/null -D - -X POST "$BASE/api/auth/sign-in/email" \
    -H "origin: $BASE" -H 'content-type: application/json' "$@"
}
login=$(sign_in -d "{\"email\":\"anil@qamar.example\",\"password\":\"$PASSWORD\"}")
grep -q '^HTTP/[0-9.]* 200' <<<"$login" || fail "sign-in: $(head -1 <<<"$login")"
grep -i '^set-cookie:' <<<"$login" | grep -qi 'secure' || fail "the session cookie is not Secure"
cookie=$(grep -i '^set-cookie:' <<<"$login" | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]*).*/\1/' | paste -sd ';' -)
[ "$(curl -sk -o /dev/null -w '%{http_code}' -b "$cookie" "$BASE/api/me")" = 200 ] || fail "/api/me with the session"

step "4. the inbox socket upgrades to WebSocket through Caddy"
upgrade=$(curl -sk --http1.1 -i -N --max-time 3 -b "$cookie" \
  -H "origin: $BASE" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$BASE/api/socket.io?EIO=4&transport=websocket" 2>/dev/null || true)
grep -q '^HTTP/1.1 101' <<<"$upgrade" || fail "no WebSocket upgrade: $(head -1 <<<"$upgrade")"

step "5. only Caddy publishes ports"
published=$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
  --format '{{.Label "com.docker.compose.service"}} {{.Ports}}' | grep -- '->' | cut -d' ' -f1 | sort -u)
[ "$published" = caddy ] || fail "services with published ports: $published"

step "6. backup, restore drill, and a full restore"
dump=$("$ROOT/deploy/bin/backup" | tail -n 1)
drill=$("$ROOT/deploy/bin/restore" --into app_restore_check --check --drop-after "$dump" 2>&1) ||
  fail "restore drill: $drill"
grep 'check passed' <<<"$drill" >&2 || fail "restore drill did not check: $drill"
"$ROOT/deploy/bin/restore" --replace-production "$dump" >/dev/null 2>&1 || fail "replace-production restore"
login=$(sign_in -d "{\"email\":\"anil@qamar.example\",\"password\":\"$PASSWORD\"}")
grep -q '^HTTP/[0-9.]* 200' <<<"$login" || fail "sign-in after the full restore"

step "7. a spoofed X-Real-IP does not escape the sign-in limit"
status=
for i in 1 2 3 4 5 6; do
  status=$(sign_in -H "x-real-ip: 203.0.113.$i" -d '{"email":"anil@qamar.example","password":"wrong-password-1"}' |
    head -1 | cut -d' ' -f2)
done
[ "$status" = 429 ] || fail "six wrong passwords from 'different' addresses were not limited (last: $status)"

step "8. the demo page needs its password, and a customer message through it is answered"
sim() { curl -sk --resolve "sim.localhost:$HTTPS_PORT:127.0.0.1" "$@"; }
[ "$(sim -o /dev/null -w '%{http_code}' "$SIM/")" = 401 ] || fail "the demo page answered without a password"
[ "$(sim -o /dev/null -w '%{http_code}' -u "demo:wrong-password" "$SIM/")" = 401 ] || fail "a wrong demo password was accepted"
[ "$(sim -o /dev/null -w '%{http_code}' -u "demo:$DEMO_PASSWORD" "$SIM/")" = 200 ] || fail "the demo page refused the right password"
rafi=AE.40000000000000000003
# Replies on Rafi's simulated phone (grep finds none at first: not an error).
replies() { sim -u "demo:$DEMO_PASSWORD" "$SIM/control/threads/$rafi" | { grep -o '"direction":"out"' || true; } | wc -l; }
before=$(replies)
sent=$(sim -o /dev/null -w '%{http_code}' -u "demo:$DEMO_PASSWORD" -H 'content-type: application/json' \
  -d "{\"customerId\":\"$rafi\",\"text\":\"Do you repair screens?\"}" "$SIM/control/messages")
[ "$sent" = 202 ] || fail "sending as a customer through the demo page: HTTP $sent"
for _ in $(seq 1 30); do
  after=$(replies)
  [ "$after" -gt "$before" ] && break
  sleep 1
done
[ "$after" -gt "$before" ] || fail "the assistant's reply never reached the simulated phone"

log "rehearsal passed"
