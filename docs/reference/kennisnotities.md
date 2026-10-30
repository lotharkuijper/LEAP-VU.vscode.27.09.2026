# Kennisnotities

Valkuilen en achtergronden die je niet zomaar uit de code haalt. Ze komen uit de
notities van eerdere ontwikkelrondes (2026), zijn in oktober 2026 nagelopen tegen de
code en bijgewerkt naar de nieuwe mappenindeling. Projectregels staan in
[CLAUDE.md](../../CLAUDE.md); bij twijfel geldt CLAUDE.md.

## Taalmodel (Azure OpenAI)

- **De deployment bepaalt het model, niet `OPENAI_MODEL`.** Azure routeert op de deployment
  in de URL en negeert het veld `model` in de body. `OPENAI_MODEL` stuurt alleen de keuze
  van parameters (reasoning-model of niet). Ander model? Verander `AZURE_OPENAI_DEPLOYMENT`.
  Daarom kan het opstartlog `gpt-5.2` tonen terwijl `gpt-5.5` antwoordt.
- **Reasoning-modellen (gpt-5.x, o-serie) weigeren een eigen `temperature`/`top_p` en
  `max_tokens`.** Elke aanroep bouwt zijn parameters via `chatModelParams`
  (`server/lib/azureOpenai.js`): geen temperature, wel `reasoning_effort`, en
  `max_completion_tokens`. Wissel je van deployment, test dan eerst wat hij accepteert.
- **Een HTTP 200 met lege inhoud is "tokens op", geen succes.** Redeneertokens tellen mee
  in het budget. `isEmptyOrTruncatedCompletion` (`server/lib/openaiSampling.js`) herkent
  dat; `/api/chat` probeert dan één keer met een groter budget en geeft anders een 502
  met code `empty_response` of `length`.
- **De foutteksten in de browser komen uit één functie**, `llmErrorToDutch`
  (`src/services/llm.service.ts`). Let op: die vertaalt elke 401/403 naar "het model weigerde
  de toegang", ook als het eigenlijk een verlopen inlogsessie is.
- **Embeddings hebben bewust geen standaard-deployment.** Zonder
  `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` geeft alles wat embeddings nodig heeft een 503, zodat
  een fout nooit stil naar een andere dienst uitwijkt. `AZURE_EMBEDDINGS_READY` controleert
  alleen dat de variabele gezet is, niet dat de deployment bestaat.
- **"Alles scoort 0" bij zoeken of begrippenextractie** betekent bijna altijd dat de
  embedding-aanroep zelf faalt (bv. 404: deployment bestaat niet), niet dat de drempel te
  hoog staat. Controleer met één directe aanroep naar `/embeddings` en kijk of de opgeslagen
  vectoren 1536 dimensies hebben.
- **JSON-antwoorden in andere talen:** een aanroep met `response_format: json_object` én een
  taalinstructie moet het model zeggen dat sleutels en vaste waarden (enums) onvertaald
  blijven. Gebruik `buildLanguageInstruction(lang, { json: true })`
  (`server/i18n/languages.js`). Anders vertaalt het model de sleutels en faalt het inlezen,
  maar alleen in talen buiten nl/en, dus tests in nl/en blijven groen.

## Inlezen van documenten (RAG)

- **Inlezen gebeurt alleen op de server.** De browser uploadt het bestand en maakt de
  `documents`-rij; tekst eruit halen, opdelen, embedden en opslaan gebeurt in
  `server/ingestion/`. Voeg nooit weer chunks toe of verwijder ze vanuit de browser.
- **Opnieuw inlezen moet in één transactie.** `persistChunksAtomic`
  (`server/ingestion/ragProcessing.js`) verwijdert de oude chunks, zet de nieuwe erin en
  zet de status op `completed` in één Postgres-transactie. Dat werkt alleen met `pgPool`,
  dus `SUPABASE_DB_URL` moet in productie gezet zijn; zonder (tests) is het niet atomair.
- **Pdf's gaan via pdf.js, niet via officeparser.** officeparser kan "slagen" met een paar
  tekens rommel. Levert een pdf minder dan 20 tekens op, dan faalt het inlezen met 422.
  Gescande pdf's zonder tekstlaag hebben OCR nodig.
- **Postgres weigert NUL-tekens en losse UTF-16-surrogaten** ("unsupported Unicode escape
  sequence"). Haal alle tekst en metadata (ook de sleutels) door `sanitizeText` /
  `sanitizeMetadata`: `server/lib/sanitizeText.js` en de spiegel `src/lib/sanitizeText.ts`
  (houd ze gelijk). De regex mag geen lookbehind gebruiken: oudere Safari crasht dan bij het laden.
- **Een webpagina wordt herkend aan haar genormaliseerde URL.** Die URL is de sleutel
  (`documents.file_path`); opnieuw importeren vervangt de chunks van die sleutel. Strip dus
  alleen onmiskenbare trackers (`TRACKING_PARAM_RE` in `server/ingestion/webImport.js`), niet
  `?ref=` of andere query's, anders wist de ene pagina de andere. Liever een dubbele pagina
  dan stil verlies.
- **Website-import en SSRF:** controleer het IP-adres op het moment van verbinden, niet
  vooraf (`createPinnedLookup` in `webImport.js`, gebruikt in `server/ingestion/routes.js`).
  Een IP-adres als hostnaam slaat die stap over, dus `isBlockedHost` moet die apart weigeren.
  "Veilig" betekent publiek routeerbaar, inclusief IPv4-in-IPv6 in hex-vorm (`::ffff:7f00:1`).
- **De vectorindex is HNSW**, niet ivfflat (migratie `20260612100000_document_chunks_hnsw_index.sql`).
  ivfflat met weinig chunks gaf stil nul resultaten. Lijkt zoeken niets te vinden terwijl
  een gewone `ORDER BY embedding <=> …` wel resultaat geeft, dan is het de index.

## Zoeken in het materiaal

- **Twee poorten knippen het aantal fragmenten:** `match_count` uit de zoekinstellingen
  (`__rag_settings_<cursus>__`) en `RAG_CONTEXT_MAX_CHUNKS` (nu 15) in
  `src/services/rag.service.ts`. Vindt de tutor iets niet dat er wel is, kijk dan naar beide,
  en naar de plaats (rang) van het fragment, niet alleen de score. De echte rem op lengte is
  `RAG_CONTEXT_MAX_CHARS`.
- **Filter op document vóór de LIMIT.** `match_document_chunks` krijgt
  `filter_document_ids`; anders verdringen andere cursussen de fragmenten van een kleine cursus.
- **Embeddings krijgen de documenttitel ervoor** (`buildEmbedInput` in `server/rag/chunking.js`);
  de opgeslagen tekst blijft schoon.

## Begrippen

- **Vervangen-modus: eerst schrijven, dan opruimen.** Bij opnieuw extraheren schrijft de
  route eerst alle begrippen en stopt bij een schrijffout vóór het opruimen. Het opruimen
  spaart elke naam uit deze ronde (`planConceptReplace`, `server/concepts/conceptExtraction.js`).
  Zet het RAG-label alleen op rijen die het al hadden, anders worden handmatige begrippen
  later weggeruimd.
- **Extractie bewaart niets?** Vermoed eerst een taalverschil: noemt het model begrippen in
  het Nederlands terwijl het materiaal Engels is, dan haalt de controle met embeddings de
  drempel niet. De route heeft een `language`-parameter (`nl`, `en`, `auto`) en geeft
  afgewezen kandidaten met hun beste score terug.

## Database en schema

- **`course_members` heeft twee rolkolommen.** `member_role` is de echte rol; `role` is een
  oude NOT NULL-kolom die bij elke schrijfactie mee moet (gelijk aan `member_role`, behalve
  `superuser`, die blijft). Er is geen kolom `id`: selecteer `user_id`.
- **`course_members` schrijft alleen de server** (service-role). Er zijn bewust geen
  INSERT/UPDATE/DELETE-regels voor gewone gebruikers. Voeg er nooit een toe.
- **Oude databases missen soms nieuwere kolommen** (Postgres-fout `42703`). Waar de code
  terugvalt zonder een kolom (bv. persona's in `server/projects/personaRoutes.js`), moet de
  laatste poging alle optionele kolommen tegelijk weglaten, niet alleen de laatste.
- **Een nieuwe taal vraagt een migratie.** `profiles.preferred_lang` heeft een CHECK
  (`profiles_preferred_lang_check`) met alle toegestane codes. Zonder nieuwe migratie kan
  een gebruiker de taal kiezen, maar faalt het bewaren.
- **`preferred_lang` heeft geen standaardwaarde, en dat moet zo blijven.** Nieuwe accounts
  krijgen NULL, zodat de browsertaal wint. Er is één plek die de actieve taal bepaalt:
  `getActiveLang` in `src/i18n/activeLang.ts` (gekozen → bewaard → browser → Engels).
- **Instellingen per cursus zijn rijen in `chatbot_prompts` met een gereserveerde naam**:
  `__rag_settings_<id>__`, `__explain_prompt_<id>__`, `__chat_prompt_<id>__`,
  `__quiz_itembank_config_<id>__`. Ze krijgen `section='internal'` en `is_active=false`, en
  globale zoekacties sluiten ze uit met `LIKE`, niet met `=`. Anders wordt een JSON-rij per
  cursus als tutorprompt geserveerd.

## Toegang en beveiliging

- **`requireAuthUser` geeft `{ user, profile }` zonder `role`.** Alleen `requireAdminOrDocent`
  geeft een `role` terug. Gebruik voor docentcontroles per cursus altijd
  `isStaffForCourse(user, profile, courseId)` (`server/lib/auth.js`), nooit `auth.role`
  na `requireAuthUser`: dat gaf een beheerder ooit een onterechte 403.
- **Een `courseId` uit de request-body is onbetrouwbaar.** Controleer toegang
  (`userHasCourseAccess` of `isStaffForCourse`) voordat je iets per cursus laadt, zoals de
  tutor-instructie van die cursus.
- **Routes met `supabaseAdmin` omzeilen RLS.** De controle in de route is dan de enige
  bewaking. Voorbeeld: de mappenboom van een docent wordt in de app begrensd
  (`computeTeacherFolderScope` in `server/rag/documentScope.js`, `resolveDocFolderAccess`
  in `server/documents/routes.js`). De bovenliggende map telt alleen mee als die echt een
  cursusmap is, anders lekt een kapotte koppeling naar alle cursussen.
- **Projecten horen bij precies één cursus.** Geef in RLS nooit toegang op basis van de
  globale `profiles.role = 'docent'`; gebruik lidmaatschap van díe cursus
  (`pr_user_has_course_access`, `pr_is_course_staff`). Delen met een andere cursus gaat door kopiëren.
- **Vraagbank per cursus:** CSV-vragen horen bij één cursus (`metadata.course_id`),
  ShareStats is gedeeld. Elke leesroute moet `.or(itembankSourceOrFilter(courseId))`
  (`server/quiz/itembankScope.js`) gebruiken. Stapel geen tweede `.or()` op dezelfde query.
- **Verborgen cursus ≠ gearchiveerde cursus.** `student_visible` (tijdelijk verborgen) is
  los van `is_active` (gearchiveerd). Een verborgen cursus is alleen voor de docent.
- **PostgREST geeft bij een verborgen bovenliggende rij `null` terug in een join**, geen
  ontbrekende rij. Filter die rijen weg in de browser (zoals `CourseAccessContext` doet).
  `ActiveCourseContext` markeert de actieve cursus als onbeschikbaar alleen bij "0 rijen"
  (PGRST116), niet bij een netwerkfout.
- **Globale instellingen** (sjablonen, ShareStats-import, globale zoekinstellingen) mag
  alleen de beheerder wijzigen. Verberg het scherm voor docenten én bewaak het schrijven op
  de server of in RLS; alleen verbergen is niet genoeg.
- **Soft-delete in een tabel die gebruikers direct kunnen lezen moet de inhoud wissen**, niet
  alleen een `deleted_at` zetten (Studiecafé: `body=''`, `title=''`, `author_id=null` in
  dezelfde UPDATE). Antwoorden onder een verwijderde draad gaan in dezelfde transactie mee;
  zonder transactie eerst de antwoorden, dan de draad.

## Studiecafé

- **"Nieuw" heeft drie lagen:** een startdatum per gebruiker en cursus (oude berichten tellen
  niet), gelezen-markeringen per draad, en `manual_unread` (de student markeert zelf als
  ongelezen; gaat boven de andere twee). De regels staan in `isThreadUnreadFor`
  (`server/studiecafe/studiecafe.js`) en gespiegeld in `StudiecafePage.tsx`; houd ze gelijk.
- **Meldingen worden in de database ontdubbeld**: een gedeeltelijke unieke index op
  `studiecafe_notifications(dedup_key) WHERE sent_at IS NULL`. Insert met
  `ON CONFLICT (dedup_key) WHERE sent_at IS NULL DO NOTHING`.
- **Is e-mail niet ingesteld, dan blijft de wachtrij staan** en gaat alles alsnog uit zodra
  het wel werkt. De mails zijn in alle talen: teksten `email.digest.*` in de locale-bestanden,
  geladen via `server/i18n/notificationI18n.js`. Na een nieuwe sleutel: `i18n-generate.mjs` draaien.

## Projecten

- **Raadpleeglimiet faalt dicht.** Lukt het tellen van gesprekken niet (tijdelijke fout), dan
  een 503, niet "0 gebruikt". Alleen een ontbrekende tabel of kolom betekent onbeperkt.
- **Herlaad de projectruimte na het afsluiten van een gesprek** (`loadRoom` in
  `ProjectRoomPage.tsx`). Anders klopt "heeft open gesprek" niet meer en start het volgende
  bericht een nieuwe raadpleging zonder bevestigingsvraag.

## Leerdagboek

- **`learning_journal_entries.course_id` mag leeg zijn.** Projecten halen de cursus uit
  `projects.course_id`; chat, quiz en Ik leg uit sturen de actieve cursus mee en de server
  controleert die met `resolveJournalCourseId` (`server/journal/journalCourse.js`). Een
  ongeldige cursus wordt `null`; de notitie gaat nooit verloren door een cursusfout.

## Frontend

- **Nooit `await` op Supabase binnen `onAuthStateChange`.** Dat blokkeert de hele client
  (inlogknop draait eeuwig). Zet alleen de sessie en laad het profiel daarna met
  `setTimeout(…, 0)`. Inloggen wacht nooit op het profiel; netwerkaanroepen bij het inloggen
  hebben een time-out (`withTimeout` in `src/contexts/AuthContext.tsx`).
- **Bestaand account bij registreren:** `signUp` geeft dan geen fout maar een gebruiker met
  `identities: []`. Dat betekent "account bestaat al".
- **Alle serverroutes geven 401 terwijl de browser nog "ingelogd" denkt?** Dan is de bewaarde
  sessie dood (bv. na het wisselen van sleutels). Bij het laden controleert de app de sessie
  en logt alleen uit bij een definitieve fout (`isDefinitiveAuthError`, `src/lib/authSession.ts`),
  niet bij netwerk- of 5xx-fouten.
- **pdf.js v5 heeft alleen een `.mjs`-worker.** Laad hem via Vite:
  `import url from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` (zoals in `DocumentViewer.tsx`
  en `document-processor.service.ts`). Een CDN-adres met `.js` bestaat niet meer.
- **Importeer `document-processor.service.ts` niet in tests**: pdfjs crasht in Node met
  `DOMMatrix is not defined`. Zet pure pdf-hulpfuncties in `src/services/pdf-pages.ts` en test daar.
- **De viewer-crash was een ResizeObserver-lus**, niet pdf.js. De callback rendert nu via
  `requestAnimationFrame` en alleen als de breedte echt verandert. `src/main.tsx` heeft een
  vangnet (`[async-guard]`) dat elke niet-Error-afwijzing volledig logt; zo vind je de bron.
- **Zware pakketten die alleen achter een lazy pagina zitten, moeten in
  `optimizeDeps.include`** (`vite.config.ts`). Anders bundelt Vite ze halverwege een sessie
  opnieuw en krijg je "Failed to fetch dynamically imported module" of "Invalid hook call".
  `pdfjs-dist` en `lucide-react` staan juist in `exclude`.

## Documentviewer en LibreOffice

- **LibreOffice meldt bij het starten "Could not find a Java Runtime Environment" en
  "Failed to initialize OpenCL".** Onschuldig; de omzetting lukt gewoon.
- **Eén LibreOffice-omzetting tegelijk, elk met een eigen profielmap**
  (`-env:UserInstallation`), anders zitten ze elkaar in de weg (`server/documents/documentRender.js`).

## Vertalingen

- **`i18n-generate.mjs` vult alleen ontbrekende sleutels.** Verander je de Nederlandse tekst
  van een bestaande sleutel, dan blijven de andere talen de oude vertaling houden. Verwijder
  de sleutel dan in die talen (of pas ze aan) en draai het script opnieuw.
- **Een nieuwe taal toevoegen** raakt deze plekken, die elk hun eigen lijst hebben:
  `src/i18n/languages.ts` (`SUPPORTED_LANGUAGES`), `src/i18n/translations.ts` (`lazyLoaders`),
  `src/lib/translationLanguages.ts`, `server/i18n/languages.js` (`LANG_ENGLISH_NAMES`),
  `server/documents/documentTranslation.js` (`LANGUAGES`), `TARGET_LANGS` in
  `scripts/i18n-generate.mjs` en `scripts/server-i18n-generate.mjs`, de typen in
  `src/lib/database.types.ts`, een nieuw `src/i18n/locales/<code>.json` en
  `server/i18n/messages.<code>.json`, `RTL_LANGS` in `DocumentViewer.tsx` (alleen voor
  rechts-naar-links), plus de migratie voor de CHECK hierboven.

## Werkwijze

- **De server herlaadt niet vanzelf.** `npm run dev` start de server met gewone `node`. Werkt
  een nieuwe route "niet" (404 of stil terugvallen in de browser), herstart dan eerst `npm run dev`.
- **"Nog steeds kapot" na een fix?** Kijk eerst of de fix echt live staat: is hij op `main`,
  is de GitHub-uitrol groen, en heeft de gebruiker de pagina ververst? Een mislukte migratie
  houdt de oude versie draaiende. Pas daarna de code aan.
- **Een route testen als een bepaalde gebruiker** kan zonder wachtwoord of mail:
  `auth.admin.generateLink({ type: 'magiclink', email })` met de service-role, dan
  `auth.verifyOtp({ token_hash, type: 'email' })` met de anon-client geeft een echt token.
  Doe dit alleen met testaccounts (zie de `check-*`-scripts), nooit als een echte student.

## Weggelaten notities

Deze oude notities zijn niet overgenomen:

- `concept-course-scoping`: verouderd. `concepts.course_id` bestaat sinds migratie
  `20260918120000_backfill_concepts_course_id`, en `/api/concepts` valt niet meer terug op
  begrippen zonder cursus.
- `course-content-access-model`: verouderd. Sinds 2026-10-20 is toegang lidmaatschap, niet
  zichtbaarheid (`canAccessCourseContent` in `server/courses/courseAvailability.js`).
- `test-env-flakiness`: ging over de Replit-sandbox. De ruimere time-outs staan met uitleg in
  `vite.config.ts`.
- Delen van andere notities zijn ook weggelaten: alles over Replit (workflows, "Published
  your App", de Resend-connector, de foutmelding-overlay van de preview), Groq en
  `replit.md`, de verwijderde tab "Documenten", het oude Studiecafé-publiek "alle studenten"
  (achterhaald door lidmaatschap), en de "nog lekke" RLS-regels voor docenten (gedicht in
  migratie `20261008100000_teacher_privacy`).
