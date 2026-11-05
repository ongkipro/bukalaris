#!/usr/bin/env bash
# Image release gate: build web + migrate images, migrate a throwaway database on the compose
# network, start the web image against it, prove /api/health 200, a DB-backed route, the Docker
# HEALTHCHECK, the non-root user and a writable MEDIA_DIR volume. T-84: then run the built outbox
# worker and the one-shot cleanup from the migrate image (it carries packages/db with its production
# dependencies) as bukalaris_platform on the same scratch database and prove one safe queued effect,
# the scheduler heartbeat, a graceful SIGTERM shutdown and a bounded cleanup with buyer-data retention
# off. VERIFY_BREAK=worker|effect|cleanup deliberately breaks one step to prove the gate fails. Then
# clean up (containers, volume, database). Images stay tagged bukalaris-{web,migrate}:${IMAGE_TAG:-local} for manual smoke tests.
# Unique names per run so parallel worktrees do not collide. Optional: VERIFY_PORT=3170 publishes
# the container on 127.0.0.1:$VERIFY_PORT for a manual look while it runs.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/_registry.sh"
cd "$ROOT"

tag="${IMAGE_TAG:-local}"
id="$(date +%s)$$"
db="bukalaris_verify_$id"
ctr="bukalaris-verify-$id"
wkr="bukalaris-verify-worker-$id"
vol="bukalaris-verify-media-$id"
# Three roles as in production (ADR-0005); compose-internal placeholder passwords = role names (packages/db/docker/05-roles.sql).
owner_url="postgres://bukalaris_owner:bukalaris_owner@db:5432/$db"
app_url="postgres://bukalaris_app:bukalaris_app@db:5432/$db"
platform_url="postgres://bukalaris_platform:bukalaris_platform@db:5432/$db"
require_db_container
refuse_unless_local_name "$db"

cleanup() {
  docker rm -f "$ctr" "$wkr" "$ctr-cleanup" >/dev/null 2>&1 || true
  docker volume rm "$vol" >/dev/null 2>&1 || true
  psql_in postgres -c "drop database if exists \"$db\" with (force)" >/dev/null 2>&1 || true
  log "cleaned up $ctr, $wkr, $vol, $db"
}
trap cleanup EXIT

t0=$(now_ms)
docker build -q -f apps/web/Dockerfile -t "bukalaris-web:$tag" . >/dev/null
docker build -q -f apps/web/Dockerfile --target migrate -t "bukalaris-migrate:$tag" . >/dev/null
t1=$(now_ms)
size() { docker image inspect -f '{{.Size}}' "$1" | awk '{printf "%.0f MB", $1/1e6}'; }
log "built in $((t1 - t0)) ms: web $(size bukalaris-web:$tag), migrate $(size bukalaris-migrate:$tag)"
# Identity of what was proven (T-84): image ids plus the source tree (HEAD and a digest of any uncommitted change).
img_id() { docker image inspect -f '{{.Id}}' "$1" | cut -c8-19; }
tree_rev="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
tree_dirty="$( { git -C "$ROOT" diff HEAD; git -C "$ROOT" ls-files -o --exclude-standard | sort | xargs -r cat; } 2>/dev/null | sha256sum | cut -c1-12)"
[ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] && tree_dirty=clean
log "identity: web=$(img_id "bukalaris-web:$tag") migrate=$(img_id "bukalaris-migrate:$tag") tree=$tree_rev dirty=$tree_dirty"
# The web image carries no packages/db/src: worker and cleanup must come from the migrate stage (DEPLOY-COOLIFY).
web_has_worker="$(docker run --rm --entrypoint sh "bukalaris-web:$tag" -c 'test -e /app/packages/db/src/worker.ts && echo yes || echo no')"
migrate_env="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "bukalaris-migrate:$tag" | grep -c '^NODE_ENV=production$' || true)"

psql_in postgres <"$ROOT/packages/db/docker/05-roles.sql" >/dev/null # roles exist on a fresh volume; idempotent on an old one
psql_in postgres -c "create database \"$db\" owner bukalaris_owner" >/dev/null
docker run --rm --network "$DB_NETWORK" -e MIGRATION_DATABASE_URL="$owner_url" "bukalaris-migrate:$tag"
docker run --rm --network "$DB_NETWORK" -e MIGRATION_DATABASE_URL="$owner_url" "bukalaris-migrate:$tag" >/dev/null # idempotent re-run
tables=$(psql_in "$db" -c "select count(*) from information_schema.tables where table_schema='public'")
policies=$(psql_in "$db" -c "select count(*) from pg_policies where schemaname='public'")
want_policies=$(registry_policy_count)
registry_diff=$(registry_problems "$db")
[ -z "$registry_diff" ] || printf 'registry differences in %s:\n%s\n' "$db" "$registry_diff" >&2
log "migrated $db: $tables public tables, $policies/$want_policies policies (registry), $(printf '%s' "$registry_diff" | grep -c . || true) registry differences"

publish=(); [ -n "${VERIFY_PORT:-}" ] && publish=(-p "127.0.0.1:$VERIFY_PORT:3000")
docker run -d --name "$ctr" --network "$DB_NETWORK" "${publish[@]}" \
  -v "$vol:/data/media" \
  -e DATABASE_URL="$app_url" -e PLATFORM_DATABASE_URL="$platform_url" -e BETTER_AUTH_URL="http://localhost:${VERIFY_PORT:-3000}" -e MAIL_MODE=local \
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

echo "verify:docker health=$health s_nope=$nope login=$login healthcheck=$hc user=$user media=$media policies=$policies/$want_policies total_ms=$((t2 - t0))"
[ "$health" = 200 ] && [ "$nope" = 404 ] && [ "$login" = 200 ] && [ "$hc" = healthy ] && [ "$user" = app ] && [ "$media" = writable ] && [ "$policies" = "$want_policies" ] && [ -z "$registry_diff" ] ||
  { docker logs "$ctr" | tail -40 >&2; die "image smoke test failed"; }

# ---------------------------------------------------------------------------------------------------
# T-84: worker and cleanup from the built migrate image, as bukalaris_platform, on the scratch database.
# ---------------------------------------------------------------------------------------------------
break_step="${VERIFY_BREAK:-}"
case "$break_step" in ""|worker|effect|cleanup) ;; *) die "VERIFY_BREAK must be worker, effect or cleanup";; esac
# Bounded condition wait: poll a SQL predicate (returns t/f) up to $2 seconds.
wait_sql() { local sql="$1" secs="$2"; for _ in $(seq 1 "$secs"); do [ "$(psql_in "$db" -c "$sql")" = t ] && return 0; sleep 1; done; return 1; }

# The safe effect: an already expired approval request that the registered approval.expire sweeper moves to
# `expired`. It touches only this scratch database; no provider, e-mail or money path is involved.
psql_in "$db" >/dev/null <<SQL
insert into "user" (id, name, email, email_verified) values ('verify-op-a', 'Verify A', 'verify-a-$id@bukalaris.local', true), ('verify-op-b', 'Verify B', 'verify-b-$id@bukalaris.local', true);
insert into platform_operator (user_id) values ('verify-op-a'), ('verify-op-b');
-- Through the real guard and checks: an expired request only needs created_at before expires_at (approval_request_expiry_chk).
insert into approval_request (action_key, target_kind, target_id, payload_sha256, payload_canonical, requested_by, reason, status, created_at, expires_at)
values ('grant.sensitive', 'verify', 'verify-$id', encode(sha256(convert_to('{"verify":true}', 'UTF8')), 'hex'), '{"verify":true}', 'verify-op-a', 'verify:docker effect', 'pending', now() - interval '2 hours', now() - interval '1 minute');
SQL
job_kind="approval.expire"; [ "$break_step" = effect ] && job_kind="verify.unregistered" # VERIFY_BREAK=effect: a kind no handler serves
psql_in "$db" -c "insert into platform_job_kind (kind) values ('$job_kind') on conflict do nothing" >/dev/null
psql_in "$db" -c "insert into job (kind, key, payload) values ('$job_kind', 'verify-$id', '{}')" >/dev/null

worker_url="$platform_url"; [ "$break_step" = worker ] && worker_url="postgres://bukalaris_platform:wrong-password@db:5432/$db"
wt0=$(now_ms)
# NODE_ENV comes from the image (ENV in the migrate stage), exactly as a deployment would get it.
docker run -d --name "$wkr" --network "$DB_NETWORK" \
  -e MAIL_MODE=local -e PLATFORM_DATABASE_URL="$worker_url" -e BETTER_AUTH_URL=http://localhost:3000 \
  -e WORKER_POLL_MS=500 -e SCHEDULER_TICK_MS=1000 \
  "bukalaris-migrate:$tag" node src/worker.ts >/dev/null
worker_user="$(docker exec "$wkr" id -un 2>/dev/null || echo none)"
effect=no; heartbeat=no
wait_sql "select exists(select 1 from job where kind = '$job_kind' and key = 'verify-$id' and status = 'done') and exists(select 1 from approval_request where target_id = 'verify-$id' and status = 'expired')" 30 && effect=yes
wait_sql "select exists(select 1 from scheduler_heartbeat where last_tick_at > now() - interval '1 minute')" 30 && heartbeat=yes
docker stop -t 15 "$wkr" >/dev/null 2>&1 || true
worker_exit="$(docker inspect -f '{{.State.ExitCode}}' "$wkr" 2>/dev/null || echo missing)"
worker_stopped=no; docker logs "$wkr" 2>/dev/null | grep -q '"event":"stopped"' && worker_stopped=yes
# Process-level errors only (poll/scheduler/reconcile); individual job outcomes are logged at info level.
worker_failures="$(docker logs "$wkr" 2>&1 | grep -c '"level":"error"' || true)"
wt1=$(now_ms)

# Cleanup: one-shot, retention off (BUYER_DATA_RETENTION_DAYS unset). Seed one idle cart it must delete and
# one fresh cart it must keep, so the run is bounded and its effect is observable.
# The scratch database is unseeded: create one fixture store (its triggers bootstrap the subscription row).
store_id="$(psql_in "$db" -c "insert into store (slug, name) values ('verify-$id', 'Verify') returning id" | head -1)"
cleanup_url="$platform_url"; [ "$break_step" = cleanup ] && cleanup_url="postgres://bukalaris_platform:wrong-password@db:5432/$db"
if [ -n "$store_id" ]; then
  psql_in "$db" -c "insert into cart (store_id, created_at) values ($store_id, now() - interval '30 days'), ($store_id, now())" >/dev/null
fi
carts_before="$(psql_in "$db" -c "select count(*) from cart")"
set +e
cleanup_log="$(timeout 60 docker run --rm --name "$ctr-cleanup" --network "$DB_NETWORK" -e PLATFORM_DATABASE_URL="$cleanup_url" "bukalaris-migrate:$tag" node src/cleanup.ts 2>&1)"
cleanup_exit=$?
set -e
carts_after="$(psql_in "$db" -c "select count(*) from cart")"
# Which cart went: the idle one must be gone and the fresh one kept.
carts_right="$(psql_in "$db" -c "select not exists(select 1 from cart where created_at < now() - interval '1 day') and (select count(*) from cart where created_at >= now() - interval '1 day') = 1")"
retention_off=no; printf '%s' "$cleanup_log" | grep -q '"buyerRetention":{"enabled":false}' && retention_off=yes
wt2=$(now_ms)

echo "verify:docker worker user=$worker_user effect=$effect heartbeat=$heartbeat stopped=$worker_stopped exit=$worker_exit errors=$worker_failures web_has_worker=$web_has_worker migrate_node_env=$migrate_env worker_ms=$((wt1 - wt0)) cleanup exit=$cleanup_exit carts=$carts_before->$carts_after idle_removed_fresh_kept=$carts_right retention_off=$retention_off cleanup_ms=$((wt2 - wt1))"
[ "$worker_user" = app ] && [ "$effect" = yes ] && [ "$heartbeat" = yes ] && [ "$worker_stopped" = yes ] && [ "$worker_exit" = 0 ] && [ "$worker_failures" = 0 ] && [ "$web_has_worker" = no ] && [ "$migrate_env" = 1 ] ||
  { docker logs "$wkr" 2>&1 | tail -20 >&2; die "worker proof failed"; }
[ "$cleanup_exit" = 0 ] && [ -n "$store_id" ] && [ "$carts_after" = $((carts_before - 1)) ] && [ "$carts_right" = t ] && [ "$retention_off" = yes ] ||
  { printf '%s\n' "$cleanup_log" | tail -10 >&2; die "cleanup proof failed"; }
