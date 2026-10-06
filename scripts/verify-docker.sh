#!/usr/bin/env bash
# Image release gate: build web + migrate images, migrate a throwaway database on the compose
# network, start the web image against it, prove /api/health 200, a DB-backed route, the Docker
# HEALTHCHECK, the non-root user and a writable MEDIA_DIR volume, then clean up (container, volume,
# database). Images stay tagged bukalaris-{web,migrate}:${IMAGE_TAG:-local} for manual smoke tests.
# Unique names per run so parallel worktrees do not collide. Optional: VERIFY_PORT=3170 publishes
# the container on 127.0.0.1:$VERIFY_PORT for a manual look while it runs.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
cd "$ROOT"

tag="${IMAGE_TAG:-local}"
id="$(date +%s)$$"
db="bukalaris_verify_$id"
ctr="bukalaris-verify-$id"
vol="bukalaris-verify-media-$id"
# Three roles as in production (ADR-0005); compose-internal placeholder passwords = role names (packages/db/docker/05-roles.sql).
owner_url="postgres://bukalaris_owner:bukalaris_owner@db:5432/$db"
app_url="postgres://bukalaris_app:bukalaris_app@db:5432/$db"
platform_url="postgres://bukalaris_platform:bukalaris_platform@db:5432/$db"
require_db_container
refuse_unless_local_name "$db"

cleanup() {
  docker rm -f "$ctr" >/dev/null 2>&1 || true
  docker volume rm "$vol" >/dev/null 2>&1 || true
  psql_in postgres -c "drop database if exists \"$db\" with (force)" >/dev/null 2>&1 || true
  log "cleaned up $ctr, $vol, $db"
}
trap cleanup EXIT

t0=$(now_ms)
docker build -q -f apps/web/Dockerfile -t "bukalaris-web:$tag" . >/dev/null
docker build -q -f apps/web/Dockerfile --target migrate -t "bukalaris-migrate:$tag" . >/dev/null
t1=$(now_ms)
size() { docker image inspect -f '{{.Size}}' "$1" | awk '{printf "%.0f MB", $1/1e6}'; }
log "built in $((t1 - t0)) ms: web $(size bukalaris-web:$tag), migrate $(size bukalaris-migrate:$tag)"

psql_in postgres <"$ROOT/packages/db/docker/05-roles.sql" >/dev/null # roles exist on a fresh volume; idempotent on an old one
psql_in postgres -c "create database \"$db\" owner bukalaris_owner" >/dev/null
docker run --rm --network "$DB_NETWORK" -e MIGRATION_DATABASE_URL="$owner_url" "bukalaris-migrate:$tag"
docker run --rm --network "$DB_NETWORK" -e MIGRATION_DATABASE_URL="$owner_url" "bukalaris-migrate:$tag" >/dev/null # idempotent re-run
tables=$(psql_in "$db" -c "select count(*) from information_schema.tables where table_schema='public'")
policies=$(psql_in "$db" -c "select count(*) from pg_policies where policyname='tenant_isolation'")
log "migrated $db: $tables public tables, $policies tenant_isolation policies"

publish=(); [ -n "${VERIFY_PORT:-}" ] && publish=(-p "127.0.0.1:$VERIFY_PORT:3000")
docker run -d --name "$ctr" --network "$DB_NETWORK" "${publish[@]}" \
  -v "$vol:/data/media" \
  -e DATABASE_URL="$app_url" -e PLATFORM_DATABASE_URL="$platform_url" -e BETTER_AUTH_URL="http://localhost:${VERIFY_PORT:-3000}" \
  -e BETTER_AUTH_SECRET="verify-only-$id-not-a-real-secret-0123456789" -e STORE_ROOT_DOMAIN=localhost \
  --health-interval=2s --health-retries=5 --health-start-period=5s \
  "bukalaris-web:$tag" >/dev/null

# busybox wget inside the container: no host port needed, works beside other worktrees.
http() { docker exec "$ctr" wget -qS -O /dev/null "http://127.0.0.1:3000$1" 2>&1 | awk 'NR==1{print $2}' || true; } # wget exits 1 on 4xx
for _ in $(seq 1 30); do [ "$(http /api/health)" = 200 ] && break; sleep 1; done
health="$(http /api/health)"; nope="$(http /s/nope)"; login="$(http /login)"
for _ in $(seq 1 30); do
  hc="$(docker inspect -f '{{.State.Health.Status}}' "$ctr")"; [ "$hc" = healthy ] && break; sleep 1
done
user="$(docker exec "$ctr" id -un)"
media="$(docker exec "$ctr" sh -c 'echo ok > "$MEDIA_DIR/.write-test" && rm "$MEDIA_DIR/.write-test" && echo writable' 2>&1 || true)"
t2=$(now_ms)

echo "verify:docker health=$health s_nope=$nope login=$login healthcheck=$hc user=$user media=$media policies=$policies total_ms=$((t2 - t0))"
[ "$health" = 200 ] && [ "$nope" = 404 ] && [ "$login" = 200 ] && [ "$hc" = healthy ] && [ "$user" = app ] && [ "$media" = writable ] && [ "$policies" -ge 26 ] ||
  { docker logs "$ctr" | tail -40 >&2; die "image smoke test failed"; }
