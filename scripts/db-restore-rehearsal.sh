#!/usr/bin/env bash
# Restore drill (14-SLA-DISASTER-RECOVERY DR-1): restore a dump into a scratch database, compare
# per-table row counts with the source database, run consistency queries, drop the scratch DB.
# Usage: scripts/db-restore-rehearsal.sh [path/to/file.dump]   # default: newest var/backups/*.dump
# The source database is read from the dump filename (<db>-<UTC>.dump) for the count comparison;
# counts differ legitimately if the source changed after the dump. Nothing in the source is modified.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

file="${1:-$(ls -1t "$ROOT"/var/backups/*.dump 2>/dev/null | head -1)}"
[ -f "${file:-}" ] || die "no dump found; run scripts/db-backup.sh first"
src="$(basename "$file" .dump)"; src="${src%-*}"
scratch="bukalaris_restore_$(date -u +%H%M%S)_$$"
require_db_container
refuse_unless_local_name "$scratch"

cleanup() { psql_in postgres -c "drop database if exists \"$scratch\" with (force)" >/dev/null && log "dropped $scratch"; }
trap cleanup EXIT

log "restoring ${file#"$ROOT"/} into $scratch (source: $src)"
psql_in postgres -c "create database \"$scratch\"" >/dev/null
t0=$(now_ms)
docker exec -i "$DB_CONTAINER" pg_restore -U "$PG_USER" -d "$scratch" --no-owner --no-acl --exit-on-error < "$file"
t1=$(now_ms)
log "pg_restore done in $((t1 - t0)) ms"

# Per-table counts: scratch vs source (source skipped when its database is gone).
have_src=$(psql_in postgres -c "select 1 from pg_database where datname='$src'")
status=0
printf '%-24s %10s %10s\n' table restored source
# Collect first: psql_in uses `docker exec -i`, which would swallow a streamed list on stdin.
mapfile -t tables < <(psql_in "$scratch" -c "select table_name from information_schema.tables where table_schema='public' order by 1")
for t in "${tables[@]}"; do
  r=$(psql_in "$scratch" -c "select count(*) from \"$t\"")
  if [ -n "$have_src" ]; then s=$(psql_in "$src" -c "select count(*) from \"$t\""); else s="-"; fi
  printf '%-24s %10s %10s\n' "$t" "$r" "$s"
  [ "$s" = "-" ] || [ "$r" = "$s" ] || status=1
done
echo "tables_compared=${#tables[@]}"

# Consistency: migrations journal present, every store-owned row points at an existing store.
mig=$(psql_in "$scratch" -c "select count(*) from drizzle.__drizzle_migrations")
orphans=$(psql_in "$scratch" -c "
  select count(*) from (
    select store_id from product union all select store_id from variant union all
    select store_id from membership union all select store_id from \"order\"
  ) o left join store s on s.id = o.store_id where s.id is null")
echo "rehearsal: dump=${file#"$ROOT"/} scratch=$scratch restore_ms=$((t1 - t0)) migrations=$mig orphan_store_rows=$orphans counts_match=$([ $status = 0 ] && echo yes || echo NO)"
[ "$orphans" = 0 ] || status=1
[ "$mig" -ge 1 ] || status=1
exit $status
