# Architectuur van LEAP

LEAP bestaat uit drie lagen: wat de student in de browser ziet, een server die het
denkwerk doet, en een database met alle gegevens. Alles draait bij de VU op Azure, in
resourcegroep `vu-leap-rg` (West-Europa). De taalmodellen staan op een
Azure OpenAI-resource van de VU binnen de EU-datagrens. Er gaat geen cursusmateriaal
of studentgegeven naar de publieke OpenAI of naar andere diensten buiten de VU.

## De tekening

```
                 Browser van student of docent
                 (React-app, gebouwd met Vite)
                     |                     |
        /api/...     |                     |  inloggen, tabellen lezen en
                     |                     |  schrijven, bestanden
                     v                     v
  +----------------------------+     +------------------------------------------+
  | vu-leap-app                |     | vu-leap-supabase                         |
  | https://leap.vu-edulab.nl  |     |   gateway (Caddy)                        |
  | Express-server + frontend  |---->|     /auth/v1    -> GoTrue (inloggen)     |
  | 1 kopie, altijd aan        |     |     /rest/v1    -> PostgREST (tabellen)  |
  | migraties bij het starten  |<----|     /storage/v1 -> vu-leap-storage (*)   |
  +----------------------------+  ^  +------------------------------------------+
     |       |        |           |                |                     |
     |       |        |      e-mail-hook           |                     |
     |       |        |      van GoTrue            v                     v
     |       |        |              +---------------------------+  +---------------+
     |       |        +------------->| vu-leap-db                |  | vuleapstorage |
     |       |          (pgPool)     | PostgreSQL 17 + pgvector  |  | Blob Storage  |
     |       |                       +---------------------------+  +---------------+
     |       v
     |   leap-openai-vu   Azure OpenAI van de VU (Sweden Central, EU-datagrens):
     |                    chat en embeddings
     v
   vu-leap-acs   Azure Communication Services: e-mail van leap@vu-edulab.nl

  (*) vu-leap-storage is een aparte, alleen intern bereikbare Container App.

  Ernaast:
    kv-vu-leap    Key Vault met alle geheimen; de apps lezen ze met identiteit id-leap-apps
    vuleapacr     register met de images (app, gateway, Supabase-onderdelen)
    vu-leap-logs  Log Analytics: het logboek van alle Container Apps
    GitHub        push naar main -> workflow meldt zich aan als id-leap-deploy (OIDC)
                  -> bouwt de image in vuleapacr -> zet vu-leap-app op de nieuwe versie
```

## De onderdelen

| Onderdeel | Naam op Azure | Wat het doet |
|---|---|---|
| Frontend | (zit in `vu-leap-app`) | De React-app. De server levert de gebouwde bestanden uit `dist/`. |
| App-server | Container App `vu-leap-app` | De Express-server uit `server/`. Hij beantwoordt alle `/api/…`-verzoeken, praat met het taalmodel, leest documenten in en verstuurt e-mail. Draait altijd als precies één kopie: lopende taken en tijdklokken leven in zijn geheugen. Bereikbaar op `https://leap.vu-edulab.nl`. |
| Supabase | Container App `vu-leap-supabase` | De Supabase-software in eigen beheer. Een Caddy-gateway (`azure/gateway/Caddyfile`) stuurt elk pad door: `/auth/v1` naar GoTrue (inloggen, accounts), `/rest/v1` naar PostgREST (tabellen via HTTP, bewaakt door RLS-regels in de database), `/storage/v1` naar de opslag. |
| Bestandsopslag | Container App `vu-leap-storage` + opslagaccount `vuleapstorage` | Supabase Storage, alleen intern bereikbaar via de gateway. De bestanden zelf staan in Azure Blob Storage. |
| Database | `vu-leap-db` | Azure Database for PostgreSQL 17 met pgvector (voor het zoeken in cursusmateriaal). Alleen Azure-diensten mogen erbij; beheerders zetten hun IP-adres er tijdelijk bij. |
| Taalmodellen | `leap-openai-vu` (in `vu-education-lab-rg`) | Azure OpenAI van de VU, Sweden Central, EU-datagrens. Chat via de deployment `gpt-5.5`, embeddings via `text-embedding-3-small`. |
| E-mail | `vu-leap-acs` | Azure Communication Services. Afzender `leap@vu-edulab.nl`; dat domein ontvangt zelf geen post, antwoorden gaan naar `MAIL_REPLY_TO`. Ook de account-e-mails (bevestigen, uitnodigen, wachtwoord) verstuurt de app zelf: GoTrue roept daarvoor `/api/auth/email-hook` aan. |
| Geheimen | Key Vault `kv-vu-leap` | Sleutels en wachtwoorden. De apps lezen ze met hun eigen identiteit `id-leap-apps`. Nooit in de repo of in GitHub. |
| Images | Register `vuleapacr` | De gebouwde containers. |
| Logboek | Log Analytics `vu-leap-logs` | Uitvoer van alle Container Apps. |

De namen staan allemaal in `azure/scripts/config.sh`.

## Hoe een nieuwe versie live gaat

**Een push naar `main` is een uitrol naar productie.** Er is geen testomgeving
tussen `main` en de echte gebruikers.

1. GitHub start `.github/workflows/azure-deploy.yml`. Die logt zonder wachtwoord in bij
   Azure als de identiteit `id-leap-deploy` (OIDC).
2. De workflow bouwt de image in `vuleapacr` (met het publieke Supabase-adres en de
   publieke sleutel in de frontend) en zet `vu-leap-app` op die nieuwe versie.
3. Bij het starten voert de app eerst nieuwe databasemigraties uit
   (`scripts/migrate.mjs --on-start`, bijgehouden in de tabel `leap_migrations`).
   Mislukt een migratie, dan start de nieuwe versie niet en blijft de vorige draaien;
   de workflow meldt dan een fout.
4. De workflow wacht tot de nieuwe versie gezond draait.

Een push die alleen `.md`-bestanden, `docs/` of `azure/` verandert, start geen uitrol.
De Supabase-onderdelen (`vu-leap-supabase`, `vu-leap-storage`) worden niet door GitHub
bijgewerkt maar met de hand via `azure/scripts/deploy.sh`.

Terug naar de vorige versie: Azure-portal → `vu-leap-app` → *Revisions and replicas*.
Meer beheertaken staan in [`azure/README.md`](../azure/README.md).

## Wat er niet is

- **Geen Supabase Realtime en geen Edge Functions.** Schermen die live moeten verversen,
  vragen periodiek opnieuw op (`src/lib/liveUpdates.ts`). Nieuwe serverlogica hoort in
  een Express-route.
- **Geen tweede kopie van de app.** Wie wil opschalen, moet eerst de taken en tijdklokken
  die nu in het geheugen leven naar de database verhuizen.

## Verder lezen

- [Wat staat waar](README.md): de kaart van de repository.
- [Beveiliging](security/README.md): wie mag wat, en hoe dat is afgedwongen.
- [`azure/README.md`](../azure/README.md): beheer op Azure.
