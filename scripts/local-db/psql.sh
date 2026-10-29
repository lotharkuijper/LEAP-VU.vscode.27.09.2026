#!/usr/bin/env bash
# Opens psql on the local database (inside the container, as postgres, in the
# folder with as-user.sql / as-anon.sql). Extra arguments go to psql, e.g.
#   bash scripts/local-db/psql.sh -c 'select count(*) from courses'
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_running
tty=-i; [[ -t 0 ]] && tty=-it
exec docker exec "$tty" -w /localdb -e PGPASSWORD="$PW" "$NAME" \
  psql -h localhost -U postgres -d postgres -X "$@"
