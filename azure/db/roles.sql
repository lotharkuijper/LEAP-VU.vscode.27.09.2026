-- De rollen en schema's die Supabase verwacht, op Azure Postgres. Komt overeen
-- met wat de database van Supabase zelf meebrengt. Opnieuw draaien kan.
-- Draait als serverbeheerder via scripts/setup-db.sh, dat de wachtwoorden meegeeft:
--   -v authenticator_password=... -v auth_admin_password=... -v storage_admin_password=...

\set ON_ERROR_STOP on

do $$
begin
  -- een kopie uit Supabase geeft rechten aan "postgres" en "supabase_admin"; hier zijn dat alleen plaatshouders
  if not exists (select from pg_roles where rolname = 'postgres') then create role postgres nologin; end if;
  if not exists (select from pg_roles where rolname = 'supabase_admin') then create role supabase_admin nologin; end if;
  -- rollen waarmee de API en de RLS-regels werken
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  -- inlogrollen voor de diensten
  if not exists (select from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
  if not exists (select from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin login noinherit createrole; end if;
  if not exists (select from pg_roles where rolname = 'supabase_storage_admin') then create role supabase_storage_admin login noinherit createrole; end if;
end $$;

alter role authenticator password :'authenticator_password';
alter role supabase_auth_admin password :'auth_admin_password';
alter role supabase_storage_admin password :'storage_admin_password';

-- PostgREST wisselt per verzoek naar een van deze rollen, op basis van het token
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to supabase_storage_admin;

-- extensies in een eigen schema, zoals bij Supabase. pgvector staat hier
-- bewust niet bij: die komt in hetzelfde schema als in de bron (zie
-- migrate-data.sh) of, op een lege database, via de eerste migraties.
create schema if not exists extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
create extension if not exists pgcrypto schema extensions;
create extension if not exists "uuid-ossp" schema extensions;
create extension if not exists pg_stat_statements schema extensions;
alter database postgres set search_path = "$user", public, extensions;

-- Supabase Auth beheert het schema auth en voert daarin zijn eigen migraties uit
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to postgres, anon, authenticated, service_role;
grant create on database postgres to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;

-- Supabase Storage beheert het schema storage en voert daarin zijn eigen migraties uit
create schema if not exists storage authorization supabase_storage_admin;
grant usage on schema storage to postgres, anon, authenticated, service_role;
grant create on database postgres to supabase_storage_admin;
alter role supabase_storage_admin set search_path = storage;

-- standaardtoegang van de API tot het schema public, zoals bij Supabase
grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
