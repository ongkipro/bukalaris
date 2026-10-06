# Shared helpers for scripts/*.sh (sourced, not executed). Bash only.
# Postgres is reachable only inside the compose container (127.0.0.1:5442 on the host), so every
# psql/pg_dump/pg_restore call runs through `docker exec` on that container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_CONTAINER="${DB_CONTAINER:-bukalaris-db-1}"
DB_NETWORK="${DB_NETWORK:-bukalaris_default}"
PG_USER="${PG_USER:-bukalaris}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
now_ms() { date +%s%3N; }

# Reads VAR from the environment, else from the root .env (never printed).
env_or_dotenv() {
  local name="$1" value="${!1:-}"
  if [ -z "$value" ] && [ -f "$ROOT/.env" ]; then
    value="$(grep -E "^${name}=" "$ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'")"
  fi
  printf '%s' "$value"
}

# Database name = last path segment of a postgres:// URL.
db_name_of() { printf '%s' "${1##*/}" | cut -d'?' -f1; }

# psql on the compose container; $1 = database, rest = psql args. Tuples-only, unaligned.
psql_in() { local db="$1"; shift; docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$db" -Atq "$@"; }

require_db_container() {
  docker inspect -f '{{.State.Health.Status}}' "$DB_CONTAINER" 2>/dev/null | grep -qx healthy ||
    die "container $DB_CONTAINER is not healthy; run: docker compose up -d db --wait"
}

# Refuse to run against anything that is not obviously a local throwaway/dev name.
refuse_unless_local_name() {
  case "$1" in bukalaris|bukalaris_*) ;; *) die "refusing to touch database '$1' (expected bukalaris or bukalaris_*)";; esac
}
