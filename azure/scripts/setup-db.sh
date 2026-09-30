#!/usr/bin/env bash
# Maakt de Supabase-rollen en -schema's aan op Azure Postgres (db/roles.sql) en zet
# de verbindingsgegevens van elke dienst in Key Vault. Opnieuw draaien kan.
# Nodig: provision.sh en generate-secrets.sh zijn gedraaid.
set -euo pipefail
cd "$(dirname "$0")"
source config.sh
open_firewall; trap close_firewall EXIT

export PGPASSWORD; PGPASSWORD=$(secret pg-admin-password)
AUTHENTICATOR_PW=$(secret pg-authenticator-password)
AUTH_PW=$(secret pg-auth-admin-password)
STORAGE_PW=$(secret pg-storage-admin-password)

"$PGBIN/psql" "host=$PG_HOST port=5432 dbname=postgres user=$PG_ADMIN sslmode=require" -X -q \
  -v authenticator_password="$AUTHENTICATOR_PW" \
  -v auth_admin_password="$AUTH_PW" \
  -v storage_admin_password="$STORAGE_PW" \
  -f ../db/roles.sql

url() {
  local pw; pw=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$2")
  printf 'postgres://%s:%s@%s:5432/postgres?sslmode=require' "$1" "$pw" "$PG_HOST"
}
az keyvault secret set --vault-name "$KV" -n auth-db-url --value "$(url supabase_auth_admin "$AUTH_PW")" -o none
az keyvault secret set --vault-name "$KV" -n rest-db-url --value "$(url authenticator "$AUTHENTICATOR_PW")" -o none
az keyvault secret set --vault-name "$KV" -n storage-db-url --value "$(url supabase_storage_admin "$STORAGE_PW")" -o none
# de LEAP-server verbindt als serverbeheerder, zoals hij bij Supabase als "postgres" verbond
az keyvault secret set --vault-name "$KV" -n app-db-url --value "$(url "$PG_ADMIN" "$PGPASSWORD")" -o none

echo "Databaserollen staan klaar; verbindingsgegevens staan in $KV."
