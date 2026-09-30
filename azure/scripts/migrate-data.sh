#!/usr/bin/env bash
# Kopieert de huidige Supabase-database naar Azure Postgres: de tabellen van de app
# (schema public), de accounts (auth.users + auth.identities, inclusief
# wachtwoord-hashes, zodat iedereen zijn inlog houdt) en de toegangsregels van de
# bestandsopslag. LEEST alleen uit Supabase; de draaiende omgeving wordt niet geraakt.
# Opnieuw draaien vervangt de kopie op Azure, dus vlak voor de overstap kan dit nog eens.
#
# Nodig:
#   SUPABASE_DB_URL  van het Supabase-project: dashboard -> Connect -> "Session pooler"
#                    (dezelfde waarde als in de .env van de huidige LEAP-omgeving)
#   setup-db.sh is gedraaid en vu-leap-supabase en vu-leap-storage hebben één keer
#   gedraaid (Auth en Storage maken dan hun eigen tabellen aan)
set -euo pipefail
cd "$(dirname "$0")"
source config.sh
: "${SUPABASE_DB_URL:?Zet SUPABASE_DB_URL op de session-pooler-verbinding van het Supabase-project}"
SOURCE=$SUPABASE_DB_URL
open_firewall; trap 'close_firewall; rm -rf "$WORK"' EXIT

WORK=$(mktemp -d)
ADMIN_PW=$(secret pg-admin-password)
AUTH_PW=$(secret pg-auth-admin-password)
STORAGE_PW=$(secret pg-storage-admin-password)
ADMIN="host=$PG_HOST port=5432 dbname=$PG_DB user=$PG_ADMIN sslmode=require"
AUTH_ADMIN="host=$PG_HOST port=5432 dbname=$PG_DB user=supabase_auth_admin sslmode=require"
STORAGE_ADMIN="host=$PG_HOST port=5432 dbname=$PG_DB user=supabase_storage_admin sslmode=require"
admin() { PGPASSWORD=$ADMIN_PW "$@"; }
auth_admin() { PGPASSWORD=$AUTH_PW "$@"; }
storage_admin() { PGPASSWORD=$STORAGE_PW "$@"; }
source_sql() { "$PGBIN/psql" "$SOURCE" -X -At -c "$1"; }
restore() { # restore <sectie>; toont echte fouten maar gaat door, zoals pg_restore gewoonlijk doet
  admin "$PGBIN/pg_restore" --no-owner --section="$1" -L "$WORK/list" -d "$ADMIN" "$WORK/public.dump" 2>&1 \
    | grep -E '^pg_restore: error' | grep -v 'already exists' || true
}

echo "1/7 Controleren of de versies bij elkaar passen"
# Een kopie uit een nieuwere Postgres past niet altijd in een oudere.
src_pg=$(source_sql "select current_setting('server_version_num')::int / 10000")
dst_pg=$(admin "$PGBIN/psql" "$ADMIN" -X -At -c "select current_setting('server_version_num')::int / 10000")
if (( src_pg > dst_pg )); then
  echo "Supabase draait Postgres $src_pg, $PG_SERVER draait $dst_pg. Werk de server eerst bij:" >&2
  echo "  az postgres flexible-server upgrade -g $RG -n $PG_SERVER --version $src_pg" >&2
  exit 1
fi
# De accounts worden kolom voor kolom gekopieerd; de inlogdienst op Azure mag dus
# niet ouder zijn dan die van het Supabase-project.
src_auth=$(source_sql "select max(version) from auth.schema_migrations")
dst_auth=$(auth_admin "$PGBIN/psql" "$AUTH_ADMIN" -X -At -c "select max(version) from auth.schema_migrations")
if [[ "$src_auth" > "$dst_auth" ]]; then
  echo "De inlogdienst op Azure (auth-schema $dst_auth) is ouder dan die van Supabase ($src_auth)." >&2
  echo "Zet GOTRUE_IMAGE in config.sh op een nieuwere versie en draai: deploy.sh supabase" >&2
  exit 1
fi
# pgvector in hetzelfde schema als in de bron, anders kloppen de kolomtypes in de kopie niet
vector_schema=$(source_sql "select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'vector'")
other_ext=$(source_sql "select string_agg(extname, ', ') from pg_extension where extname not in ('vector','plpgsql','pgcrypto','uuid-ossp','pg_stat_statements','pg_graphql','supabase_vault','pgsodium','pg_net','pgjwt','pg_cron')")
[[ -n "$other_ext" ]] && echo "   Let op: de bron gebruikt ook de extensie(s) $other_ext; zet die zo nodig aan op Azure (azure.extensions)."

echo "2/7 Lezen uit Supabase"
"$PGBIN/pg_dump" "$SOURCE" --schema=public --no-owner --format=custom -f "$WORK/public.dump"
"$PGBIN/pg_dump" "$SOURCE" --data-only --table=auth.users --table=auth.identities -f "$WORK/auth-data.sql"
"$PGBIN/pg_dump" "$SOURCE" --schema-only --table=auth.users | grep '^CREATE TRIGGER' > "$WORK/auth-triggers.sql" || true
# toegangsregels op de bestandsopslag (die staan in het schema storage, niet in public);
# met een leeg zoekpad schrijft Postgres elke naam voluit, inclusief schema
"$PGBIN/psql" "$SOURCE" -X -At -q -c "set search_path = ''" -c "select format('drop policy if exists %I on storage.%I; create policy %I on storage.%I as %s for %s to %s%s%s;',
    policyname, tablename, policyname, tablename, permissive, cmd, array_to_string(roles, ', '),
    case when qual is not null then ' using (' || qual || ')' else '' end,
    case when with_check is not null then ' with check (' || with_check || ')' else '' end)
  from pg_policies where schemaname = 'storage' order by tablename, policyname" > "$WORK/storage-policies.sql"
# het schema public zelf bestaat al; de realtime-publicatie van Supabase gaat niet mee
"$PGBIN/pg_restore" -l "$WORK/public.dump" | grep -vE ' SCHEMA - public |PUBLICATION' > "$WORK/list"

echo "3/7 Eerdere kopie op Azure leegmaken"
admin "$PGBIN/psql" "$ADMIN" -X -q -v ON_ERROR_STOP=1 <<'SQL'
do $$ declare r record; begin
  for r in select viewname from pg_views where schemaname = 'public' loop
    execute format('drop view if exists public.%I cascade', r.viewname); end loop;
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('drop table if exists public.%I cascade', r.tablename); end loop;
  for r in select p.oid::regprocedure as fn from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and not exists (select from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    execute format('drop function if exists %s cascade', r.fn); end loop;
  for r in select typname from pg_type t
           where typnamespace = 'public'::regnamespace and typtype in ('e', 'c', 'd')
             and not exists (select from pg_depend d where d.objid = t.oid and d.deptype = 'e') loop
    execute format('drop type if exists public.%I cascade', r.typname); end loop;
end $$;
SQL
[[ -n "$vector_schema" ]] && admin "$PGBIN/psql" "$ADMIN" -X -q -v ON_ERROR_STOP=1 \
  -c "create extension if not exists vector schema $vector_schema"
auth_admin "$PGBIN/psql" "$AUTH_ADMIN" -X -q -v ON_ERROR_STOP=1 <<SQL
truncate auth.users cascade;
-- de tabellen en RLS-regels van de app verwijzen naar auth.users en auth.uid()
grant usage on schema auth to $PG_ADMIN;
grant select, references on auth.users to $PG_ADMIN;
grant execute on all functions in schema auth to $PG_ADMIN, postgres, anon, authenticated, service_role;
SQL

echo "4/7 Tabellen en functies van de app aanmaken"
restore pre-data

echo "5/7 Accounts kopiëren"
auth_admin "$PGBIN/psql" "$AUTH_ADMIN" -X -q -v ON_ERROR_STOP=1 -f "$WORK/auth-data.sql"

echo "6/7 Gegevens van de app kopiëren, daarna indexen, verwijzingen, regels en triggers"
restore data
restore post-data
# De triggers op auth.users (profiel aanmaken, vast beheerdersaccount) draaien als de
# databasegebruiker van Supabase Auth.
trigger_fns=$(grep -oE 'EXECUTE FUNCTION [a-z_.]+\(' "$WORK/auth-triggers.sql" | sed -E 's/EXECUTE FUNCTION (.*)\(/\1()/' | sort -u | paste -sd, -)
admin "$PGBIN/psql" "$ADMIN" -X -q -v ON_ERROR_STOP=1 -c "grant usage on schema public to supabase_auth_admin, supabase_storage_admin; grant select, insert, update on public.profiles to supabase_auth_admin;${trigger_fns:+ grant execute on function $trigger_fns to supabase_auth_admin;}"
auth_admin "$PGBIN/psql" "$AUTH_ADMIN" -X -q -v ON_ERROR_STOP=1 -f "$WORK/auth-triggers.sql"
storage_admin "$PGBIN/psql" "$STORAGE_ADMIN" -X -q -v ON_ERROR_STOP=1 -f "$WORK/storage-policies.sql"
# Alle migraties tot nu toe zitten in de kopie: leg ze vast als uitgevoerd, zodat de
# app bij het starten alleen nieuwe migraties uitvoert.
app_url=$(secret app-db-url)
(cd ../.. && SUPABASE_DB_URL=$app_url node scripts/migrate.mjs --baseline)
# PostgREST onthoudt de lijst met tabellen; laat hem de nieuwe oppikken
admin "$PGBIN/psql" "$ADMIN" -X -q -c "notify pgrst, 'reload schema'"

echo "7/7 Aantallen rijen vergelijken (Supabase tegenover Azure)"
count_sql="select 'auth.users', count(*) from auth.users union all select 'auth.identities', count(*) from auth.identities"
for t in $(source_sql "select tablename from pg_tables where schemaname = 'public' order by 1"); do
  count_sql="$count_sql union all select 'public.$t', count(*) from public.\"$t\""
done
join -t'|' -a1 -e ONTBREEKT -o '0,1.2,2.2' \
  <(source_sql "$count_sql" | sort) \
  <(admin "$PGBIN/psql" "$ADMIN" -X -At -c "$count_sql" 2>/dev/null | sort) \
  | awk -F'|' '{ printf "%-44s %8s %8s %s\n", $1, $2, $3, ($2 == $3 ? "" : "<- verschilt") }'
echo "Daarna: copy-storage.sh voor de bestanden."
