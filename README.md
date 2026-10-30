# LEAP-VU — AI-leeromgeving

LEAP-VU is een webapplicatie van de VU Amsterdam waarin studenten met AI-ondersteuning oefenen met cursusstof. De app is ontstaan voor epidemiologie en biostatistiek, maar is niet aan één vak gebonden en ondersteunt meerdere cursussen. Alle AI-functies zijn gegrond in het cursusmateriaal dat docenten per cursus uploaden (RAG).

Live: <https://leap.vu-edulab.nl> (Azure, resourcegroep `vu-leap-rg`).

## Snel starten

```bash
npm install
cp .env.example .env     # vul de waarden in (zie hieronder)
npm run dev              # Express-server (poort 3001) en Vite (poort 5000) tegelijk
```

Open daarna <http://localhost:5000>. Vite stuurt alle `/api`-verzoeken door naar de server.
Wil je lokaal tegen de Azure-omgeving werken, dan vult `node azure/scripts/local-env.mjs`
de Supabase-waarden in je `.env` (zie [`azure/README.md`](azure/README.md)).
Let op: de server herlaadt niet vanzelf. Na een wijziging in `server/` herstart je `npm run dev`.

**Een push naar `main` gaat direct live** (GitHub Actions rolt uit naar Azure). Werk op een branch.

## Documentatie

| Document | Waarvoor |
|---|---|
| [docs/README.md](docs/README.md) | Wat staat waar: kaart van de repository, hoe een verzoek loopt, waar je iets toevoegt, tests. |
| [docs/architecture.md](docs/architecture.md) | De architectuur op één pagina, met tekening van de Azure-onderdelen. |
| [docs/security/README.md](docs/security/README.md) | Beveiliging: wie mag wat, en hoe dat is afgedwongen. |
| [docs/reference/kennisnotities.md](docs/reference/kennisnotities.md) | Valkuilen die je niet uit de code haalt. |
| [scripts/local-db/README.md](scripts/local-db/README.md) | Lokale testdatabase om migraties en RLS-regels veilig te testen. |
| [azure/README.md](azure/README.md) | Beheer op Azure: uitrollen, logboek, terugrollen, database. |
| [CLAUDE.md](CLAUDE.md) | Projectregels voor Claude Code en iedereen die code schrijft. |
| [docs/handleiding/handleiding.html](docs/handleiding/handleiding.html) | Handleiding voor docenten. |

## Functies

### Voor studenten
- **Tutorchat** (`/chat`) — stelt wedervragen in plaats van direct antwoorden te geven. Antwoorden worden onderbouwd met fragmenten uit het cursusmateriaal. Meerdere gesprekken, een zelf gekozen leerniveau (1–5) per cursus, een optioneel doel, en bijlagen (als de cursus dat aanzet).
- **"Ik leg uit"** (`/explain`) — de student legt een begrip in eigen woorden uit en krijgt feedback; of verbetert een uitleg met bewust aangebrachte fouten. De begrippen komen uit het cursusmateriaal.
- **Quiz** (`/quiz`) — vragen uit een mix van cursusmateriaal (RAG), een vraagbank en LLM-generatie. De docent bepaalt de verhouding per cursus. Daarnaast ShareStats-onderwerpen (`/sharestats`).
- **Studiecafé** (`/studiecafe`) — forum per cursus met reacties en e-mailmeldingen.
- **Projecten** (`/projects`) — groepsruimtes met project-bots (begeleider, beoordelaar, rolspeler).
- **Leerdagboek** (`/feedback`), **Bronnen** (`/resources`) en **Mijn gegevens** (`/my-data`).

### Voor docenten en admins
- **Cursusmateriaal** (`/admin?tab=material`) — één werkruimte per cursus in vier stappen: *Bestanden → Verwerking → Begrippen → Klaar voor studenten*, plus de *Leerlijn*. Elk bestand krijgt een **doel**, dat bepaalt wie het ziet en wat de AI ermee doet:

  | Doel | Voorbeelden | AI-gebruik | Studenten |
  |---|---|---|---|
  | Leerstof | colleges, slides, syllabus | chat, Ik leg uit, quiz, begrippen | ja |
  | Cursusinformatie | studiehandleiding, rooster | alleen praktische vragen in de chat | ja |
  | Projectmateriaal | opdracht, data, literatuur (per project) | projectbegeleiding | in het project |
  | Alleen delen | formats, sjablonen | geen | download via Bronnen |
  | Alleen voor docenten | antwoordmodellen, tentamens | nooit | nooit (afgeschermd in de database) |

  Leerstof en cursusinformatie worden omgezet naar platte tekst, in stukken (chunks) verdeeld, voorzien van embeddings en opgeslagen in pgvector. Met *Website toevoegen* kan ook een documentatiesite (bijv. een Quarto-boek) als bron dienen.
- **Cursusbeheer** (`/admin/courses`) — cursussen, zichtbaarheid, toegangsroute (gesloten, Canvas, open), cursus-info en leden.
- **Beheer** (`/admin`) — op volgorde van het opzetten van een cursus: Inhoud (Cursusmateriaal, Projecten), AI-tutor (Tutor-instructies, Zoekgevoeligheid), Quiz (bronnen, vraagbanken), Openstellen (Onderdelen aan/uit, Deelnemers toevoegen), Volgen (Analytics). Admins hebben daarnaast Systeem.
- **Ontwerphulp** — een optionele chatbot in Beheer die docenten helpt hun cursusdoelen te vertalen naar keuzes in LEAP.

### Meertaligheid
De interface is beschikbaar in 20 talen (zie `src/i18n/locales/`). De AI antwoordt in de gekozen taal.

## Technologie

| Onderdeel | Technologie |
|---|---|
| Frontend | React 18 + TypeScript + Vite, Tailwind CSS, React Router 7, TipTap, KaTeX, MathLive |
| Backend | Node.js + Express 5 (`server/index.js`, poort 3001), routes per onderwerp in `server/<onderwerp>/` |
| Database & auth | Supabase-software in eigen beheer op Azure: Postgres + pgvector, Auth (GoTrue), PostgREST, Storage |
| LLM (chat, feedback, quizgeneratie) | Azure OpenAI van de VU, via deployment-naam |
| Embeddings | Azure OpenAI `text-embedding-3-small` — **geen** terugval naar de publieke OpenAI-API |
| Documentverwerking | pdfjs-dist, mammoth, officeparser, LibreOffice (`soffice`) voor de weergave |
| E-mail | Azure Communication Services (op Azure), Resend (elders) |
| Tests | Vitest + Testing Library |

## Instellingen

Alle omgevingsvariabelen staan met uitleg in [`.env.example`](.env.example). Minimaal nodig
voor lokaal werken: de Supabase-waarden (`VITE_PUBLIC_SUPABASE_URL`,
`VITE_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`) en
Azure OpenAI (`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`,
`AZURE_OPENAI_EMBEDDING_DEPLOYMENT`). Commit `.env` nooit; op Azure staan de geheimen in
Key Vault `kv-vu-leap`.

Zonder `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` geven de chat-endpoints een 503. Zonder `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` falen alle embedding-calls (upload, RAG-zoekvragen, conceptextractie) expliciet met een 503.

**LibreOffice (alleen op de server).** De documentviewer zet Word- en PowerPoint-bronnen om naar pdf, en Word-bronnen krijgen daarmee bij het inlezen paginanummers. Daarvoor moet LibreOffice op de machine staan die de server draait; de Docker-image heeft het al. Op een Mac: `brew install --cask libreoffice`. Op Windows: `winget install TheDocumentFoundation.LibreOffice` (de server vindt `soffice.exe` vanzelf, of zet `SOFFICE_BIN`). Bij het opstarten meldt de server welke LibreOffice hij gebruikt. Zonder LibreOffice toont de viewer Office-bestanden als tekst.

## Hosting

LEAP draait als één container: de Express-server serveert ook de gebouwde frontend. De `Dockerfile` bevat Node 22, LibreOffice zonder grafische schil en de lettertypen Carlito/Caladea (maat-compatibel met Calibri/Cambria, zodat de paginering van Word-documenten klopt).

Op Azure gaat dat vanzelf: een push naar `main` bouwt de image en rolt hem uit via `.github/workflows/azure-deploy.yml`; nieuwe migraties in `supabase/migrations/` voert de app bij het starten zelf uit (`scripts/migrate.mjs`). Zie [docs/architecture.md](docs/architecture.md) en [azure/README.md](azure/README.md).

- De twee `VITE_PUBLIC_`-waarden komen in de frontendbundel (publiek). Alle geheimen gaan alleen als runtime-omgeving mee, nooit in de image.
- **Weergaveversies worden bij het uploaden gemaakt.** Word- en PowerPoint-bronnen krijgen een pdf-versie (opslag onder `__renditions__/`), zodat studenten altijd een kant-en-klare pdf openen. Bestaande bronnen die zonder LibreOffice zijn ingelezen, bereid je eenmalig voor met `node scripts/prepare-office-sources.mjs` (`--dry-run` om eerst te tellen).
- De omzetting zelf zit in `convertOfficeToPdf` in `server/documents/documentRender.js`.

## Rollen

- **Student** — gebruikt de cursussen waarvan hij lid is.
- **Docent** — beheert eigen cursussen: materiaal, begrippen, instructies, bronnenmix, leden.
- **Admin** — volledige toegang, inclusief gebruikers, rollen en platforminstellingen.

Een vast beheerdersaccount houdt altijd admin-rechten via databasetriggers; zie [docs/reference/superuser-system.md](docs/reference/superuser-system.md) (oud document, deels verouderd).

Beveiliging loopt via Row Level Security in de database en controles op de server (`server/lib/auth.js`). Wat docenten wel en niet over studenten mogen zien, staat in [CLAUDE.md](CLAUDE.md) en [docs/security/README.md](docs/security/README.md).

## Testen

```bash
npx vitest run                                         # alle tests
npx vitest run server/__tests__/ragProcessing.test.js  # één bestand
npm run typecheck
npm run lint
npm run db:local && bash scripts/local-db/test.sh      # migraties en RLS, lokaal in Docker
```

Sommige `*.integration.test.js`-bestanden hebben een werkende databaseverbinding nodig. `chatConfig.endpoints.test.js` en `translateContentEndpoint.test.js` testen gedrag zónder Azure-configuratie; ze kunnen falen zolang er een `.env` met Azure-sleutels in de projectmap staat (de server laadt die bij het importeren).

## Migraties en terugdraaien

Databasewijzigingen staan in `supabase/migrations/` (`<JJJJMMDDUUMMSS>_<naam>.sql`), elk met een terugdraaiscript in `supabase/rollback/`. Op Azure voert de app nieuwe migraties zelf uit bij het starten. Handmatig: `node --env-file=.env scripts/migrate.mjs --status` (wat staat nog open) of `node scripts/run-sql.mjs <bestand>` (één bestand, bv. een terugdraaiscript). Test een nieuwe migratie eerst met de [lokale testdatabase](scripts/local-db/README.md).

Git-tags als terugvalpunt: `pre-beheer-redesign` (vóór de herinrichting van Beheer) en `pre-ontwerphulp-2026-10-07` (vóór de Ontwerphulp).

## Troubleshooting

- **Chat geeft een 503 "Azure OpenAI is niet geconfigureerd"** — controleer `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` en `AZURE_OPENAI_DEPLOYMENT`, en herstart de server.
- **Upload/RAG faalt met een embeddings-fout** — controleer `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`. Bij een 429 (snelheidslimiet) probeert de server het opnieuw; uploads lopen via een wachtrij, twee tegelijk.
- **Document levert geen of rare chunks op** — controleer het aantal chunks in Cursusmateriaal → Verwerking. Eén enorme chunk of tekst als `[object Object]` wijst op een extractieprobleem en moet worden onderzocht, niet genegeerd.
- **Een functie werkt lokaal niet na een serverwijziging** — de server herlaadt niet vanzelf; herstart `npm run dev`.
- **"Nog steeds kapot" na een fix** — kijk op GitHub onder *Actions* of de uitrol is gelukt. Mislukte migraties houden de vorige versie draaiende.
- **Geen toegang tot beheer** — controleer je rol (rechtsboven) of vraag een admin om die aan te passen.

## Licentie

Ontwikkeld voor educatief gebruik aan de VU Amsterdam.

### Persona-gezichten

De avatars van persona's worden gemaakt met [DiceBear](https://www.dicebear.com/) (MIT). Gebruikte stijlen:
Bottts en Avataaars van Pablo Stanley (vrij voor persoonlijk en commercieel gebruik),
Open Peeps van Pablo Stanley (CC0 1.0), Lorelei van Lisa Wischofsky (CC0 1.0) en Notionists van Zoish (CC0 1.0).
