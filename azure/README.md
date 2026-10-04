# LEAP op Azure

Alles wat nodig is om LEAP binnen de VU op Azure te draaien. De app zelf verandert
nauwelijks: LEAP blijft de software van Supabase gebruiken (inloggen, database-API,
bestandsopslag), maar die draait dan in eigen beheer op Azure in plaats van bij
Supabase. De app krijgt alleen een ander Supabase-adres en andere sleutels.

Inloggen werkt hetzelfde als nu: e-mailadres en wachtwoord, bevestiging per e-mail,
uitnodigingen en "wachtwoord vergeten". Bestaande accounts houden hun wachtwoord.

## Wat draait waar

Alles staat in resourcegroep **`vu-leap-rg`** (abonnement *VU - BETA AI Hub Pilot*, West-Europa).

| Was | Op Azure | Naam |
|---|---|---|
| Replit (server + frontend) | Container App, altijd één kopie | `vu-leap-app` |
| Supabase Auth, database-API en gateway | Container App met drie onderdelen: `gateway` (Caddy), `auth` (GoTrue), `rest` (PostgREST) | `vu-leap-supabase` |
| Supabase Storage | Container App, alleen intern; bestanden in Azure Blob Storage | `vu-leap-storage`, opslagaccount `vuleapstorage` |
| Supabase Postgres + pgvector | Azure Database for PostgreSQL 17 | `vu-leap-db` |
| Geheimen in Replit | Key Vault; de apps lezen ze met hun eigen identiteit | `kv-vu-leap`, identiteit `id-leap-apps` |
| E-mail van Supabase en Resend | Azure Communication Services, afzender `leap@vu-edulab.nl` | `vu-leap-acs` |
| — | Register voor de images | `vuleapacr` |
| — | Logboek | `vu-leap-logs` |
| Taalmodellen | Ongewijzigd: de VU-resource `leap-openai-vu` (staat in `vu-education-lab-rg`) | |

De namen staan in `scripts/config.sh`.

## Zo werk je ermee

| Je wilt… | Zo |
|---|---|
| Een nieuwe versie live zetten | Push naar `main`. GitHub bouwt en rolt uit (`.github/workflows/azure-deploy.yml`); na een paar minuten staat het live. De voortgang staat op GitHub onder *Actions*. |
| Een databasewijziging doorvoeren | Zet het SQL-bestand in `supabase/migrations/` en push. De app voert nieuwe migraties zelf uit bij het starten. Mislukt er één, dan start de nieuwe versie niet en blijft de vorige draaien; de fout staat in het logboek en bij *Actions*. |
| Het logboek bekijken | Portal → `vu-leap-app` → *Log stream*, of `az containerapp logs show -g vu-leap-rg -n vu-leap-app --follow` |
| Terug naar de vorige versie | Portal → `vu-leap-app` → *Revisions and replicas* → de vorige revisie activeren |
| Een instelling wijzigen | Portal → `vu-leap-app` → *Containers* → *Environment variables*. Geheimen: Key Vault `kv-vu-leap` → *Secrets*, daarna de app herstarten |
| In de database kijken | Een Postgres-programma (bv. de VS Code-extensie "PostgreSQL") op `vu-leap-db.postgres.database.azure.com`, gebruiker `leapadmin`, wachtwoord uit Key Vault (`pg-admin-password`). Zet eerst je eigen IP-adres erbij onder *Networking* |
| Accounts beheren | Het beheer in LEAP zelf, of de tabel `auth.users` |
| Geüploade bestanden bekijken | Portal → opslagaccount `vuleapstorage` → *Containers* → `supabase-storage` |
| Lokaal ontwikkelen tegen Azure | Meld je aan bij Azure (`az login --tenant vunl.onmicrosoft.com`, `az account set --subscription "VU - BETA AI Hub Pilot"`) en draai `node azure/scripts/local-env.mjs`. Dat zet de Supabase-waarden in je `.env` en laat je IP-adres toe op de database. Daarna `npm run dev` |
| De kosten volgen | Portal → `vu-leap-rg` → *Cost analysis*. Bij 80% van het maandbudget komt er een e-mail |

## Wat anders is dan bij Supabase en Replit

- **Live-updates.** Supabase Realtime draait niet op Azure. De groepschat, het Studiecafé en de
  RAG-status verversen daar elke paar seconden zelf (`src/lib/liveUpdates.ts`, build-instelling
  `VITE_PUBLIC_REALTIME=off`). Een nieuw bericht verschijnt dus na hooguit enkele seconden in
  plaats van direct.
- **E-mail.** Alle e-mails (account bevestigen, uitnodiging, wachtwoord vergeten, Studiecafé-meldingen)
  komen van `leap@vu-edulab.nl`, via Azure Communication Services. Het domein `vu-edulab.nl` is van
  de Onderwijswerkplaats en ontvangt zelf geen e-mail; een antwoord op een LEAP-mail gaat naar het
  adres in `MAIL_REPLY_TO` (`scripts/config.sh`). Er geldt een limiet van 30 e-mails per minuut en
  100 per uur; nodig dus niet meer dan zo'n 80 studenten per uur uit.
- **Edge Functions** (`supabase/functions/`) draaien niet op Azure. De app roept ze niet aan.
- **Eén kopie van de app.** Lopende taken (begrippen extraheren) en de tijdklok voor de
  Studiecafé-mails leven in het geheugen van de server. Daarom draait er precies één kopie,
  die altijd aan staat.
- **Migraties.** `node scripts/run-sql.mjs <bestand>` werkt nog steeds, maar is op Azure niet
  meer nodig: `scripts/migrate.mjs` houdt in de tabel `leap_migrations` bij wat al is
  uitgevoerd. De migraties zijn niet bedoeld om een lege database mee op te bouwen (de
  volgorde van de oudste klopt daarvoor niet); een nieuwe omgeving begint met een kopie
  van de bestaande database (`migrate-data.sh`).

## Eerste keer opzetten

Nodig: `az` (aangemeld bij de VU-tenant), Postgres 17-clienttools (`brew install libpq@18`),
Node en Python 3. Draai de scripts vanuit deze map.

1. `scripts/provision.sh` — maakt de Azure-onderdelen aan.
2. `scripts/generate-secrets.sh` — sleutels en wachtwoorden in Key Vault.
3. `scripts/setup-db.sh` — de rollen en schema's die Supabase verwacht. Staat er al iets in de
   database, dan toont het script wat en stopt het; ga dan eerst na van wie dat is.
4. `scripts/deploy.sh storage supabase` — de Supabase-onderdelen.
5. `SUPABASE_DB_URL=… scripts/migrate-data.sh` — database en accounts overzetten. De waarde is
   dezelfde `SUPABASE_DB_URL` als in de `.env` van de huidige omgeving.
6. `SOURCE_URL=… SOURCE_KEY=… scripts/copy-storage.sh` — de geüploade bestanden overzetten
   (`VITE_PUBLIC_SUPABASE_URL` en `SUPABASE_SERVICE_ROLE_KEY` uit dezelfde `.env`).
7. `scripts/deploy.sh app` — LEAP zelf.
8. GitHub laten uitrollen: een Owner van het abonnement geeft de identiteit `id-leap-deploy`
   de rol *Contributor* op `vu-leap-rg`. Zet daarna in de GitHub-repo onder *Settings →
   Secrets and variables → Actions → Variables* de variabele `AZURE_CLIENT_ID` op de
   client-id die `provision.sh` aan het eind toont. Zonder die variabele doet de workflow niets.

Stap 5 en 6 lezen alleen uit Supabase; de huidige omgeving blijft gewoon werken. Beide
vervangen de kopie op Azure en kunnen dus vaker.

## Overstappen

1. Draai stap 5 en 6 nog één keer op een rustig moment: wat daarna nog in de oude omgeving
   verandert, komt niet mee.
2. Geef iedereen het nieuwe adres. Iedereen logt één keer opnieuw in (wachtwoorden blijven gelijk).
3. Laat Replit en Supabase nog een paar weken ongemoeid staan als weg terug.

## Eigen adres (leap.vu-edulab.nl)

LEAP staat op `https://leap.vu-edulab.nl`. Het domein `vu-edulab.nl` is van de Onderwijswerkplaats;
de DNS-zone staat in `vu-education-lab-rg` en bevat voor LEAP de records `leap` (CNAME naar
`vu-leap-app`) en `asuid.leap` (TXT, de verificatie). Het certificaat beheert Azure zelf. Het adres
staat als `APP_URL` in `scripts/config.sh`; de links in e-mails gebruiken het.

Zo is het gekoppeld (alleen nodig bij een nieuwe omgeving of een ander adres):

```bash
source scripts/config.sh
az network dns record-set cname set-record -g vu-education-lab-rg -z vu-edulab.nl -n leap -c "$APP.$DOMAIN" --ttl 3600
az network dns record-set txt add-record -g vu-education-lab-rg -z vu-edulab.nl -n asuid.leap \
  -v "$(az containerapp show -g $RG -n $APP --query properties.customDomainVerificationId -o tsv)"
az containerapp hostname add -g $RG -n $APP --hostname leap.vu-edulab.nl
az containerapp hostname bind -g $RG -n $APP --hostname leap.vu-edulab.nl --environment $ENV_NAME --validation-method CNAME
```

## Scripts

| Script | Wat het doet |
|---|---|
| `provision.sh` | Eenmalig: de Azure-onderdelen, de e-mailafzender, de aanmelding voor GitHub en de kostenmelding |
| `generate-secrets.sh` | Eenmalig: sleutels en wachtwoorden → Key Vault |
| `setup-db.sh` | Supabase-rollen en -schema's op Azure Postgres; verbindingsgegevens → Key Vault |
| `deploy.sh [apps…]` | Images bouwen en de Container Apps aanmaken of bijwerken (`storage`, `supabase`, `app`) |
| `migrate-data.sh` | Database, accounts en opslagregels kopiëren uit Supabase. Nodig: `SUPABASE_DB_URL` |
| `copy-storage.sh` | Geüploade bestanden kopiëren uit Supabase Storage. Nodig: `SOURCE_URL`, `SOURCE_KEY` |
| `local-env.mjs` | Je eigen `.env` aansluiten op Azure en je IP-adres toelaten op de database (Node, werkt ook op Windows) |

Geen enkel script toont een geheim, en er staan geen geheimen in deze repo.
