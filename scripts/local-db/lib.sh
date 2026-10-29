# Shared settings for the local test database. Sourced by setup.sh, test.sh,
# psql.sh and down.sh; not meant to be run on its own.
#
# LOCAL ONLY. Everything here talks to a Docker container on 127.0.0.1. Nothing
# reads the repo's .env (which points at the production database on Azure).

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# Overridable, e.g. LOCAL_DB_NAME=leap-localdb-b LOCAL_DB_PORT=54331 bash scripts/local-db/setup.sh
NAME="${LOCAL_DB_NAME:-leap-localdb}"
PORT="${LOCAL_DB_PORT:-54329}"
NET="$NAME-net"

# Every container/network this tool creates carries this label. The tool only
# ever removes things that have it, so it cannot delete someone else's container.
LABEL_KEY=nl.vu.leap.tool
LABEL_VAL=local-db

# LOCAL-ONLY THROWAWAY CREDENTIALS. They protect nothing: the database listens on
# 127.0.0.1 only and holds fixture data. Never reuse them anywhere else.
PW=leap-local-only-throwaway
JWT_SECRET=leap-local-only-throwaway-jwt-secret-32+chars

# Postgres 17, as the Azure flexible server. GoTrue and storage-api are read from
# azure/scripts/config.sh so the auth/storage schemas match what runs on Azure.
PG_IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.075}"
image_from_config() { # $1 = variable name in config.sh, $2 = image path (supabase/gotrue)
  sed -n "s#^$1=\".*/\($2:[^\"]*\)\".*#\1#p" "$REPO/azure/scripts/config.sh" | head -1
}
GOTRUE_IMAGE="$(image_from_config GOTRUE_IMAGE supabase/gotrue)"
STORAGE_IMAGE="$(image_from_config STORAGE_IMAGE supabase/storage-api)"

LOCAL_DB_URL="postgres://postgres:$PW@127.0.0.1:$PORT/postgres"

die() { echo "local-db: $*" >&2; exit 1; }

# Refuses every database address that is not on this machine.
assert_local_url() {
  node -e '
    const u = new URL(process.argv[1]);
    if (!["localhost", "127.0.0.1"].includes(u.hostname)) {
      console.error(`local-db: WEIGERT ${u.hostname}: alleen localhost/127.0.0.1 is toegestaan`);
      process.exit(1);
    }' "$1" || exit 1
}

# true if the container exists, false if not; dies if it exists but is not ours.
owned_container_exists() {
  local label
  label="$(docker inspect -f "{{ index .Config.Labels \"$LABEL_KEY\" }}" "$1" 2>/dev/null)" || return 1
  [[ "$label" == "$LABEL_VAL" ]] ||
    die "container '$1' bestaat al maar is niet door deze tool gemaakt; laat hem staan en kies een andere naam, bijv. LOCAL_DB_NAME=leap-localdb-b LOCAL_DB_PORT=54331"
}

require_running() {
  [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" == true ]] ||
    die "container '$NAME' draait niet; start eerst: npm run db:local"
  owned_container_exists "$NAME"
}

# psql inside the container (so it can only ever reach this container's database).
# Working directory /localdb = this folder, mounted read-only.
psql_as() {
  local user=$1; shift
  docker exec -i -w /localdb -e PGPASSWORD="$PW" "$NAME" \
    psql -h localhost -U "$user" -d postgres -X -q -v ON_ERROR_STOP=1 "$@"
}
