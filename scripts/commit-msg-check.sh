#!/bin/sh
# Validates one commit message. Used by .githooks/commit-msg (local) and
# scripts/check-commit-range.sh (CI), so both apply exactly the same rules.
#
# Usage: scripts/commit-msg-check.sh <file-containing-the-message>
#
# Rules:
#   1. No AI attribution: rejects "Co-Authored-By: ...Claude/Anthropic..." and
#      "Generated with ...Claude..." (case-insensitive).
#   2. Conventional Commits subject line, e.g. "feat(api): add readiness probe".
#      Merge, revert, fixup!, squash! and amend! subjects are allowed.

set -eu

msg_file="${1:?usage: commit-msg-check.sh <message-file>}"

# Drop everything below git's scissors line (commit -v diff) and comment lines,
# so text in a staged diff or in git's template cannot trigger a false result.
body="$(sed -e '/^# -\{24\} >8 -\{24\}$/,$d' -e '/^#/d' "$msg_file")"

if printf '%s\n' "$body" | grep -Eiq 'co-authored-by:.*(claude|anthropic)|generated with.*claude'; then
  echo "commit-msg: rejected. AI attribution lines (Co-Authored-By Claude/Anthropic, \"Generated with Claude\") are not allowed in this repository." >&2
  exit 1
fi

subject="$(printf '%s\n' "$body" | sed -e '/^[[:space:]]*$/d' | head -n 1)"

if [ -z "$subject" ]; then
  echo "commit-msg: rejected. The commit message is empty." >&2
  exit 1
fi

case "$subject" in
  "Merge "* | "Revert \""* | "fixup! "* | "squash! "* | "amend! "*) exit 0 ;;
esac

if ! printf '%s\n' "$subject" | grep -Eq '^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9][a-z0-9-]*\))?!?: [^[:space:]]'; then
  echo "commit-msg: rejected. The subject must follow Conventional Commits, e.g. \"feat(api): add readiness probe\"." >&2
  echo "  got: $subject" >&2
  exit 1
fi
