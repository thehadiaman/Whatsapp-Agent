#!/bin/sh
# CI check: applies scripts/commit-msg-check.sh to every pushed commit and
# rejects commits whose author or committer names Claude or Anthropic.
#
# Inputs (environment, set by the workflow):
#   EVENT   push | pull_request
#   BEFORE  previous tip for a push (all zeros for a new branch)
#   AFTER   new tip for a push
#   BASE    base commit for a pull request
#   HEAD    head commit for a pull request

set -eu

zero="0000000000000000000000000000000000000000"
here="$(dirname "$0")"

if [ "${EVENT:-push}" = "pull_request" ]; then
  range="${BASE:?}..${HEAD:?}"
elif [ -n "${BEFORE:-}" ] && [ "$BEFORE" != "$zero" ] && git cat-file -e "$BEFORE^{commit}" 2>/dev/null; then
  range="$BEFORE..${AFTER:?}"
else
  # New branch, first push or force push: check the whole history of the tip.
  range="${AFTER:?}"
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

failed=0
count=0
for sha in $(git rev-list "$range"); do
  count=$((count + 1))
  git log -1 --format=%B "$sha" > "$tmp"
  if ! "$here/commit-msg-check.sh" "$tmp"; then
    echo "  in commit $sha" >&2
    failed=1
  fi
  if git log -1 --format='%an%n%ae%n%cn%n%ce' "$sha" | grep -Eiq 'claude|anthropic'; then
    echo "commit-check: rejected. Author or committer of $sha names Claude or Anthropic." >&2
    failed=1
  fi
done

echo "checked $count commit(s) in $range"
exit "$failed"
