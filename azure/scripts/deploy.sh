#!/usr/bin/env bash
# Bouwt de images in het Azure-register en maakt de Container Apps aan of werkt ze bij.
#   ./deploy.sh                  alles
#   ./deploy.sh app              alleen deze (storage, supabase, app)
# De app wordt gebouwd uit deze repo, op de stand die nu is uitgecheckt. Geheimen
# lezen de apps zelf uit Key Vault.
# Normaal rolt GitHub de app uit bij elke push naar main (.github/workflows/
# azure-deploy.yml); dit script is voor de eerste keer, voor de Supabase-onderdelen
# en als terugval.
set -euo pipefail
cd "$(dirname "$0")"
source config.sh
REPO=$(cd ../.. && pwd)

ENV_ID=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query id -o tsv)
IDENTITY_ID=$(az identity show -g "$RG" -n "$IDENTITY" --query id -o tsv)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# Supabase-images staan op Docker Hub; een kopie in het eigen register maakt
# het starten onafhankelijk van Docker Hub.
mirror() {
  local ref=${1#"$ACR.azurecr.io/"}
  az acr repository show -n "$ACR" --image "$ref" -o none 2>/dev/null || \
    az acr import -n "$ACR" --source "docker.io/$ref" --image "$ref" -o none
}

# build <map> <image> [extra argumenten voor az acr build] -> geeft de volledige imagenaam
build() {
  local dir=$1 image=$2 tag; shift 2
  tag=$(git -C "$REPO" rev-parse --short HEAD)
  git -C "$REPO" diff --quiet HEAD || tag="$tag-dirty"
  az acr build -r "$ACR" -t "$image:$tag" "$@" "$dir" --no-logs -o none >&2
  echo "$ACR.azurecr.io/$image:$tag"
}

# header <extern: true|false> <poort> <geheimen uit Key Vault...>
header() {
  local external=$1 port=$2; shift 2
  cat <<YAML
location: $LOCATION
identity:
  type: UserAssigned
  userAssignedIdentities:
    "$IDENTITY_ID": {}
tags: {project: leap, env: prod, owner: "l.d.j.kuijper@vu.nl"}
properties:
  environmentId: $ENV_ID
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: $external
      targetPort: $port
      transport: auto
      allowInsecure: false
    registries:
      - server: $ACR.azurecr.io
        username: $ACR
        passwordSecretRef: acr-password
    secrets:
YAML
  for s in acr-password "$@"; do
    cat <<YAML
      - name: $s
        keyVaultUrl: https://$KV.vault.azure.net/secrets/$s
        identity: $IDENTITY_ID
YAML
  done
}

apply() {
  local name=$1 file=$2
  if az containerapp show -g "$RG" -n "$name" -o none 2>/dev/null; then
    az containerapp update -g "$RG" -n "$name" --yaml "$file" -o none
  else
    az containerapp create -g "$RG" -n "$name" --yaml "$file" -o none
  fi
  echo "$name -> https://$(az containerapp show -g "$RG" -n "$name" --query properties.configuration.ingress.fqdn -o tsv)"
}

# Supabase Storage, alleen intern bereikbaar (via de gateway). Bestanden gaan naar
# Azure Blob Storage via s3proxy, dat de S3-taal van Storage vertaalt; s3proxy
# luistert alleen binnen deze app.
deploy_storage() {
  mirror "$STORAGE_IMAGE"; mirror "$S3PROXY_IMAGE"
  { header false 5000 jwt-secret anon-key service-role-key storage-db-url storage-account-key
    cat <<YAML
  template:
    containers:
      - name: storage
        image: $STORAGE_IMAGE
        resources: {cpu: 0.5, memory: 1Gi}
        env:
          - {name: ANON_KEY, secretRef: anon-key}
          - {name: SERVICE_KEY, secretRef: service-role-key}
          - {name: AUTH_JWT_SECRET, secretRef: jwt-secret}
          - {name: DATABASE_URL, secretRef: storage-db-url}
          - {name: POSTGREST_URL, value: "http://$SUPABASE_APP/rest/v1"}
          - {name: STORAGE_PUBLIC_URL, value: "$SUPABASE_PUBLIC_URL"}
          - {name: REQUEST_ALLOW_X_FORWARDED_PATH, value: "true"}
          - {name: FILE_SIZE_LIMIT, value: "52428800"}
          - {name: STORAGE_BACKEND, value: s3}
          - {name: GLOBAL_S3_BUCKET, value: $BLOB_CONTAINER}
          - {name: GLOBAL_S3_ENDPOINT, value: "http://127.0.0.1:8081"}
          - {name: GLOBAL_S3_PROTOCOL, value: http}
          - {name: GLOBAL_S3_FORCE_PATH_STYLE, value: "true"}
          - {name: AWS_ACCESS_KEY_ID, value: local}
          - {name: AWS_SECRET_ACCESS_KEY, value: local}
          - {name: TENANT_ID, value: stub}
          - {name: REGION, value: local}
          - {name: ENABLE_IMAGE_TRANSFORMATION, value: "false"}
      - name: s3proxy
        image: $S3PROXY_IMAGE
        resources: {cpu: 0.25, memory: 0.5Gi}
        env:
          - {name: S3PROXY_ENDPOINT, value: "http://127.0.0.1:8081"}
          - {name: S3PROXY_AUTHORIZATION, value: none}
          - {name: S3PROXY_IGNORE_UNKNOWN_HEADERS, value: "true"}
          - {name: S3PROXY_JAVA_OPTS, value: "-Xmx256m"}
          - {name: JCLOUDS_PROVIDER, value: azureblob}
          - {name: JCLOUDS_IDENTITY, value: $STORAGE}
          - {name: JCLOUDS_CREDENTIAL, secretRef: storage-account-key}
          - {name: JCLOUDS_ENDPOINT, value: "https://$STORAGE.blob.core.windows.net"}
    scale: {minReplicas: 1, maxReplicas: 1}
YAML
  } > "$WORK/storage.yaml"
  apply "$STORAGE_APP" "$WORK/storage.yaml"
}

# "Onze Supabase": gateway + Supabase Auth + PostgREST in één app, één publiek adres.
# Inloggen werkt als bij Supabase in de cloud: e-mail + wachtwoord, bevestiging per
# e-mail. De e-mails zelf verstuurt de LEAP-server (server/authEmailHook.js).
deploy_supabase() {
  mirror "$GOTRUE_IMAGE"; mirror "$POSTGREST_IMAGE"
  local gateway; gateway=$(build "$REPO/azure/gateway" leap-gateway)
  { header true 8080 jwt-secret auth-db-url rest-db-url auth-hook-secret
    cat <<YAML
  template:
    containers:
      - name: gateway
        image: $gateway
        resources: {cpu: 0.25, memory: 0.5Gi}
        env:
          - {name: STORAGE_UPSTREAM, value: "http://$STORAGE_APP"}
      - name: auth
        image: $GOTRUE_IMAGE
        resources: {cpu: 0.25, memory: 0.5Gi}
        env:
          - {name: GOTRUE_API_HOST, value: "0.0.0.0"}
          - {name: GOTRUE_API_PORT, value: "9999"}
          - {name: API_EXTERNAL_URL, value: "$SUPABASE_PUBLIC_URL"}
          - {name: GOTRUE_DB_DRIVER, value: postgres}
          - {name: GOTRUE_DB_DATABASE_URL, secretRef: auth-db-url}
          - {name: GOTRUE_DB_MAX_POOL_SIZE, value: "5"}
          - {name: GOTRUE_SITE_URL, value: "$APP_URL"}
          - {name: GOTRUE_URI_ALLOW_LIST, value: "$APP_URL/**"}
          - {name: GOTRUE_DISABLE_SIGNUP, value: "false"}
          - {name: GOTRUE_JWT_ADMIN_ROLES, value: service_role}
          - {name: GOTRUE_JWT_AUD, value: authenticated}
          - {name: GOTRUE_JWT_DEFAULT_GROUP_NAME, value: authenticated}
          - {name: GOTRUE_JWT_EXP, value: "3600"}
          - {name: GOTRUE_JWT_SECRET, secretRef: jwt-secret}
          - {name: GOTRUE_JWT_ISSUER, value: "$SUPABASE_PUBLIC_URL/auth/v1"}
          - {name: GOTRUE_EXTERNAL_EMAIL_ENABLED, value: "true"}
          - {name: GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED, value: "false"}
          - {name: GOTRUE_EXTERNAL_PHONE_ENABLED, value: "false"}
          - {name: GOTRUE_MAILER_AUTOCONFIRM, value: "false"}
          - {name: GOTRUE_HOOK_SEND_EMAIL_ENABLED, value: "true"}
          - {name: GOTRUE_HOOK_SEND_EMAIL_URI, value: "$APP_URL/api/auth/email-hook"}
          - {name: GOTRUE_HOOK_SEND_EMAIL_SECRETS, secretRef: auth-hook-secret}
          - {name: GOTRUE_RATE_LIMIT_EMAIL_SENT, value: "80"}
      - name: rest
        image: $POSTGREST_IMAGE
        resources: {cpu: 0.25, memory: 0.5Gi}
        env:
          - {name: PGRST_DB_URI, secretRef: rest-db-url}
          - {name: PGRST_DB_SCHEMAS, value: public}
          - {name: PGRST_DB_MAX_ROWS, value: "1000"}
          - {name: PGRST_DB_EXTRA_SEARCH_PATH, value: "public,extensions"}
          - {name: PGRST_DB_ANON_ROLE, value: anon}
          - {name: PGRST_DB_POOL, value: "8"}
          - {name: PGRST_JWT_SECRET, secretRef: jwt-secret}
          - {name: PGRST_DB_USE_LEGACY_GUCS, value: "false"}
          - {name: PGRST_APP_SETTINGS_JWT_EXP, value: "3600"}
    scale: {minReplicas: 1, maxReplicas: 1}
YAML
  } > "$WORK/supabase.yaml"
  apply "$SUPABASE_APP" "$WORK/supabase.yaml"
}

# LEAP zelf: de Express-server die ook de frontend serveert. Precies één kopie
# die altijd draait: lopende taken (begrippen extraheren) en de tijdklok voor de
# Studiecafé-mails leven in het geheugen van dit proces.
deploy_app() {
  local image; image=$(build "$REPO" leap-app \
    --build-arg VITE_PUBLIC_SUPABASE_URL="$SUPABASE_PUBLIC_URL" \
    --build-arg VITE_PUBLIC_SUPABASE_ANON_KEY="$(secret anon-key)" \
    --build-arg VITE_PUBLIC_REALTIME=off)
  { header true 3001 anon-key service-role-key app-db-url azure-openai-api-key auth-hook-secret acs-connection-string
    cat <<YAML
  template:
    containers:
      - name: app
        image: $image
        resources: {cpu: 1.0, memory: 2Gi}
        env:
          - {name: VITE_PUBLIC_SUPABASE_URL, value: "$SUPABASE_PUBLIC_URL"}
          - {name: SUPABASE_URL, value: "$SUPABASE_PUBLIC_URL"}
          - {name: VITE_PUBLIC_SUPABASE_ANON_KEY, secretRef: anon-key}
          - {name: SUPABASE_ANON_KEY, secretRef: anon-key}
          - {name: SUPABASE_SERVICE_ROLE_KEY, secretRef: service-role-key}
          - {name: SUPABASE_DB_URL, secretRef: app-db-url}
          - {name: MIGRATE_ON_START, value: "true"}
          - {name: AZURE_OPENAI_ENDPOINT, value: "$AOAI_ENDPOINT"}
          - {name: AZURE_OPENAI_API_KEY, secretRef: azure-openai-api-key}
          - {name: AZURE_OPENAI_DEPLOYMENT, value: "$AOAI_DEPLOYMENT"}
          - {name: AZURE_OPENAI_EMBEDDING_DEPLOYMENT, value: "$AOAI_EMBEDDING_DEPLOYMENT"}
          - {name: AZURE_OPENAI_API_VERSION, value: "$AOAI_API_VERSION"}
          - {name: APP_BASE_URL, value: "$APP_URL"}
          - {name: APP_PUBLIC_URL, value: "$APP_URL"}
          - {name: AUTH_EMAIL_HOOK_SECRET, secretRef: auth-hook-secret}
          - {name: ACS_CONNECTION_STRING, secretRef: acs-connection-string}
          - {name: ACS_SENDER, value: "$MAIL_SENDER"}
          - {name: MAIL_REPLY_TO, value: "$MAIL_REPLY_TO"}
        probes:
          - type: Startup
            httpGet: {path: /api/health, port: 3001}
            periodSeconds: 5
            failureThreshold: 60
    scale: {minReplicas: 1, maxReplicas: 1}
YAML
  } > "$WORK/app.yaml"
  apply "$APP" "$WORK/app.yaml"
}

targets=("$@")
[[ ${#targets[@]} -eq 0 ]] && targets=(storage supabase app)
for t in "${targets[@]}"; do "deploy_$t"; done
