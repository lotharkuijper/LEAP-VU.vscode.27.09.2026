#!/usr/bin/env bash
# Removes the local database container (and its network), but only when this
# tool created them (Docker label nl.vu.leap.tool=local-db).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
for c in "$NAME-storage" "$NAME"; do
  if owned_container_exists "$c"; then docker rm -f "$c" >/dev/null && echo "verwijderd: $c"; fi
done
if [[ "$(docker network inspect -f "{{ index .Labels \"$LABEL_KEY\" }}" "$NET" 2>/dev/null)" == "$LABEL_VAL" ]]; then
  docker network rm "$NET" >/dev/null && echo "verwijderd: netwerk $NET"
fi
