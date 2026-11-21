#!/bin/bash
# Tests deploy/bin/backup and deploy/bin/restore against a real Postgres with
# the real schema (row-level security, policies, pgvector), no S3:
#   1. back up the source database and check the dump lists its data
#   2. restore into a scratch database; --check matches tables and policies
#   3. every table has the same row count as the source
#   4. a truncated dump fails and leaves no half-restored database
#   5. restoring over "app" without --replace-production is refused
#
# The source is app_test, which `make test-int` (and CI) migrates. Locally:
#   make test-int && scripts/backup-restore.test.sh
# Client tools run in the same image as the server, so versions match.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE_DB=${BACKUP_TEST_DB:-app_test}
PGHOST=${PGHOST:-localhost}
PGPORT=${PGPORT:-${POSTGRES_HOST_PORT:-55432}}
PGPASSWORD=${PGPASSWORD:-postgres}
IMAGE=pgvector/pgvector:0.8.7-pg18-trixie

export PG_EXEC="docker run --rm -i --network host -e PGHOST=$PGHOST -e PGPORT=$PGPORT -e PGPASSWORD=$PGPASSWORD $IMAGE"
export BACKUP_S3_PREFIX=""
export BACKUP_DB=$SOURCE_DB
export CHECK_AGAINST=$SOURCE_DB
BACKUP_LOCAL_DIR=$(mktemp -d)
export BACKUP_LOCAL_DIR
SCRATCH=restore_test_$$

read -ra PG <<<"$PG_EXEC"
sql() { "${PG[@]}" psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -qAt -c "$2"; }
cleanup() {
  sql postgres "DROP DATABASE IF EXISTS $SCRATCH WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$BACKUP_LOCAL_DIR"
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

counts() {
  sql "$1" "SELECT relname || '=' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', schemaname, relname), false, true, '')))[1]::text FROM pg_stat_user_tables ORDER BY 1"
}

[ "$(sql "$SOURCE_DB" "SELECT count(*) FROM pg_policy")" -gt 0 ] ||
  fail "$SOURCE_DB has no row-level security policies: run make test-int first"
# Some rows, so equal counts mean something.
[ "$(counts "$SOURCE_DB" | grep -vc '=0$')" -gt 0 ] || fail "$SOURCE_DB has no rows to back up"

echo "1. backup"
dump=$("$ROOT/deploy/bin/backup" 2>/dev/null | tail -n 1)
[ -s "$dump" ] || fail "no dump written"

echo "2. restore with --check"
out=$("$ROOT/deploy/bin/restore" --into "$SCRATCH" --check "$dump" 2>&1) || fail "restore --check: $out"
grep -q 'check passed' <<<"$out" || fail "restore --check did not check: $out"

echo "3. row counts match"
[ "$(counts "$SOURCE_DB")" = "$(counts "$SCRATCH")" ] || fail "row counts differ after restore"

echo "4. a truncated dump fails cleanly"
head -c "$(($(stat -c %s "$dump") / 2))" "$dump" >"$BACKUP_LOCAL_DIR/truncated.dump"
if "$ROOT/deploy/bin/restore" --into "$SCRATCH" "$BACKUP_LOCAL_DIR/truncated.dump" >/dev/null 2>&1; then
  fail "a truncated dump restored without an error"
fi
[ "$(sql "$SCRATCH" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" = 0 ] ||
  fail "a failed restore left tables behind"

echo "5. the live database is protected"
if "$ROOT/deploy/bin/restore" --into app "$dump" >/dev/null 2>&1; then
  fail "restore --into app ran without --replace-production"
fi

echo "backup and restore: all checks passed"
