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
# Een eigen Postgres-server voor LEAP (de oudere leap-db-dev blijft ongemoeid).
# Het beheerderswachtwoord staat in Key Vault als pg-admin-password.
PG_SERVER=vu-leap-db
PG_HOST=$PG_SERVER.postgres.database.azure.com
PG_ADMIN=leapadmin
PG_DB=postgres
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
AOAI_MODEL_HINT=gpt-5.2   # OPENAI_MODEL: modelnaam voor de parameterkeuze, zoals op Replit
AOAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small
AOAI_API_VERSION=2024-10-21

# E-mail via Azure Communication Services, vanaf het domein van de
# Onderwijswerkplaats. Dat domein (vu-edulab.nl) staat in vu-education-lab-rg en
# ontvangt zelf geen e-mail: antwoorden gaan naar MAIL_REPLY_TO.
ACS=vu-leap-acs
MAIL_DOMAIN_RG=vu-education-lab-rg
MAIL_EMAIL_SERVICE=vu-referentietoets-email
MAIL_DOMAIN=vu-edulab.nl
MAIL_SENDER_NAME=leap
MAIL_SENDER=$MAIL_SENDER_NAME@$MAIL_DOMAIN
MAIL_REPLY_TO=l.d.j.kuijper@vu.nl

# Adressen. LEAP zelf staat op het eigen adres leap.vu-edulab.nl; de
# Supabase-onderdelen op het standaarddomein van de Container Apps-omgeving.
DOMAIN=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query properties.defaultDomain -o tsv 2>/dev/null || true)
SUPABASE_PUBLIC_URL="https://$SUPABASE_APP.$DOMAIN"
APP_URL=https://leap.vu-edulab.nl

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
