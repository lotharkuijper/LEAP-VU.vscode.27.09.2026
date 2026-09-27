# LEAP-VU — AI-leeromgeving

LEAP-VU is een webapplicatie van de VU Amsterdam waarin studenten met AI-ondersteuning oefenen met cursusstof. De app is ontstaan voor epidemiologie en biostatistiek, maar ondersteunt inmiddels meerdere cursussen. Alle AI-functies zijn gegrond in het cursusmateriaal dat docenten per cursus uploaden (RAG).

## Functies

### Voor studenten
- **Socratische chatbot** (`/chat`) — stelt wedervragen in plaats van direct antwoorden te geven. Antwoorden worden onderbouwd met relevante fragmenten uit de cursusdocumenten. Ondersteunt meerdere gesprekken, persona's en een zelf in te stellen leerniveau (1–5) per cursus.
- **"Ik leg uit"** (`/explain`) — de student legt een begrip in eigen woorden uit en krijgt AI-feedback op juistheid en volledigheid. De begrippen worden per cursus uit de geüploade documenten geëxtraheerd.
- **Quiz** (`/quiz`) — vragen uit een mix van drie bronnen: cursusmateriaal (RAG), een itembank en LLM-generatie. De docent bepaalt de verhouding per cursus (standaard 50% RAG / 0% itembank / 50% LLM). Daarnaast zijn er ShareStats-onderwerpen (`/sharestats`).
- **Studiecafé** (`/studiecafe`) — discussieforum per cursus met categorieën (vraag, discussie, samenwerken, check-llm), reacties en e-mailmeldingen.
- **Projecten** (`/projects`) — projecten met groepsruimtes.
- **Bronnen** (`/resources`) en **feedback** (`/feedback`).

### Voor docenten en admins
- **Cursusmateriaal** (`/admin?tab=material`) — één werkruimte per cursus in vier stappen: *Bestanden → Verwerking → Begrippen → Klaar voor studenten*. Elk bestand krijgt een **doel**, dat bepaalt wie het ziet en wat de AI ermee doet:

  | Doel | Voorbeelden | AI-gebruik | Studenten |
  |---|---|---|---|
  | Leerstof | colleges, slides, syllabus | chat, Ik leg uit, quiz, begrippen | ja |
  | Cursusinformatie | studiehandleiding, rooster | alleen praktische vragen in de chat | ja |
  | Projectmateriaal | opdracht, data, literatuur (per project) | projectbegeleiding | in het project |
  | Alleen delen | formats, sjablonen | geen | download via Bronnen |
  | Alleen voor docenten | antwoordmodellen, tentamens | nooit | nooit (afgeschermd in de database) |

  LEAP stelt bij uploaden een doel voor op basis van naam en inhoud. Bestaande bestanden gaan één keer door een controle. Leerstof en cursusinformatie worden omgezet naar platte tekst, in chunks verdeeld (~380 tokens met 60 tokens overlap), voorzien van embeddings en opgeslagen in pgvector. "Klaar voor studenten" toont waarschuwingen (bijv. begrippen zonder bronfragment, zichtbare antwoordmodellen) en laat je een voorbeeldvraag maken als student.

  **Websites als bron:** met *Website toevoegen* (in *Bestanden*) plak je het adres van een leeromgeving of documentatiesite (bijv. een Quarto-boek). LEAP zoekt de pagina's (sitemap of links, max. 80), je vinkt ze per pagina of per map aan en kiest *Leerstof* of *Cursusinformatie*. De site verschijnt daarna als één bron met aantal pagina's, fragmenten en datum van laatste ophaling. *Opnieuw ophalen* verwerkt alleen gewijzigde pagina's opnieuw; pagina's die de site niet meer levert worden gemeld maar niet stilzwijgend verwijderd. Doel wijzigen en verwijderen gaan per hele site (tabel `web_sources`, migratie `20260926100000_web_sources.sql`).
- **Cursusbeheer** (`/admin/courses`) — cursussen, zichtbaarheid, banners en leden beheren.
- **Beheer** (`/admin`) — onder *Mijn cursus*: quizbronnen, projecten (met het tabblad *Persona-sjablonen*: kant-en-klare persona's van de cursus, die een project als eigen kopie overneemt), cursus-info, leerniveaus, chat-instructies, zoekgevoeligheid (Ruim / Gebalanceerd / Streng), imports (externe vraagbanken zoals ShareStats) en gebruikers toevoegen. Onder *Systeembeheer* (admin): gebruikers en instellingen. De vorige indeling (Documenten, RAG Beheer, Begrippen) staat ingeklapt onder *Klassieke weergave*.

### Meertaligheid
De interface is beschikbaar in 20 talen (o.a. Nederlands, Engels, Duits, Frans, Chinees, Arabisch); zie `src/i18n/locales/`. De AI antwoordt in de gekozen taal.

## Technologie

| Onderdeel | Technologie |
|---|---|
| Frontend | React 18 + TypeScript + Vite, Tailwind CSS, React Router 7, TipTap, KaTeX |
| Backend | Node.js + Express 5 (`server/index.js`, poort 3001) |
| Database & auth | Supabase (PostgreSQL + pgvector, Auth, Storage, Edge Functions) |
| LLM (chat, feedback, quizgeneratie) | Azure OpenAI (VU-resource), via deployment-naam |
| Embeddings | Azure OpenAI `text-embedding-3-small` — **geen** terugval naar de publieke OpenAI-API |
| Documentverwerking | pdfjs-dist, mammoth, officeparser, LibreOffice (`soffice`) voor rendering |
| E-mail | Resend (optioneel, voor Studiecafé-meldingen) |
| Tests | Vitest + Testing Library |

In development draait Vite op `http://localhost:5173` en stuurt alle `/api`-verzoeken door naar de Express-server op `http://localhost:3001`.

## Installatie

### 1. Omgevingsvariabelen

Maak een `.env` in de hoofdmap (commit dit bestand nooit):

```env
# Supabase
VITE_PUBLIC_SUPABASE_URL=
VITE_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_URL=

# Azure OpenAI
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_API_VERSION=2024-10-21
AZURE_OPENAI_DEPLOYMENT=
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=
# AZURE_OPENAI_EMBEDDING_API_VERSION=   # optioneel, standaard gelijk aan AZURE_OPENAI_API_VERSION

# Optioneel
# OPENAI_MODEL=              # modelnaam voor parameterkeuze (bijv. gpt-5.x / gpt-4o-mini)
# RESEND_API_KEY=            # e-mailmeldingen
# NOTIFICATION_FROM_EMAIL=
# GITHUB_TOKEN=              # ShareStats-inhoud ophalen van GitHub
# SOFFICE_BIN=soffice        # pad naar LibreOffice
# APP_PUBLIC_URL=            # basis-URL in e-mails/links
# PORT=3001
```

Zonder `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` geven de chat-endpoints een 503. Zonder `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` falen alle embedding-calls (upload, RAG-zoekvragen, conceptextractie) expliciet met een 503.

### 2. Database

De databasestructuur staat in `supabase/migrations/`. Pas de migraties toe op je Supabase-project (bijv. met de Supabase CLI: `supabase db push`). Edge Functions staan in `supabase/functions/`.

### 3. Starten

```bash
npm install
npm run dev          # start Express-server én Vite tegelijk
```

Losse onderdelen: `npm run dev:server` of `npm run dev:frontend`.

Overige scripts: `npm run build`, `npm run lint`, `npm run typecheck`.

## Rollen

- **Student** — standaardrol bij registratie. Toegang tot chat, uitleg, quiz, Studiecafé en projecten van zichtbare cursussen.
- **Docent** — beheert eigen cursussen: documenten, begrippen, bronnenmix, leden.
- **Admin** — volledige toegang, inclusief gebruikers- en rolbeheer.

Het account `l.d.j.kuijper@vu.nl` krijgt altijd admin-rechten via databasetriggers en een Edge Function; zie [SUPERUSER_SYSTEM.md](SUPERUSER_SYSTEM.md).

Beveiliging loopt via Supabase Row Level Security en server-side controles op cursustoegang en staf-rol. Schrijfacties met de service-role verifiëren altijd dat de rij bij de gevraagde cursus hoort.

## Projectstructuur

```
src/
  pages/          pagina's (Chat, Explain, Quiz, Studiecafe, Admin, ...)
  components/     UI-componenten
  contexts/       AuthContext, ActiveCourseContext, CourseAccessContext
  services/       LLM-, RAG-, quiz-, upload- en ShareStats-services
  lib/            gedeelde helpers + Supabase-types
  i18n/           vertalingen
server/
  index.js        Express-API (alle /api-routes)
  chunking.js, ragProcessing.js, conceptExtraction.js, conceptEvidence.js
                  ingestie- en RAG-pijplijn
  __tests__/      server-tests
supabase/
  migrations/     databaseschema
  functions/      Edge Functions
scripts/          evaluatie- en onderhoudsscripts
```

## Testen

```bash
npx vitest run                                         # alle tests
npx vitest run server/__tests__/ragProcessing.test.js  # ingestie/chunking
npx vitest run server/__tests__/conceptExtraction.test.js
```

Sommige `*.integration.test.js`-bestanden hebben een werkende databaseverbinding nodig. `chatConfig.endpoints.test.js` en `translateContentEndpoint.test.js` testen gedrag zónder Azure-configuratie; ze falen zolang er een `.env` met Azure-sleutels in de projectmap staat (`server/index.js` laadt die opnieuw in).

## Migraties en terugdraaien

Databasewijzigingen staan in `supabase/migrations/`; voer ze uit met `node scripts/run-sql.mjs <bestand>`. Voor de bestandsdoelen (`20260925100000_document_purposes.sql`) staat een terugdraaiscript in `supabase/rollback/`. De code van vóór de herinrichting van het beheer staat onder de git-tag `pre-beheer-redesign`.

## Troubleshooting

- **Chat geeft een 503 "Azure OpenAI is niet geconfigureerd"** — controleer `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` en `AZURE_OPENAI_DEPLOYMENT`, en herstart de server.
- **Upload/RAG faalt met een embeddings-fout** — controleer `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`. Bij een 429 (rate limit) probeert de server het opnieuw. Upload minder bestanden tegelijk als het blijft falen.
- **Document levert geen of rare chunks op** — controleer in documentbeheer het aantal chunks. Eén enorme chunk of tekst als `[object Object]` wijst op een extractieprobleem en moet worden onderzocht, niet genegeerd.
- **Geen toegang tot beheer** — controleer je rol (rechtsboven) of vraag een admin om die aan te passen.

Zie ook [GIT_WORKFLOW.md](GIT_WORKFLOW.md) voor de git-werkwijze en [exports/LEAP-VU-korte-manual.md](exports/LEAP-VU-korte-manual.md) voor een korte handleiding.

## Licentie

Ontwikkeld voor educatief gebruik aan de VU Amsterdam.
