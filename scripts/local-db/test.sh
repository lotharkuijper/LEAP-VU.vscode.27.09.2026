#!/usr/bin/env bash
# Runs every scripts/local-db/tests/*.sql against the local database (as the
# postgres role, inside the container). Fails when a file errors or when any
# output line starts with FAIL.
#
#   bash scripts/local-db/test.sh              all tests
#   bash scripts/local-db/test.sh rls-demo     only tests/rls-demo.sql
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_running

# The fixture is idempotent; loading it here means the tests also work after --no-seed.
psql_as postgres -f /localdb/seed.sql

shopt -s nullglob
if [[ $# -gt 0 ]]; then files=(); for t in "$@"; do files+=("$HERE/tests/${t%.sql}.sql"); done
else files=("$HERE"/tests/*.sql); fi
[[ ${#files[@]} -gt 0 ]] || die "geen tests gevonden in $HERE/tests"

failed=0
for f in "${files[@]}"; do
  name="$(basename "$f")"
  [[ -f "$f" ]] || { echo "FAIL $name: bestand bestaat niet"; failed=1; continue; }
  echo "== $name"
  if out="$(psql_as postgres -At -f "/localdb/tests/$name" 2>&1)"; then rc=0; else rc=$?; fi
  grep -v "^$" <<<"$out" || true
  if [[ $rc != 0 ]]; then echo "FAIL $name: psql stopte met een fout (exitcode $rc)"; failed=1
  elif grep -q '^FAIL' <<<"$out"; then failed=1; fi
done

echo
if [[ $failed == 0 ]]; then echo "Alle tests geslaagd."; else echo "Er zijn tests mislukt."; exit 1; fi
