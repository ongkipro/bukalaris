#!/usr/bin/env bash
# Restore drill (14-SLA-DISASTER-RECOVERY DR-1): restore a dump into a scratch database, compare
# per-table row counts with the source database, run consistency queries, drop the scratch DB.
# Usage: scripts/db-restore-rehearsal.sh [path/to/file.dump]   # default: newest var/backups/*.dump
# The source database is read from the dump filename (<db>-<UTC>.dump) for the count comparison;
# counts differ legitimately if the source changed after the dump. Nothing in the source is modified.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/_registry.sh"

file="${1:-$(ls -1t "$ROOT"/var/backups/*.dump 2>/dev/null | head -1)}"
[ -f "${file:-}" ] || die "no dump found; run scripts/db-backup.sh first"
src="$(basename "$file" .dump)"; src="${src%-*}"
scratch="bukalaris_restore_$(date -u +%H%M%S)_$$"
require_db_container
refuse_unless_local_name "$scratch"
# Never restore onto the live cluster (T-74, D-21): this cluster's system_identifier must differ from the one
# recorded as LIVE_SYSTEM_IDENTIFIER (`select system_identifier from pg_control_system()` on production; env or .env).
# Unset means no live cluster is known here (local use); the summary line says so.
target_id=$(psql_in postgres -c "select system_identifier from pg_control_system()")
live_id="$(env_or_dotenv LIVE_SYSTEM_IDENTIFIER)"
[ -z "$live_id" ] || [ "$live_id" != "$target_id" ] || die "refusing to restore onto the live cluster (system_identifier $target_id)"
live_guard=$([ -n "$live_id" ] && echo ok || echo inactive)

cleanup() { psql_in postgres -c "drop database if exists \"$scratch\" with (force)" >/dev/null && log "dropped $scratch"; }
trap cleanup EXIT

log "restoring ${file#"$ROOT"/} into $scratch (source: $src)"
psql_in postgres -c "create database \"$scratch\"" >/dev/null
t0=$(now_ms)
docker exec -i "$DB_CONTAINER" pg_restore -U "$PG_USER" -d "$scratch" --exit-on-error < "$file" # keeps owners + grants (RLS)
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
# Tenant isolation and grants survived the restore (T-27, T-59, SEC-23). Expected state comes from the isolation
# registry, not from counts: every table's owner, row-level security and policy, the per-role grants of
# bukalaris_app / bukalaris_platform / bukalaris_resolver, every SECURITY DEFINER function's owner and EXECUTE
# grantees, and the five roles (STRICT_PLATFORM=1 once the contract step ran). Roles are cluster-level and are not in
# the dump; a missing one shows up here.
pol=$(psql_in "$scratch" -c "select count(*) from pg_policies where schemaname = 'public'")
want_pol=$(registry_policy_count)
src_pol=$([ -n "$have_src" ] && psql_in "$src" -c "select count(*) from pg_policies where schemaname = 'public'" || echo "$pol")
grant_problems=$(registry_problems "$scratch")
[ -z "$grant_problems" ] || printf 'registry differences after restore:\n%s\n' "$grant_problems" >&2
app_psql() { docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U bukalaris_app -d "$scratch" -Atq "$@"; }
app_none=$(app_psql -c "select count(*) from product")
first_store=$(psql_in "$scratch" -c "select coalesce(min(id), 0) from store")
app_ctx=$(app_psql -c "begin" -c "select set_config('app.store_id', '$first_store', true)" -c "select count(*) from product" -c "commit" | grep -E '^[0-9]+$' | tail -1)
src_ctx=$(psql_in "$scratch" -c "select count(*) from product where store_id = $first_store")
rls_ok=$([ "$pol" = "$want_pol" ] && [ "$pol" = "$src_pol" ] && [ -z "$grant_problems" ] && [ "$app_none" = 0 ] && [ "$app_ctx" = "$src_ctx" ] && echo yes || echo NO)
[ "$rls_ok" = yes ] || status=1
# Artifact references: every media row of the restored database has its file in the restored media directory
# (RESTORE_MEDIA_DIR, else MEDIA_DIR; relative paths are relative to apps/web like the web app's own resolution).
media_dir="${RESTORE_MEDIA_DIR:-$(env_or_dotenv MEDIA_DIR)}"; media_dir="${media_dir:-var/media}"
[[ "$media_dir" = /* ]] || media_dir="$ROOT/apps/web/$media_dir"
mapfile -t media_keys < <(psql_in "$scratch" -c "select store_id || '/' || id || '.' || case mime when 'image/jpeg' then 'jpg' when 'image/png' then 'png' else 'webp' end from media order by 1")
media_missing=0
for k in "${media_keys[@]}"; do [ -f "$media_dir/$k" ] || media_missing=$((media_missing + 1)); done
echo "rehearsal: dump=${file#"$ROOT"/} scratch=$scratch restore_ms=$((t1 - t0)) migrations=$mig orphan_store_rows=$orphans counts_match=$([ $status = 0 ] && echo yes || echo NO) policies=$pol/$want_pol/$src_pol registry_differences=$(printf '%s' "$grant_problems" | grep -c . || true) app_without_context=$app_none app_with_context=$app_ctx/$src_ctx rls_ok=$rls_ok live_guard=$live_guard media_refs=$((${#media_keys[@]} - media_missing))/${#media_keys[@]}"
[ "$orphans" = 0 ] || status=1
[ "$media_missing" = 0 ] || status=1
[ "$mig" -ge 1 ] || status=1
exit $status
