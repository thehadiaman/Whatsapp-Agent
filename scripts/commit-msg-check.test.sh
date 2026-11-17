#!/bin/sh
# Tests for scripts/commit-msg-check.sh. Run: scripts/commit-msg-check.test.sh
set -u

check="$(dirname "$0")/commit-msg-check.sh"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
failures=0

expect() {
  want="$1" name="$2" msg="$3"
  printf '%b' "$msg" > "$tmp"
  if "$check" "$tmp" >/dev/null 2>&1; then got=accept; else got=reject; fi
  if [ "$got" = "$want" ]; then
    echo "ok    $name"
  else
    echo "FAIL  $name (wanted $want, got $got)"
    failures=$((failures + 1))
  fi
}

expect accept "conventional subject"            'feat: add inbox\n'
expect accept "conventional subject with scope" 'fix(api): handle duplicate webhook\n\nBody text.\n'
expect accept "breaking change marker"          'feat(shared)!: rename config keys\n'
expect accept "merge commit"                    "Merge branch 'main' into phase-1\n"
expect accept "fixup commit"                    'fixup! feat: add inbox\n'
expect accept "human co-author"                 'feat: add inbox\n\nCo-authored-by: Asha Menon <asha@example.com>\n'
expect accept "word claude in normal prose"     'docs: explain why CLAUDE.md exists\n'
expect accept "comment lines ignored"           'feat: add inbox\n# Co-Authored-By: Claude <noreply@anthropic.com>\n'
expect accept "scissors diff ignored"           'feat: add hook\n# ------------------------ >8 ------------------------\n+Generated with Claude Code\n'

expect reject "claude co-author"                'feat: add inbox\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n'
expect reject "co-author, mixed case"           'feat: add inbox\n\nco-authored-by: someone <bot@ANTHROPIC.com>\n'
expect reject "generated with claude"           'feat: add inbox\n\nGenerated with [Claude Code](https://claude.com/claude-code)\n'
expect reject "not conventional"                'Added the inbox\n'
expect reject "unknown type"                    'feature: add inbox\n'
expect reject "missing description"             'feat: \n'
expect reject "empty message"                   '\n\n'

if [ "$failures" -ne 0 ]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo "all commit message tests passed"
