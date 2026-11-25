#!/bin/bash
# Shared by the scripts in deploy/bin. Sourced, not run.

RELEASE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
APP_ENV=${APP_ENV:-/etc/support-desk/app.env}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}

# docker compose against the production stack, as deployed. The project
# name differs only in the local rehearsal (scripts/prod-rehearsal.sh).
dc() {
  docker compose -p "${COMPOSE_PROJECT:-support-desk}" -f "$RELEASE_DIR/deploy/compose.prod.yaml" --env-file "$APP_ENV" "$@"
}

# Write every parameter under $SSM_PATH to $APP_ENV as NAME=value, plus the
# host's own values. Mode 600: it holds the secrets.
render_env() {
  local tag=$1 tmp
  tmp=$(mktemp)
  chmod 600 "$tmp"
  aws ssm get-parameters-by-path --region "$AWS_REGION" --path "$SSM_PATH" \
    --recursive --with-decryption --query 'Parameters[].[Name,Value]' --output text |
    while IFS=$'\t' read -r name value; do
      # Compose would expand $ in values and a newline would split them;
      # generated secrets never contain either (infra/scripts/put-secrets.sh).
      case $value in *'$'* | *$'\n'*) die "${name##*/} contains \$ or a newline" ;; esac
      printf '%s=%s\n' "${name##*/}" "$value"
    done >"$tmp"
  {
    printf 'IMAGE_TAG=%s\n' "$tag"
    printf 'ECR_REGISTRY=%s\n' "$ECR_REGISTRY"
    printf 'DOMAIN=%s\n' "$DOMAIN"
  } >>"$tmp"
  for required in POSTGRES_PASSWORD DB_MIGRATOR_PASSWORD DB_USER_PASSWORD DB_PLATFORM_PASSWORD \
    BETTER_AUTH_SECRET CREDENTIALS_KEY META_APP_SECRET META_VERIFY_TOKEN APP_MODE PUBLIC_APP_URL \
    SIMULATOR_ACCESS_TOKEN SIMULATOR_APP_SECRET SIMULATOR_VERIFY_TOKEN \
    SIM_DOMAIN DEMO_USER DEMO_PASSWORD_HASH_B64; do
    grep -q "^$required=" "$tmp" || die "$required is missing under $SSM_PATH (infra/scripts/put-secrets.sh)"
  done
  mkdir -p "$(dirname "$APP_ENV")"
  mv "$tmp" "$APP_ENV"
}

# Caddy's basic_auth block for the demo (D-113), from $APP_ENV. The bcrypt hash
# contains "$", which Compose would expand, so SSM holds it base64-encoded and
# it reaches Caddy as a file, never through the environment. Mode 644: Caddy
# reads it as a non-root user, and a bcrypt hash is not the password.
render_demo_auth() {
  local user hash out=${DEMO_AUTH_FILE:-/etc/support-desk/demo-auth.caddy}
  user=$(grep '^DEMO_USER=' "$APP_ENV" | cut -d= -f2-)
  hash=$(grep '^DEMO_PASSWORD_HASH_B64=' "$APP_ENV" | cut -d= -f2- | base64 -d)
  [[ "$user" =~ ^[A-Za-z0-9_.-]+$ ]] || die "DEMO_USER must be letters, digits, . _ or -"
  [[ "$hash" =~ ^\$2[aby]\$[0-9]{2}\$.{53}$ ]] || die "DEMO_PASSWORD_HASH_B64 is not a base64 bcrypt hash"
  mkdir -p "$(dirname "$out")"
  printf 'basic_auth {\n\t%s %s\n}\n' "$user" "$hash" >"$out.tmp"
  chmod 644 "$out.tmp"
  mv "$out.tmp" "$out"
}
