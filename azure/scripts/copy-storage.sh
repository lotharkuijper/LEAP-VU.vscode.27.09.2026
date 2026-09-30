#!/usr/bin/env bash
# Kopieert alle geüploade bestanden van Supabase Storage naar de Storage op Azure.
# Leest alleen uit Supabase. Nodig:
#   SOURCE_URL  adres van het Supabase-project (https://<project>.supabase.co)
#   SOURCE_KEY  de service_role-sleutel van dat project
# Beide staan in de .env van de huidige LEAP-omgeving (VITE_PUBLIC_SUPABASE_URL en
# SUPABASE_SERVICE_ROLE_KEY).
set -euo pipefail
cd "$(dirname "$0")"
source config.sh
# Ontbreken ze, dan worden de geheimen source-supabase-url en
# source-supabase-service-key uit Key Vault gebruikt.
SOURCE_URL=${SOURCE_URL:-$(secret source-supabase-url 2>/dev/null || true)}
SOURCE_KEY=${SOURCE_KEY:-$(secret source-supabase-service-key 2>/dev/null || true)}
: "${SOURCE_URL:?Zet SOURCE_URL op het adres van het Supabase-project}"
: "${SOURCE_KEY:?Zet SOURCE_KEY op de service_role-sleutel van het Supabase-project}"

SOURCE_URL=$SOURCE_URL \
SOURCE_KEY=$SOURCE_KEY \
TARGET_URL=$SUPABASE_PUBLIC_URL \
TARGET_KEY=$(secret service-role-key) \
  python3 copy-storage.py
