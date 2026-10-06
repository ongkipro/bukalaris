#!/usr/bin/env bash
# Dump one database (custom format, pg_dump -Fc) into var/backups/<db>-<UTC>.dump and prove the
# file is readable with pg_restore --list. Usage:
#   scripts/db-backup.sh [DATABASE_URL]      # default: DATABASE_URL from env or .env
# Restore drill: scripts/db-restore-rehearsal.sh. Retention/offsite copy are not done here
# (docs/RUNBOOK.md "Backup"). pg_dump runs inside the compose container (same major version).
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

url="${1:-$(env_or_dotenv DATABASE_URL)}"
[ -n "$url" ] || die "DATABASE_URL not set and no .env"
db="$(db_name_of "$url")"
refuse_unless_local_name "$db"
require_db_container

out_dir="$ROOT/var/backups"
mkdir -p "$out_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$out_dir/${db}-${stamp}.dump"

log "pg_dump -Fc $db -> ${file#"$ROOT"/}"
t0=$(now_ms)
# Owners and ACLs are kept on purpose: after T-27 the grants to bukalaris_app/platform and the
# bukalaris_owner ownership are part of tenant isolation (RLS); a dump without them restores a
# database the app role cannot read. The roles themselves are cluster-level (05-roles.sql).
docker exec "$DB_CONTAINER" pg_dump -U "$PG_USER" -Fc "$db" > "$file"
t1=$(now_ms)

entries=$(docker exec -i "$DB_CONTAINER" pg_restore --list < "$file" | grep -c '^[0-9]')
tables=$(psql_in "$db" -c "select count(*) from information_schema.tables where table_schema='public'")
size=$(stat -c %s "$file")
echo "backup: file=${file#"$ROOT"/} bytes=$size duration_ms=$((t1 - t0)) toc_entries=$entries public_tables=$tables"
