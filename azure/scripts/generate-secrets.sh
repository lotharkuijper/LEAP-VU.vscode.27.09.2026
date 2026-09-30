#!/usr/bin/env bash
# Eenmalig: maakt de geheimen die de Supabase-onderdelen nodig hebben en zet ze in Key Vault.
#   jwt-secret          ondertekent de inlogtokens
#   anon-key            publieke API-sleutel (zelfde rol als de anon-key van Supabase)
#   service-role-key    beheersleutel (zelfde rol als de service_role-key van Supabase)
#   auth-hook-secret    ondertekent de aanroep waarmee de inlogdienst de app een e-mail laat versturen
#   pg-*-password       wachtwoorden van de databasegebruikers van Auth, PostgREST en Storage
# Toont nooit een geheim. Bestaande geheimen blijven staan, dus opnieuw draaien kan.
set -euo pipefail
source "$(dirname "$0")/config.sh"

exists() { az keyvault secret show --vault-name "$KV" -n "$1" --query id -o tsv >/dev/null 2>&1; }
put() { az keyvault secret set --vault-name "$KV" -n "$1" --value "$2" -o none && echo "opgeslagen: $1"; }
random() { python3 -c 'import secrets; print(secrets.token_urlsafe(int(__import__("sys").argv[1])))' "$1"; }

exists jwt-secret || put jwt-secret "$(random 48)"
JWT_SECRET=$(secret jwt-secret)

# langlopende HS256-tokens met alleen een rol, zoals de API-sleutels van Supabase
mint() {
  JWT_SECRET="$JWT_SECRET" python3 - "$1" <<'PY'
import base64, hashlib, hmac, json, os, sys, time
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
now = int(time.time())
head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
body = b64(json.dumps({"role": sys.argv[1], "iss": "supabase", "iat": now, "exp": now + 10 * 365 * 86400}, separators=(",", ":")).encode())
sig = b64(hmac.new(os.environ["JWT_SECRET"].encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
print(f"{head}.{body}.{sig}")
PY
}
exists anon-key || put anon-key "$(mint anon)"
exists service-role-key || put service-role-key "$(mint service_role)"

# Standard Webhooks-vorm: "v1,whsec_<base64>"
exists auth-hook-secret || put auth-hook-secret \
  "v1,whsec_$(python3 -c 'import base64, secrets; print(base64.b64encode(secrets.token_bytes(32)).decode())')"

for name in pg-authenticator-password pg-auth-admin-password pg-storage-admin-password; do
  exists "$name" || put "$name" "$(random 32)"
done
