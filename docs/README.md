# Wat staat waar

Een kaart van de repository: welke map wat doet, en waar je moet zijn als je iets
wilt veranderen. Voor het grote plaatje (welke onderdelen er op Azure draaien) zie
[architecture.md](architecture.md). De afspraken voor het schrijven van code staan
in [CLAUDE.md](../CLAUDE.md); beveiliging staat in [security/README.md](security/README.md).

Alle paden hieronder zijn vanaf de hoofdmap van de repo.

## De hoofdmap

| Map of bestand | Wat het is |
|---|---|
| `src/` | De frontend: React + TypeScript, gebouwd met Vite. Alles wat in de browser draait. |
| `server/` | De backend: één Express-server (Node). Alle `/api/…`-routes, de taalmodel-aanroepen en het inlezen van documenten. |
| `supabase/` | Het databaseschema (migraties), terugdraaiscripts en oude Edge Functions. |
| `scripts/` | Losse Node- en shellscripts: controles en metingen tegen het echte model, vertalingen, database, schermcontrole, lokale testdatabase. |
| `azure/` | Alles om LEAP op Azure te zetten en te beheren (zie [`azure/README.md`](../azure/README.md)). |
| `docs/` | Documentatie: deze kaart, de architectuur, de handleiding, plannen en naslag. |
| `public/` | Vaste bestanden die de browser direct krijgt (logo, `robots.txt`). |
| `.github/workflows/azure-deploy.yml` | Rolt de app uit naar Azure bij elke push naar `main`. |
| `Dockerfile` | Bouwt de ene container: Node 22, LibreOffice, de gebouwde frontend en de server. |
| `.env.example` | Lijst van alle instellingen (omgevingsvariabelen), zonder waarden. Kopieer naar `.env`. |
| `package.json` | Afhankelijkheden en de `npm run …`-opdrachten. |
| `vite.config.ts` | Instellingen van Vite (frontend-build, doorsturen van `/api` naar poort 3001) en van Vitest (tests). |
| `tailwind.config.js`, `postcss.config.js`, `src/index.css` | Opmaak; de LEAP-kleuren staan als CSS-variabelen in `src/index.css`. |
| `eslint.config.js`, `tsconfig*.json` | Lint- en TypeScript-instellingen. |
| `CLAUDE.md` | Projectregels voor Claude Code (en voor iedereen die code schrijft). |

Niet in git (zie `.gitignore`): `node_modules/`, `dist/` (de gebouwde frontend),
`.env`, `ui-audit-output/` en `db-backups/`.

## server/

`server/index.js` doet alleen het aansluiten: beveiligingsinstellingen, `express.json`,
de vertaal-middleware, analytics, het tokenbudget, en dan per onderwerp één
`registerXRoutes(app)`. Daarna serveert het de gebouwde frontend uit `dist/` en
start het de tijdklokken (Studiecafé-mails, opruimen).

Elk onderwerp heeft een eigen map. In die map staat `routes.js` (de Express-routes)
en daarnaast de modules met de eigenlijke regels. Die modules zijn zoveel mogelijk
"puur" (geen database, geen netwerk), zodat ze los te testen zijn.

| Map | Wat het doet | Belangrijkste bestanden |
|---|---|---|
| `server/account/` | Account-e-mails, "Mijn gegevens" en het tokenbudget voor open registratie | `authEmailHook.js` (mails voor bevestigen, uitnodigen, wachtwoord vergeten), `myData.js` (eigen gegevens downloaden, account verwijderen), `tokenBudget.js` |
| `server/analytics/` | Losse module met geaggregeerde tellers (nooit personen); in één keer te verwijderen | `index.js` (lijst van alle aansluitpunten), `collector.js`, `aggregate.js` |
| `server/chat/` | De tutorchat (`POST /api/chat`), ook gebruikt door Ik leg uit en de quiz | `routes.js`, `learningLevel.js` (taal per niveau), `readiness.js` ("Klaar voor een hoger niveau?"), `chatAttachments.js`, `chatGoal.js`, `citationSources.js`, `chatConfig.js` |
| `server/concepts/` | Begrippen: extractie over de hele cursus, samenvoegen, bewijs, volgorde | `routes.js`, `conceptConsolidation.js` (vensters, selectie, samenvoegen), `conceptExtraction.js`, `conceptEvidence.js`, `conceptOrder.js` |
| `server/courses/` | Cursussen, leden, toegangsroute, uitnodigingen, onderdelen aan/uit, leerlijn, cursus-info | `routes.js`, `courseFeatures.js`, `enrollment.js`, `courseInvitations.js`, `courseUnits.js`, `courseInfo.js`, `courseOverview.js`, `courseAvailability.js`, `memberRoleAuth.js`, `teacherProfile.js`, `bulkAccounts.js`, `courseBanner.js`, `courseMembers.js` |
| `server/documents/` | Cursusmateriaal bekijken, downloaden en vertalen; bestandsdoelen | `routes.js`, `courseFiles.js` (Cursusmateriaal-werkruimte), `documentRender.js` (Word/PowerPoint naar pdf met LibreOffice), `documentTranslation.js`, `viewableDocument.js` |
| `server/explain/` | "Ik leg uit" en "Verbeter deze uitleg" | `routes.js`, `explainFeedback.js`, `flawedExplanations.js` |
| `server/i18n/` | Vertaling van servermeldingen en de talenlijst | `serverI18n.js` (middleware), `languages.js`, `notificationI18n.js`, `messages.source.json` + `messages.<taal>.json` |
| `server/ingestion/` | Documenten inlezen: tekst eruit, in stukken (chunks), embeddings, opslaan | `routes.js`, `pipeline.js`, `ragProcessing.js`, `processingQueue.js` (wachtrij, 2 tegelijk), `pptxExtract.js`, `pdfPages.js`, `pdfPageText.js`, `webImport.js`, `pageBackfill.js` |
| `server/journal/` | Leerdagboek | `routes.js`, `journalSections.js` (de drie blokken), `journalCourse.js` |
| `server/lib/` | Gedeelde basis voor alle onderwerpen (zie hieronder) | |
| `server/lti/` | Canvas-koppeling (LTI 1.3) | `lti.js`, `routes.js` |
| `server/projects/` | Projecten, groepen, persona's (begeleider, beoordelaar, rolspeler), inleveren en voorbeoordeling | `groupRoutes.js`, `roomRoutes.js`, `personaRoutes.js`, `documentRoutes.js`, `access.js`, `personaRoles.js`, `personaKnowledge.js`, `personaRelationship.js`, `threadClose.js`, `preassessment.js`, `projectJournalSave.js` |
| `server/prompts/` | Tutor-instructies per cursus en de sjablonen | `routes.js`, `promptStore.js`, `promptTemplates.js` |
| `server/quiz/` | Quiz, bronnenmix en vraagbanken (ShareStats, CSV) | `routes.js`, `itembankRoutes.js`, `itembankScope.js`, `itembankCsv.js`, `quizSourcesMix.js` |
| `server/rag/` | Zoeken in het cursusmateriaal (RAG) | `routes.js` (o.a. `/api/embeddings`, zoekinstellingen), `search.js`, `chunking.js`, `crossLingual.js`, `queryExpansion.js`, `filePurpose.js`, `documentScope.js`, `ragFolder.js` |
| `server/studiecafe/` | Studiecafé (forum per cursus) en de e-mailmeldingen | `studiecafe.js`, `routes.js` |
| `server/system/` | Gezondheidscheck, systeemberichten, Ontwerphulp | `routes.js` (`/api/health`), `systemMessages.js`, `designAssistant.js` |
| `server/__tests__/` | Alle servertests (Vitest) | |

### server/lib/

| Bestand | Wat het doet |
|---|---|
| `auth.js` | Wie is de aanroeper en wat mag hij: `requireAuthUser`, `isStaffForCourse`, `isCourseTeacher`, `userHasCourseAccess`, `isLeapAdmin`, `requireAdminOrDocent`. |
| `authCache.js` | Inlogcontrole en profiel 30 seconden onthouden. |
| `supabase.js` | De databaseverbindingen: `supabaseAdmin` (service-role, omzeilt RLS) en `pgPool` (directe Postgres). |
| `azureOpenai.js` | Adressen en parameters voor Azure OpenAI (chat en embeddings); `chatModelParams`. |
| `openaiSampling.js` | Welke parameters een model accepteert; lege of afgekapte antwoorden herkennen. |
| `embeddingsRetry.js` | Embeddings opnieuw proberen bij een snelheidslimiet (429). |
| `courseFeatureGate.js` | `rejectIfFeatureOff` / `courseFeatureOnFor`: staat een onderdeel aan voor deze cursus? |
| `courseData.js` | Veelgebruikte cursusgegevens (leerlijn, materiaal, RAG-mappen) met korte cache; `logSettingChange`. |
| `schemaFlags.js` | Controleert bij het starten welke kolommen de database heeft. |
| `httpSecurity.js` | CORS, proxy-instelling en veilige standaardheaders. |
| `notifications.js` | E-mail versturen (`getEmailConfig`, `sendEmail`): Azure Communication Services of Resend. |
| `turnSigning.js` | Handtekening op echte tutorbeurten (voor "Klaar voor een hoger niveau?"). |
| `uploads.js` | Bestandsupload (multer) en tekst uit Office-bestanden. |
| `sanitizeText.js` | Tekens verwijderen die Postgres weigert. |
| `serverUrls.js` | Poort en publiek adres van de app. |
| `migrationPlan.js` | Welke migraties nog moeten draaien (gebruikt door `scripts/migrate.mjs`). |

## src/

| Map | Wat erin staat |
|---|---|
| `src/main.tsx`, `src/App.tsx` | Opstarten en de routes (welke pagina bij welk adres). |
| `src/pages/` | Eén bestand per pagina: `ChatPage`, `ExplainPage`, `QuizPage`, `ProjectsPage`, `ProjectRoomPage`, `StudiecafePage`, `DashboardPage`, `AdminPage`, `CoursesAdminPage`, `MyDataPage`, inlog- en activatiepagina's. |
| `src/pages/admin/` | Tabbladen van Beheer (projecten, onderdelen aan/uit, systeemberichten, tokenbudget, Canvas, …). |
| `src/components/` | Herbruikbare onderdelen. Losse bestanden voor algemene stukken; submappen per gebied: |
| `src/components/material/` | De Cursusmateriaal-werkruimte (Bestanden, Verwerking, Begrippen, Klaar voor studenten, Leerlijn). |
| `src/components/help/` | `HelpTip`, `Tooltip`, `AdminHint`, `HelpToggle`: uitleg en "?"-knoppen. |
| `src/components/ui/` | Bouwstenen zoals `ListRow`, `RowActions`, `alert-dialog`. |
| `src/components/chat/`, `explain/`, `quiz/`, `concepts/`, `projects/`, `formula/`, `admin/` | Onderdelen voor dat ene gebied (bv. `chat/ChatGoal.tsx`, `formula/FormulaDialog.tsx`, `admin/DesignAssistant.tsx`). |
| `src/services/` | Praten met de server en Supabase: `llm.service.ts`, `rag.service.ts`, quiz-, upload-, ShareStats- en web-import-services. |
| `src/lib/` | Gedeelde hulpfuncties zonder schermen: `supabase.ts` (de client), `courseFeatures.ts`, `liveUpdates.ts`, `backgroundTasks.ts`, `conceptProgress.ts`, `mathText.ts`, `database.types.ts`, … |
| `src/hooks/` | React-hooks: `useCourseFeatures`, `useChatAttachments`, `useLearningLevel`, `useLeerlijn`, … |
| `src/contexts/` | Gedeelde toestand: `AuthContext` (wie is ingelogd), `ActiveCourseContext` (actieve cursus), `CourseAccessContext`. |
| `src/features/analytics/` | Frontend van de losse analytics-module. |
| `src/i18n/` | Vertalingen. `locales/nl.json` is de bron; `en.json` met de hand; de andere talen gegenereerd. `languages.ts` is de talenlijst. |
| `src/help/` | `helpTopics.ts`: de lijst van alle help-id's. |
| `src/config/` | `storage.config.ts`. |
| `src/test/` | `setup.ts` voor de Vitest-componenttests. |
| `__tests__/` (in diverse mappen) | Tests naast de code die ze testen. |

## scripts/

Draai scripts vanuit de hoofdmap. Scripts die de echte database of het echte
model gebruiken, lezen `.env`: `node --env-file=.env scripts/<naam>`.

**Controles en metingen tegen het echte model of de draaiende app**
(gebruiken een testaccount; schrijven niets weg of ruimen zelf op):

| Script | Wat het controleert |
|---|---|
| `check-document-viewer.mjs` | Documentviewer in een echte browser. |
| `check-chat-attachments.mjs`, `check-chat-attachments-ui.mjs` | Bijlagen in de chat (API en browser). |
| `check-course-invitations.mjs` | Studenten uitnodigen, tegen de database en de API op poort 3001. |
| `check-preassessment.mjs` | Voorbeoordeling van een eindproduct. |
| `verify-course-features.mjs` | Onderdelen aan/uit in de database (in een transactie die wordt teruggedraaid). |
| `eval-level-language.mjs` | Verandert het leerniveau echt de taal? |
| `eval-leerlijn.mjs` | Volgt de tutor de leerlijn? |
| `eval-flawed-explanations.mjs`, `eval-flawed-feedback.mjs` | "Verbeter deze uitleg": oefeningen en beoordeling. |
| `eval-chat-attachments.mjs` | Kan het model afbeeldingen en bestanden lezen, en wat kost het? |
| `eval-learning-levels.js`, `eval-learning-levels-persona.js` | Oudere metingen van leerniveaus (chat en persona). |

**Vertalingen**

| Script | Wat het doet |
|---|---|
| `i18n-generate.mjs` | Vult ontbrekende sleutels in alle talen aan vanuit `nl.json`. Herhalen tot "RESTEREND totaal: 0". |
| `extract-server-messages.mjs` | Haalt alle servermeldingen uit de code naar `server/i18n/messages.source.json` (`--check` controleert alleen). |
| `server-i18n-generate.mjs` | Vertaalt de servermeldingen naar alle talen. |

**Database en migraties**

| Script | Wat het doet |
|---|---|
| `migrate.mjs` | Voert nieuwe migraties uit en houdt bij welke al gedaan zijn (tabel `leap_migrations`). Draait vanzelf bij het starten van de app op Azure. |
| `run-sql.mjs` | Eén SQL-bestand uitvoeren (bv. een terugdraaiscript). |
| `db-snapshot.mjs`, `db-restore.mjs` | Momentopname van tabellen maken en terugzetten (naar `db-backups/`). |
| `backfill-journal-sections.mjs`, `prepare-office-sources.mjs` | Eenmalige omzettingen van bestaande gegevens. |
| `lti-keygen.mjs` | Maakt de sleutel voor de Canvas-koppeling (uitvoer is geheim, gaat naar Key Vault). |

**Schermcontrole en handleiding**

| Script | Wat het doet |
|---|---|
| `ui-audit.mjs` | `npm run ui:audit`: opent elke pagina op 390/1024/1366 px en meldt opmaakfouten (rapport in `ui-audit-output/`). |
| `ui-audit-account.mjs` | Maakt of verwijdert het testaccount voor de schermcontrole. |
| `handbook-screenshots.mjs`, `build-handbook.mjs` | Schermafbeeldingen en pdf van de handleiding. |
| `refresh-sharestats-fixtures.mjs` | Testgegevens voor de ShareStats-import verversen. |

**Lokale testdatabase** (`scripts/local-db/`): een wegwerpdatabase in Docker op je
eigen computer, om migraties en databaseregels (RLS) veilig te testen. Nooit tegen
Azure. Zie [`scripts/local-db/README.md`](../scripts/local-db/README.md).

## supabase/

| Map | Wat erin staat |
|---|---|
| `supabase/migrations/` | Het databaseschema, als reeks SQL-bestanden. Naam: `<JJJJMMDDUUMMSS>_<naam>.sql`. Elke migratie draait precies één keer (bijgehouden in `leap_migrations`). Een nieuwe migratie gaat live bij de volgende uitrol. |
| `supabase/rollback/` | Terugdraaiscripts: `<zelfde tijdstempel>_<naam>_down.sql` naast elke grotere migratie. Uitvoeren met `node scripts/run-sql.mjs supabase/rollback/<bestand>`. |
| `supabase/maintenance/` | Losse onderhoudsquery's (eenmalig, handmatig). |
| `supabase/functions/` | Oude Supabase Edge Functions. Die bestaan niet op Azure; nieuwe serverlogica hoort in een Express-route. |

## azure/

| Pad | Wat het is |
|---|---|
| `azure/README.md` | Hoe LEAP op Azure draait en hoe je het beheert (logboek, terugrollen, database). |
| `azure/scripts/config.sh` | Alle namen van de Azure-onderdelen op één plek. |
| `azure/scripts/provision.sh`, `generate-secrets.sh`, `setup-db.sh`, `deploy.sh` | Eerste keer opzetten en (als terugval) handmatig uitrollen. |
| `azure/scripts/migrate-data.sh`, `copy-storage.sh`, `copy-storage.py` | Gegevens en bestanden overzetten vanuit Supabase in de cloud (eenmalig gebruikt). |
| `azure/scripts/local-env.mjs` | Je eigen `.env` aansluiten op Azure voor lokaal ontwikkelen. |
| `azure/gateway/` | De Caddy-gateway die `/auth`, `/rest` en `/storage` naar de juiste Supabase-onderdelen stuurt. |
| `azure/db/roles.sql` | De databaserollen die Supabase verwacht. |

## docs/

| Map | Wat erin staat |
|---|---|
| `docs/README.md` | Deze kaart. |
| `docs/architecture.md` | Architectuur in één pagina, met tekening. |
| `docs/security/` | Beveiliging: wie mag wat, en hoe dat is afgedwongen. |
| `docs/decisions/` | Productbesluiten per onderwerp (privacy, cursusmateriaal, chat/uitleg/quiz, projecten, toegang en Canvas, techniek). Bijwerken als een besluit verandert. |
| `.claude/` | Instellingen voor Claude Code: twee review-agents (beveiliging, onderhoudbaarheid), de skill `tidy-workspace` en `settings.json` (houdt `.env` buiten beeld). |
| `docs/reference/` | Naslag: `kennisnotities.md` (niet-voor-de-hand-liggende valkuilen) en `superuser-system.md` (oud, deels verouderd). |
| `docs/handleiding/` | De handleiding voor docenten (HTML + PDF) en het stappenplan voor projecten. De Ontwerphulp leest deze bestanden. |
| `docs/canvas/` | Instructie voor de Canvas-beheerders van de VU. |
| `docs/plans/` | Plannen en metingen van grotere functies (chatbijlagen, Canvas). Momentopnames: paden kunnen sindsdien zijn verhuisd. |
| `docs/paper/` | Het artikel over LEAP. |

## Hoe een verzoek loopt

1. **De browser** (React) doet twee soorten aanroepen:
   - rechtstreeks naar Supabase (inloggen, en eenvoudige lees- en schrijfacties op tabellen).
     De database bewaakt die met **RLS-regels** (row level security) per tabel;
   - naar de eigen server: `fetch('/api/…')` met het inlogtoken in de header
     `Authorization: Bearer …` en de gekozen taal in `X-LEAP-Lang`
     (`src/lib/apiLanguage.ts`).
2. **De Express-server** ontvangt `/api/…` en kiest de route in `server/<onderwerp>/routes.js`.
   De route controleert eerst wie het is en wat die mag, met de functies uit
   `server/lib/auth.js`:
   - `requireAuthUser(req, res)` geeft `{ user, profile }` of stuurt zelf een 401;
   - `isStaffForCourse(user, profile, courseId)` voor docent-acties in een cursus;
   - `userHasCourseAccess(...)` voor studenten (lidmaatschap van de cursus);
   - `isLeapAdmin(profile)` voor beheerderszaken;
   - `rejectIfFeatureOff(...)` (`server/lib/courseFeatureGate.js`) als het onderdeel uit kan staan.
3. Daarna gebruikt de route:
   - **de database** via `supabaseAdmin` of `pgPool` (`server/lib/supabase.js`). Die omzeilen RLS,
     dus de controle in stap 2 is de enige bewaking: sla hem nooit over;
   - **Azure OpenAI** voor chat, feedback en embeddings (`server/lib/azureOpenai.js`). Er is geen
     terugval naar de publieke OpenAI;
   - **e-mail** via `server/lib/notifications.js`.
4. **Het antwoord** gaat als JSON terug. Meldingen in `error`/`message` vertaalt
   `server/i18n/serverI18n.js` onderweg naar de taal van de gebruiker.

## Waar voeg ik iets toe?

| Je wilt… | Zo |
|---|---|
| **Een nieuwe API-route** | Zet hem in de `routes.js` van het onderwerp, binnen `registerXRoutes(app)`. Begin met een controle uit `server/lib/auth.js`. Hoort hij bij geen enkel onderwerp, maak dan een map `server/<onderwerp>/` met een `routes.js` en roep `registerXRoutes(app)` aan in `server/index.js`. Regels die je los wilt testen gaan in een eigen module in dezelfde map. Voeg een test toe in `server/__tests__/`. |
| **Een nieuwe servermelding** (`error`/`message` die de gebruiker ziet) | Schrijf hem gewoon in het Nederlands in de code. Draai daarna `node scripts/extract-server-messages.mjs` en `node --env-file=.env scripts/server-i18n-generate.mjs`. |
| **Een nieuwe tekst in het scherm** | Nooit letterlijk in een component. Voeg een sleutel toe aan `src/i18n/locales/nl.json` en `en.json`, gebruik `t('sleutel')`, en draai `node --env-file=.env scripts/i18n-generate.mjs` tot "RESTEREND totaal: 0". |
| **Een nieuwe uitleg ("?"-knop)** | Voeg het id toe aan `src/help/helpTopics.ts` en de teksten `help.<id>.title` / `help.<id>.body` aan `nl.json` en `en.json`. Zet `<HelpTip>` naast de knop die hij uitlegt. Nieuw help-onderwerp in Beheer? Werk dan ook `ADMIN_SECTIONS` in `server/system/designAssistant.js` bij. |
| **Een databasewijziging** | Nieuw bestand `supabase/migrations/<JJJJMMDDUUMMSS>_<naam>.sql`, plus een terugdraaiscript in `supabase/rollback/`. Test eerst lokaal: `npm run db:local` en `bash scripts/local-db/test.sh`. Bij de volgende push naar `main` voert de app hem uit. |
| **Een nieuwe tabel met gebruikersgegevens** | Zet hem in `EXPORT_SOURCES` of `NOT_EXPORTED` in `server/account/myData.js` (een test controleert dat). |
| **Een nieuwe instelling (omgevingsvariabele)** | Voeg hem toe aan `.env.example` met één regel uitleg. Geheimen gaan in Key Vault `kv-vu-leap`, nooit in de repo. |

## Tests en controles

| Opdracht | Wat het doet |
|---|---|
| `npx vitest run` | Alle tests (server en frontend). |
| `npx vitest run server/__tests__/ragProcessing.test.js` | Eén testbestand; zo draai je de kleinste relevante set. |
| `npm run typecheck` | TypeScript-controle van de frontend. |
| `npm run lint` | ESLint over de `.ts`/`.tsx`-bestanden (de frontend). De server-JavaScript valt er nu buiten. |
| `npm run db:local` en daarna `bash scripts/local-db/test.sh` | Lege database opbouwen met alle migraties, en de RLS-tests draaien. Nodig bij elke migratie. |
| `npm run ui:audit` | Schermcontrole op drie breedtes (vraagt een draaiende app en het testaccount). |
| `node scripts/extract-server-messages.mjs --check` | Staat elke servermelding in de vertaallijst? |

Sommige `*.integration.test.js`-bestanden hebben een echte databaseverbinding nodig.
De `check-*`- en `eval-*`-scripts gebruiken het echte model en kosten dus geld en tijd;
draai ze alleen als je aan dat onderdeel werkt.
