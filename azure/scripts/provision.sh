#!/usr/bin/env bash
# Eenmalig: maakt de Azure-onderdelen voor LEAP aan in vu-leap-rg. Bestaande
# onderdelen blijven staan, dus opnieuw draaien kan geen kwaad.
#   logboek, Container Apps-omgeving, register voor images, opslagaccount,
#   Key Vault, twee identiteiten (apps + GitHub-uitrol) en de e-mailresource.
# De database is de bestaande server leap-db-dev; die wordt alleen ingesteld.
set -euo pipefail
source "$(dirname "$0")/config.sh"
ME=$(az ad signed-in-user show --query id -o tsv)
have() { az resource list -g "$RG" --query "[?name=='$1'] | length(@)" -o tsv | grep -qv '^0$'; }

have "$LOGS" || az monitor log-analytics workspace create -g "$RG" -n "$LOGS" -l "$LOCATION" \
  --retention-time 30 --tags $TAGS -o none
have "$ENV_NAME" || az containerapp env create -g "$RG" -n "$ENV_NAME" -l "$LOCATION" \
  --logs-workspace-id "$(az monitor log-analytics workspace show -g "$RG" -n "$LOGS" --query customerId -o tsv)" \
  --logs-workspace-key "$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LOGS" --query primarySharedKey -o tsv)" \
  --tags $TAGS -o none

have "$ACR" || az acr create -g "$RG" -n "$ACR" --sku Basic --admin-enabled true -l "$LOCATION" --tags $TAGS -o none

have "$STORAGE" || az storage account create -g "$RG" -n "$STORAGE" -l "$LOCATION" --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access false --tags $TAGS -o none
az storage container create --account-name "$STORAGE" -n "$BLOB_CONTAINER" --auth-mode key \
  --account-key "$(az storage account keys list -g "$RG" -n "$STORAGE" --query '[0].value' -o tsv)" -o none

for id in "$IDENTITY" "$DEPLOY_IDENTITY"; do
  have "$id" || az identity create -g "$RG" -n "$id" -l "$LOCATION" --tags $TAGS -o none
done

# GitHub mag zich zonder wachtwoord aanmelden als id-leap-deploy, alleen vanaf
# deze repo en branch. De rol op de resourcegroep kent een Owner toe (zie README).
az identity federated-credential create -g "$RG" --identity-name "$DEPLOY_IDENTITY" -n "gh-$GH_BRANCH" \
  --issuer https://token.actions.githubusercontent.com --audiences api://AzureADTokenExchange \
  --subject "repo:$GH_REPO:ref:refs/heads/$GH_BRANCH" -o none

# Key Vault met toegangsbeleid (geen RBAC): zo kan een Contributor de apps
# leesrechten op de geheimen geven zonder dat een Owner rollen hoeft toe te kennen.
have "$KV" || az keyvault create -g "$RG" -n "$KV" -l "$LOCATION" --enable-rbac-authorization false --tags $TAGS -o none
az keyvault set-policy -n "$KV" --object-id "$ME" --secret-permissions get list set delete recover purge -o none
for id in "$IDENTITY" "$DEPLOY_IDENTITY"; do
  az keyvault set-policy -n "$KV" --object-id "$(az identity show -g "$RG" -n "$id" --query principalId -o tsv)" \
    --secret-permissions get -o none
done

# De bestaande Postgres-server: extensies toestaan die Supabase nodig heeft en
# Azure-diensten (de Container Apps) toelaten. Het beheerderswachtwoord moet al
# in Key Vault staan; dit script kent of wijzigt het niet.
if ! az keyvault secret show --vault-name "$KV" -n pg-admin-password -o none 2>/dev/null; then
  echo "Zet eerst het wachtwoord van $PG_ADMIN op $PG_SERVER in Key Vault (in je eigen terminal, niet in een chat):" >&2
  echo "  read -s PW && az keyvault secret set --vault-name $KV -n pg-admin-password --value \"\$PW\" -o none" >&2
  exit 1
fi
az postgres flexible-server parameter set -g "$RG" -s "$PG_SERVER" -n azure.extensions \
  --value VECTOR,PGCRYPTO,UUID-OSSP,PG_STAT_STATEMENTS -o none
az rest --method put -o none \
  --url "https://management.azure.com$(az postgres flexible-server show -g "$RG" -n "$PG_SERVER" --query id -o tsv)/firewallRules/AllowAllAzureServicesAndResourcesWithinAzureIps?api-version=2024-08-01" \
  --body '{"properties":{"startIpAddress":"0.0.0.0","endIpAddress":"0.0.0.0"}}'

# E-mail: een eigen Communication Services-resource, gekoppeld aan het gedeelde
# domein, en een afzender <naam>@vu-edulab.nl op dat domein.
DOMAIN_ID=$(az communication email domain show --email-service-name "$MAIL_EMAIL_SERVICE" -g "$MAIL_DOMAIN_RG" \
  --domain-name "$MAIL_DOMAIN" --query id -o tsv)
have "$ACS" || az communication create -g "$RG" -n "$ACS" --location global --data-location Europe \
  --linked-domains "$DOMAIN_ID" --tags $TAGS -o none
az communication email domain sender-username create --email-service-name "$MAIL_EMAIL_SERVICE" -g "$MAIL_DOMAIN_RG" \
  --domain-name "$MAIL_DOMAIN" --sender-username "$MAIL_SENDER_NAME" --username "$MAIL_SENDER_NAME" \
  --display-name "LEAP" -o none
az keyvault secret set --vault-name "$KV" -n acs-connection-string -o none \
  --value "$(az communication list-key -g "$RG" -n "$ACS" --query primaryConnectionString -o tsv)"

# Overige geheimen die de apps nodig hebben
az keyvault secret set --vault-name "$KV" -n acr-password -o none \
  --value "$(az acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv)"
az keyvault secret set --vault-name "$KV" -n storage-account-key -o none \
  --value "$(az storage account keys list -g "$RG" -n "$STORAGE" --query '[0].value' -o tsv)"
az keyvault secret set --vault-name "$KV" -n azure-openai-api-key -o none \
  --value "$(az cognitiveservices account keys list -n "$AOAI_NAME" -g "$AOAI_RG" --query key1 -o tsv)"

# Melding per e-mail bij 80% van het maandbudget en als de verwachting erboven komt
az rest --method put -o none \
  --url "https://management.azure.com$(az group show -n "$RG" --query id -o tsv)/providers/Microsoft.Consumption/budgets/leap-maandbudget?api-version=2023-05-01" \
  --body "{\"properties\":{\"category\":\"Cost\",\"amount\":$BUDGET_EUR,\"timeGrain\":\"Monthly\",
    \"timePeriod\":{\"startDate\":\"$(date -u +%Y-%m-01)T00:00:00Z\"},
    \"notifications\":{
      \"werkelijk80\":{\"enabled\":true,\"operator\":\"GreaterThan\",\"threshold\":80,\"thresholdType\":\"Actual\",\"contactEmails\":[\"$BUDGET_EMAIL\"]},
      \"verwacht100\":{\"enabled\":true,\"operator\":\"GreaterThan\",\"threshold\":100,\"thresholdType\":\"Forecasted\",\"contactEmails\":[\"$BUDGET_EMAIL\"]}}}}" \
  || echo "Let op: het budget kon niet worden ingesteld; stel het zo nodig in via de portal (Cost Management -> Budgets)."

echo "GitHub-uitrol: client-id van $DEPLOY_IDENTITY = $(az identity show -g "$RG" -n "$DEPLOY_IDENTITY" --query clientId -o tsv)"
echo "Klaar. Volgende stappen: generate-secrets.sh, setup-db.sh, deploy.sh"
