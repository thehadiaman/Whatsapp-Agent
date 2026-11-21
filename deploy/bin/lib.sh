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
    BETTER_AUTH_SECRET CREDENTIALS_KEY META_APP_SECRET META_VERIFY_TOKEN APP_MODE PUBLIC_APP_URL; do
    grep -q "^$required=" "$tmp" || die "$required is missing under $SSM_PATH (infra/scripts/put-secrets.sh)"
  done
  mkdir -p "$(dirname "$APP_ENV")"
  mv "$tmp" "$APP_ENV"
}
