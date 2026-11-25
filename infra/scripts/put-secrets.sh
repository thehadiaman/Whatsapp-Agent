#!/bin/bash
# Put the production secrets into SSM Parameter Store as SecureString (AWS
# managed key aws/ssm). Run from your own machine with your AWS profile, after
# `terraform apply` and before the first deploy. Never stored anywhere else:
# not in the repo, not in Terraform state, not in CI.
#
#   infra/scripts/put-secrets.sh               generate missing secrets, ask for Meta's
#   infra/scripts/put-secrets.sh --seed        also set SEED_PASSWORD (public demo)
#   infra/scripts/put-secrets.sh --demo        set the password for the simulator page (D-113)
#   infra/scripts/put-secrets.sh --rotate NAME replace one generated secret
#
# Generated values are hex or base64 without "$" or newlines, so the deploy's
# env file and Postgres URLs need no escaping. Existing values are kept unless
# rotated: CREDENTIALS_KEY in particular seals every business's WhatsApp
# token, so rotating it means re-entering those tokens (docs/RUNBOOK.md).
set -euo pipefail

SSM_PATH=${SSM_PATH:-/support-desk/prod}
REGION=${AWS_REGION:-ap-south-1}
seed=false demo=false rotate=

while [ $# -gt 0 ]; do
  case $1 in
    --seed) seed=true; shift ;;
    --demo) demo=true; shift ;;
    --rotate) rotate=${2:?--rotate needs a name}; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

exists() {
  aws ssm get-parameter --region "$REGION" --name "$SSM_PATH/$1" --query Parameter.Name --output text >/dev/null 2>&1
}

put() {
  aws ssm put-parameter --region "$REGION" --name "$SSM_PATH/$1" --type SecureString \
    --value "$2" --overwrite >/dev/null
  echo "set $SSM_PATH/$1"
}

hex() { openssl rand -hex "$1"; }

# name -> how to generate it
declare -A GENERATED=(
  [POSTGRES_PASSWORD]="hex 24"
  [DB_MIGRATOR_PASSWORD]="hex 24"
  [DB_USER_PASSWORD]="hex 24"
  [DB_PLATFORM_PASSWORD]="hex 24"
  [BETTER_AUTH_SECRET]="hex 32"
  [CREDENTIALS_KEY]="openssl rand -base64 32"
  [SIMULATOR_ACCESS_TOKEN]="hex 24"
  [SIMULATOR_APP_SECRET]="hex 24"
  [SIMULATOR_VERIFY_TOKEN]="hex 24"
)

if [ -n "$rotate" ]; then
  [ -n "${GENERATED[$rotate]:-}" ] || { echo "only generated secrets rotate here: ${!GENERATED[*]}" >&2; exit 2; }
  if [ "$rotate" = CREDENTIALS_KEY ]; then
    read -r -p "Every business must re-enter its WhatsApp token after this. Type rotate: " answer
    [ "$answer" = rotate ] || exit 1
  fi
  if [ "$rotate" = POSTGRES_PASSWORD ]; then
    echo "The postgres superuser password is set when the data directory is created; see docs/RUNBOOK.md before rotating it." >&2
    exit 2
  fi
  put "$rotate" "$(${GENERATED[$rotate]})"
  echo "Now redeploy: provision applies new database passwords; containers restart with the new values."
  exit 0
fi

for name in "${!GENERATED[@]}"; do
  if exists "$name"; then
    echo "kept $SSM_PATH/$name"
  else
    put "$name" "$(${GENERATED[$name]})"
  fi
done

# Meta's values come from the Meta app (App settings > Basic > App secret) and
# the verify token you type into its webhook settings.
for name in META_APP_SECRET META_VERIFY_TOKEN; do
  if exists "$name"; then
    echo "kept $SSM_PATH/$name"
    continue
  fi
  if [ "$name" = META_VERIFY_TOKEN ]; then
    value=$(hex 24)
    echo "generated META_VERIFY_TOKEN: enter this in Meta's webhook settings:"
    echo "  $value"
  else
    read -r -s -p "$name (from the Meta app): " value
    echo
  fi
  [ ${#value} -ge 8 ] || { echo "$name must be at least 8 characters" >&2; exit 1; }
  case $value in *'$'*) echo "$name must not contain \$" >&2; exit 1 ;; esac
  put "$name" "$value"
done

if $seed; then
  read -r -s -p "SEED_PASSWORD for the demo accounts (12+ characters): " value
  echo
  [ ${#value} -ge 12 ] || { echo "too short" >&2; exit 1; }
  case $value in *'$'*) echo "must not contain \$" >&2; exit 1 ;; esac
  put SEED_PASSWORD "$value"
fi

# The demo page's password (D-113). Only its bcrypt hash is stored, base64-
# encoded because the hash contains "$" (see render_demo_auth in deploy/bin/lib.sh).
# Hashed with Caddy's own tool, reading the password from stdin.
if $demo; then
  read -r -s -p "Password for the demo page (12+ characters, user 'demo'): " value
  echo
  [ ${#value} -ge 12 ] || { echo "too short" >&2; exit 1; }
  hash=$(printf '%s' "$value" | docker run --rm -i caddy:2.11.9 caddy hash-password | tail -n 1)
  # shellcheck disable=SC2016 # a literal "$2": bcrypt hashes start with it
  [[ "$hash" == '$2'* ]] || { echo "hashing failed" >&2; exit 1; }
  put DEMO_PASSWORD_HASH_B64 "$(printf '%s' "$hash" | base64 -w0)"
  echo "Share the user name 'demo' and this password with the people you invite."
fi
