#!/usr/bin/env bash
# Builds a throwaway LEAP database from zero in a local Docker container:
#   1. fresh Postgres 17 (Supabase image) on 127.0.0.1:$PORT
#   2. GoTrue migrations   -> auth schema (auth.users, auth.uid(), ...)
#   3. storage-api start   -> storage schema (storage.objects, ...)
#   4. azure/db/roles.sql  -> same roles/grants as on Azure
#   5. the repo's own migrations via scripts/migrate.mjs (no local fix-ups)
#   6. seed.sql            -> fixed test users and courses (skip with --no-seed)
#
#   bash scripts/local-db/setup.sh [--no-seed]     (or: npm run db:local)
#
# LOCAL ONLY: binds 127.0.0.1, never reads .env, refuses non-local addresses.
# Running it again throws the old local database away and starts over.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

SEED=1
[[ "${1:-}" == --no-seed ]] && SEED=0

command -v docker >/dev/null || die "docker niet gevonden (installeer OrbStack of Docker Desktop)"
docker info >/dev/null 2>&1 || die "Docker draait niet (start OrbStack/Docker Desktop)"
command -v node >/dev/null || die "node niet gevonden"
[[ -d "$REPO/node_modules/pg" ]] || die "node_modules ontbreekt; draai eerst: npm install"
[[ -n "$GOTRUE_IMAGE" && -n "$STORAGE_IMAGE" ]] || die "kon GoTrue/storage-versies niet lezen uit azure/scripts/config.sh"

echo "== 1. nieuwe container $NAME ($PG_IMAGE) op 127.0.0.1:$PORT"
for c in "$NAME-storage" "$NAME"; do
  if owned_container_exists "$c"; then docker rm -f "$c" >/dev/null; fi
done
docker network inspect "$NET" >/dev/null 2>&1 ||
  docker network create --label "$LABEL_KEY=$LABEL_VAL" "$NET" >/dev/null
docker run -d --name "$NAME" --label "$LABEL_KEY=$LABEL_VAL" --network "$NET" --network-alias db \
  -p "127.0.0.1:$PORT:5432" -v "$HERE:/localdb:ro" \
  -e POSTGRES_PASSWORD="$PW" -e JWT_SECRET="$JWT_SECRET" "$PG_IMAGE" >/dev/null ||
  die "container starten mislukt (poort $PORT al bezet? kies LOCAL_DB_PORT=...)"
# During init the server only listens on the unix socket, so TCP ready = init done.
for i in $(seq 1 90); do
  docker exec "$NAME" pg_isready -h localhost -U postgres >/dev/null 2>&1 && break
  [[ $i == 90 ]] && { docker logs "$NAME" 2>&1 | tail -20; die "postgres kwam niet op"; }
  sleep 2
done
psql_as supabase_admin -c "alter role supabase_auth_admin password '$PW';
  alter role supabase_storage_admin password '$PW'; alter role authenticator password '$PW';"

INNER_URL="postgres://%s:$PW@db:5432/postgres?sslmode=disable"   # container-to-container

echo "== 2. GoTrue-migraties ($GOTRUE_IMAGE)"
docker run --rm --label "$LABEL_KEY=$LABEL_VAL" --network "$NET" --entrypoint auth \
  -e GOTRUE_DB_DRIVER=postgres -e "GOTRUE_DB_DATABASE_URL=$(printf "$INNER_URL" supabase_auth_admin)" \
  -e API_EXTERNAL_URL=http://localhost:9999 -e GOTRUE_SITE_URL=http://localhost:5173 \
  -e GOTRUE_JWT_SECRET="$JWT_SECRET" "$GOTRUE_IMAGE" migrate 2>&1 |
  grep -E 'Successfully applied|migrations applied' || die "GoTrue-migraties mislukt"

echo "== 3. Storage-schema ($STORAGE_IMAGE)"
ANON=$(JWT_SECRET="$JWT_SECRET" node "$HERE/jwt.mjs" anon)
SVC=$(JWT_SECRET="$JWT_SECRET" node "$HERE/jwt.mjs" service_role)
docker run -d --name "$NAME-storage" --label "$LABEL_KEY=$LABEL_VAL" --network "$NET" \
  -e "DATABASE_URL=$(printf "$INNER_URL" supabase_storage_admin)" -e ANON_KEY="$ANON" -e SERVICE_KEY="$SVC" \
  -e AUTH_JWT_SECRET="$JWT_SECRET" -e STORAGE_BACKEND=file -e FILE_STORAGE_BACKEND_PATH=/tmp/storage \
  -e TENANT_ID=stub -e REGION=local -e GLOBAL_S3_BUCKET=stub -e FILE_SIZE_LIMIT=52428800 \
  "$STORAGE_IMAGE" >/dev/null
for i in $(seq 1 60); do
  docker logs "$NAME-storage" 2>&1 | grep -q 'Started Successfully' && break
  if [[ $i == 60 ]] || [[ "$(docker inspect -f '{{.State.Running}}' "$NAME-storage")" != true ]]; then
    docker logs "$NAME-storage" 2>&1 | tail -20; docker rm -f "$NAME-storage" >/dev/null; die "storage-api startte niet"
  fi
  sleep 2
done
docker rm -f "$NAME-storage" >/dev/null   # only needed once, for its migrations

echo "== 4. azure/db/roles.sql (zoals op Azure)"
psql_as supabase_admin -v dbname=postgres -v authenticator_password="$PW" \
  -v auth_admin_password="$PW" -v storage_admin_password="$PW" < "$REPO/azure/db/roles.sql" 2>&1 |
  { grep -v NOTICE || true; }

echo "== 5. LEAP-migraties (scripts/migrate.mjs, vanaf nul)"
DB_URL="$LOCAL_DB_URL?sslmode=disable"
assert_local_url "$DB_URL"
# SUPABASE_DB_URL is set explicitly; dotenv does not override it. The guard
# additionally refuses any non-local pg connection inside this node process.
( cd "$REPO" && SUPABASE_DB_URL="$DB_URL" node --require "$HERE/local-only-guard.cjs" scripts/migrate.mjs )
STATUS="$(cd "$REPO" && SUPABASE_DB_URL="$DB_URL" node --require "$HERE/local-only-guard.cjs" scripts/migrate.mjs --status)"
echo "$STATUS"
grep -q 'alles is uitgevoerd' <<<"$STATUS" || die "niet alle migraties zijn uitgevoerd"
APPLIED="$(psql_as postgres -At -c 'select count(*) from public.leap_migrations')"
echo "   $APPLIED migraties uitgevoerd in container $NAME"

if [[ $SEED == 1 ]]; then
  echo "== 6. testgebruikers en -cursussen (seed.sql)"
  psql_as postgres -f /localdb/seed.sql
fi

echo
echo "Klaar. Lokale database: $LOCAL_DB_URL"
echo "  tests:  bash scripts/local-db/test.sh"
echo "  psql:   bash scripts/local-db/psql.sh"
