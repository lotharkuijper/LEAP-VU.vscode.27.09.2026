# Gedeelde namen voor LEAP op Azure. Wordt door de andere scripts ingelezen.
# Alles staat in resourcegroep vu-leap-rg (abonnement "VU - BETA AI Hub Pilot").

RG=vu-leap-rg
LOCATION=westeurope
KV=kv-vu-leap
ACR=vuleapacr
ENV_NAME=vu-leap-env
LOGS=vu-leap-logs
STORAGE=vuleapstorage
BLOB_CONTAINER=supabase-storage
IDENTITY=id-leap-apps
DEPLOY_IDENTITY=id-leap-deploy
PG_SERVER=vu-leap-db
PG_HOST=$PG_SERVER.postgres.database.azure.com
PG_ADMIN=leapadmin
TAGS="project=leap env=prod owner=l.d.j.kuijper@vu.nl"

# GitHub rolt uit vanaf deze repo en branch; kosten-meldingen gaan naar dit adres.
GH_REPO=lotharkuijper/LEAP-VU.vscode.27.09.2026
GH_BRANCH=main
BUDGET_EUR=150
BUDGET_EMAIL=l.d.j.kuijper@vu.nl

APP=vu-leap-app
SUPABASE_APP=vu-leap-supabase
STORAGE_APP=vu-leap-storage

# Taalmodellen: de bestaande VU-resource (Rob van Leeuwen), alleen DataZoneStandard.
AOAI_NAME=leap-openai-vu
AOAI_RG=vu-education-lab-rg
AOAI_ENDPOINT=https://leap-openai-vu.openai.azure.com
AOAI_DEPLOYMENT=gpt-5.5
AOAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small
AOAI_API_VERSION=2024-10-21

# E-mail: gedeelde identiteit van de Onderwijswerkplaats, verstuurt via Microsoft Graph.
MAIL_IDENTITY_ID=/subscriptions/d9de8af9-cb28-4ae5-b8ae-67d88e3169d5/resourceGroups/vu-education-lab-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi-mailsend-onderwijswerkplaats
MAIL_SENDER=onderwijswerkplaats@vu.nl

# Adressen. Het standaarddomein hoort bij de Container Apps-omgeving; APP_URL
# wordt het eigen adres zodra leap.vu-edulab.nl is gekoppeld.
DOMAIN=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query properties.defaultDomain -o tsv 2>/dev/null || true)
SUPABASE_PUBLIC_URL="https://$SUPABASE_APP.$DOMAIN"
APP_URL=${APP_URL:-"https://$APP.$DOMAIN"}

# Supabase-onderdelen, vastgepind. Zelfde versies als de referentie-opzet van
# Supabase (docker-compose) van september 2026.
GOTRUE_IMAGE="$ACR.azurecr.io/supabase/gotrue:v2.197.0"
POSTGREST_IMAGE="$ACR.azurecr.io/postgrest/postgrest:v14.17"
REALTIME_IMAGE="$ACR.azurecr.io/supabase/realtime:v2.134.10"
STORAGE_IMAGE="$ACR.azurecr.io/supabase/storage-api:v1.79.23"
S3PROXY_IMAGE="$ACR.azurecr.io/andrewgaul/s3proxy:4.1.1"

# Postgres 17-clienttools (de standaard-psql van Homebrew is ouder en kan een
# 17-server niet dumpen): brew install libpq@18
PGBIN=${PGBIN:-/opt/homebrew/opt/libpq@18/bin}

secret() { az keyvault secret show --vault-name "$KV" -n "$1" --query value -o tsv; }

# De database laat alleen Azure-diensten toe. Scripts die vanaf een laptop met
# de database praten, zetten het eigen adres er tijdelijk bij.
FIREWALL_RULE="beheer-$(whoami)"
firewall_url() {
  echo "https://management.azure.com$(az postgres flexible-server show -g "$RG" -n "$PG_SERVER" --query id -o tsv)/firewallRules/$FIREWALL_RULE?api-version=2024-08-01"
}
open_firewall() {
  local ip; ip=$(curl -fsS https://api.ipify.org)
  az rest --method put --url "$(firewall_url)" -o none \
    --body "{\"properties\":{\"startIpAddress\":\"$ip\",\"endIpAddress\":\"$ip\"}}"
  sleep 20 # de regel is pas na enkele seconden actief
}
close_firewall() {
  az rest --method delete --url "$(firewall_url)" -o none 2>/dev/null || true
}
