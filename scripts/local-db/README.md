# Lokale testdatabase

> **Waarschuwing: nooit gebruiken met de Azure-database.**
> Deze tool is alleen voor een wegwerpdatabase op je eigen computer. Wijs hem
> nooit naar de database op Azure (`*.postgres.database.azure.com`) en zet
> nooit het adres uit `.env` in deze scripts: dat is de productiedatabase met
> echte studentgegevens. De scripts lezen `.env` daarom niet en weigeren elk
> adres dat niet `localhost` of `127.0.0.1` is. Haal die controles nooit weg.

## Waarvoor is dit?

Een veilige plek om een databasewijziging te proberen voordat die naar productie gaat:

- **Een nieuwe migratie testen.** Elke run bouwt een lege database en draait daarop
  alle migraties uit `supabase/migrations/`, met hetzelfde script als op Azure
  (`scripts/migrate.mjs`). Lukt dat, dan weet je ook dat de migraties een nieuwe
  database vanaf nul kunnen opbouwen.
- **Een beveiligingsregel (RLS) controleren.** Je kunt doen alsof je een
  bepaalde student, docent of beheerder bent en kijken wat die mag zien en wijzigen.

De database draait in een Docker-container die alleen op deze computer bereikbaar
is (127.0.0.1). Er staan alleen verzonnen testgebruikers en testcursussen in.
Bij elke `setup` wordt hij weggegooid en opnieuw opgebouwd.

## Wat heb je nodig?

- **Docker**: OrbStack (aanbevolen op de Mac) of Docker Desktop, en die moet draaien.
- **Node.js** en de pakketten van het project (`npm install` in de hoofdmap).
- De eerste keer worden drie images gedownload (Postgres van Supabase, GoTrue,
  storage-api; samen een paar GB). Daarna duurt een setup ongeveer 10 seconden.

## Commando's

Alles vanuit de hoofdmap van de repo:

| Commando | Wat het doet |
|---|---|
| `npm run db:local` | Database (opnieuw) opbouwen: container, auth- en storage-schema, `azure/db/roles.sql`, alle migraties, testgegevens. Zelfde als `bash scripts/local-db/setup.sh`. |
| `bash scripts/local-db/setup.sh --no-seed` | Hetzelfde, zonder testgebruikers en -cursussen. |
| `bash scripts/local-db/test.sh` | Alle tests in `scripts/local-db/tests/` draaien. Stopt met een fout als een test mislukt. |
| `bash scripts/local-db/test.sh rls-demo` | Alleen `tests/rls-demo.sql`. |
| `bash scripts/local-db/psql.sh` | Een SQL-prompt op de lokale database openen. |
| `bash scripts/local-db/down.sh` | Container weer opruimen. |

Standaard heet de container `leap-localdb` en luistert hij op `127.0.0.1:54329`.
Is die naam of poort al bezet, kies dan andere (gebruik ze voor alle commando's):

```bash
LOCAL_DB_NAME=leap-localdb-b LOCAL_DB_PORT=54331 bash scripts/local-db/setup.sh
LOCAL_DB_NAME=leap-localdb-b LOCAL_DB_PORT=54331 bash scripts/local-db/test.sh
```

De tool verwijdert alleen containers die hij zelf heeft gemaakt (Docker-label
`nl.vu.leap.tool=local-db`). Een andere container met dezelfde naam laat hij staan;
hij stopt dan met een melding.

## Testgegevens (`seed.sql`)

| Wie | id | Rol |
|---|---|---|
| admin@leap.local | `00000000-0000-0000-0000-00000000a001` | beheerder |
| teacher@leap.local | `00000000-0000-0000-0000-00000000b001` | docent van Course A |
| student1@leap.local | `00000000-0000-0000-0000-00000000c001` | student in Course A |
| student2@leap.local | `00000000-0000-0000-0000-00000000c002` | student in Course B |
| outsider@leap.local | `00000000-0000-0000-0000-00000000d001` | nergens lid van |

Cursussen: Course A `00000000-0000-0000-0000-0000000c0a01`, Course B
`00000000-0000-0000-0000-0000000c0b01`. Wachtwoord van iedereen: `test1234`.

## Doen alsof je een gebruiker bent (`as-user.sql`)

Zo werkt het ook op Azure: de API zet per verzoek de gegevens van de ingelogde
gebruiker klaar, en de RLS-regels lezen die met `auth.uid()`. `as-user.sql` doet
precies dat, voor de rest van de lopende transactie. Open `bash scripts/local-db/psql.sh` en typ:

```sql
begin;
\set uid 00000000-0000-0000-0000-00000000c001
\i as-user.sql
select * from course_members;   -- wat student1 mag zien
rollback;                        -- alles terug, en je bent weer postgres
```

- `\set email student1@leap.local` vóór `\i as-user.sql` zet ook het e-mailadres
  (sommige regels kijken daarnaar).
- `\i as-anon.sql` in plaats van `as-user.sql`: een bezoeker die niet is ingelogd.
- Werk altijd tussen `begin;` en `rollback;`, dan blijft er niets achter.

## Een test toevoegen

Maak een nieuw bestand in `scripts/local-db/tests/`, bijvoorbeeld
`tests/quiz-attempts.sql`. `test.sh` pakt het vanzelf op. Afspraken:

1. Alles binnen één `begin; … rollback;`, zodat de test niets achterlaat.
2. Gebruik de testgegevens hierboven; maak extra rijen binnen de transactie aan.
3. Wissel van gebruiker met `\ir ../as-user.sql` (met `\set uid …` ervoor) of
   met een eigen hulpfunctie zoals in `tests/security-hardening.sql`.
   Ga terug naar postgres met `reset role;`.
4. Laat per controle één regel zien die begint met `PASS ` of `FAIL `.
   `test.sh` mislukt bij elke regel die met `FAIL` begint, en ook als psql met
   een fout stopt (bijvoorbeeld door `raise exception`).

Voorbeeld:

```sql
begin;
\set uid 00000000-0000-0000-0000-00000000c002
\ir ../as-user.sql
select case when count(*) = 0 then 'PASS' else 'FAIL' end
       || ' student2 ziet geen leden van Course A'
from course_members where course_id = '00000000-0000-0000-0000-0000000c0a01';
rollback;
```

Nieuwe migratie gemaakt? Draai dan `npm run db:local` en daarna
`bash scripts/local-db/test.sh`. Pas als beide slagen, gaat de migratie mee naar `main`.

## Bestanden

| Bestand | Inhoud |
|---|---|
| `setup.sh` | Bouwt de database op (zie de stappen bovenaan het bestand). |
| `test.sh`, `psql.sh`, `down.sh` | Tests draaien, SQL-prompt openen, opruimen. |
| `lib.sh` | Gedeelde instellingen: naam, poort, versies, de controles op "alleen lokaal". |
| `local-only-guard.cjs` | Tweede vangnet: binnen het migratiescript wordt elke verbinding met een andere computer dan deze geweigerd. |
| `seed.sql` | Testgebruikers en -cursussen. |
| `as-user.sql`, `as-anon.sql` | Doen alsof je een gebruiker of een bezoeker bent. |
| `jwt.mjs` | Maakt sleutels voor de storage-container, alleen tijdens de setup. |
| `tests/*.sql` | De RLS-tests. |

De wachtwoorden en het JWT-geheim in `lib.sh` zijn wegwerpwaarden voor deze
lokale database. Ze beschermen niets en mogen nergens anders gebruikt worden.
De versies van GoTrue en storage-api komen uit `azure/scripts/config.sh`, zodat
het auth- en storage-schema gelijk is aan dat op Azure.
