#!/bin/bash
# Static checks for the deployment, offline apart from image and provider
# downloads; no AWS account or credentials:
#   - terraform fmt, validate and test (a mocked AWS provider, tests/plan.tftest.hcl)
#   - shellcheck on every deploy and ops script, and on the first-boot script
#   - actionlint on the CI workflow (its shell steps through shellcheck)
#   - the production Compose file parses
# Tools run in pinned containers, so nothing needs installing.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TERRAFORM_IMAGE=hashicorp/terraform:1.17.1
SHELLCHECK_IMAGE=koalaman/shellcheck:v0.11.0
ACTIONLINT_IMAGE=rhysd/actionlint:1.7.12

terraform() {
  local dir=$1
  shift
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e TF_IN_AUTOMATION=1 \
    -v "$ROOT/infra/terraform:/tf" -w "/tf$dir" "$TERRAFORM_IMAGE" "$@"
}

echo "== terraform"
terraform "" fmt -check -recursive
for dir in "" /bootstrap; do
  terraform "$dir" init -backend=false -input=false >/dev/null
  terraform "$dir" validate -no-color
done
terraform "" test -no-color

echo "== shellcheck"
docker run --rm -v "$ROOT:/mnt:ro" -w /mnt "$SHELLCHECK_IMAGE" -x \
  deploy/bin/lib.sh deploy/bin/deploy deploy/bin/backup deploy/bin/restore deploy/bin/seed \
  infra/scripts/put-secrets.sh scripts/*.sh
# The first-boot script is a Terraform template: $${x} is a literal ${x}, and
# ${x} is filled in by Terraform (so SC2154 does not apply).
# shellcheck disable=SC2016 # a literal $ in the pattern
sed 's/\$\${/${/g' "$ROOT/infra/terraform/user-data.sh.tftpl" |
  docker run --rm -i "$SHELLCHECK_IMAGE" --exclude=SC2154 --shell=bash -

echo "== actionlint (the CI workflow, shell steps included)"
docker run --rm -v "$ROOT:/repo:ro" -w /repo "$ACTIONLINT_IMAGE"

echo "== compose"
# Interpolation needs every required variable; placeholders are enough to parse.
placeholders=$(mktemp)
trap 'rm -f "$placeholders"' EXIT
# shellcheck disable=SC2016 # a literal $ in the pattern
grep -o '\${[A-Z_]*:?}' "$ROOT/deploy/compose.prod.yaml" | sort -u | sed -E 's/\$\{([A-Z_]+):\?\}/\1=placeholder/' >"$placeholders"
docker compose -f "$ROOT/deploy/compose.prod.yaml" --env-file "$placeholders" --profile ops config --quiet

echo "infra checks passed"
