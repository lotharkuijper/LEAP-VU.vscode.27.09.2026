# LEAP-VU: korte manual op basis van de code

Deze korte handleiding is gebaseerd op hoe de code in de repo nu is opgebouwd. Het is geen officiële productdocumentatie, maar wel een praktische interpretatie van de architectuur en de belangrijkste flow.

## 1) Wat is dit voor app?

De app is een educatieve webomgeving voor studenten van epidemiologie en biostatistiek, met:

- chat met AI
- RAG (retrieval-augmented generation) over cursusdocumenten
- "Ik leg uit"-module voor begrippen
- quiz / ShareStats-integratie
- admin-functionaliteit voor docenten/admins
- zaak met cursussen, rolbeheer en toegang

De code suggereert dat het geen puur frontend-demo is: het is een full-stack app met React in de frontend, Express in de backend en Supabase als centrale datastore.

## 2) De kernarchitectuur

### Frontend

Belangrijkste entrypoints:

- [src/App.tsx](../src/App.tsx): router, route guards, providers
- [src/main.tsx](../src/main.tsx): bootstraps React app
- [src/contexts/AuthContext.tsx](../src/contexts/AuthContext.tsx): login, session, profiel, rollen
- [src/pages/ChatPage.tsx](../src/pages/ChatPage.tsx): de chatbot UI en het RAG-gedrag

Er is een React-router routing structuur, met routes zoals:

- /login
- /dashboard
- /chat
- /explain
- /quiz
- /admin
- /studiecafe
- /choose-course

De app wrapt alles in providers:

- LanguageProvider
- AuthProvider
- CourseAccessProvider
- ActiveCourseProvider

De route-guards zorgen ervoor dat niet-ingelogde gebruikers naar /login gaan en dat een student die geen actieve cursus meer heeft terug wordt gestuurd naar /choose-course.

### Backend API

Belangrijkste backend:

- [server/index.js](../server/index.js): centrale Express-server en vrijwel alle API-endpoints

Deze server draait apart van de Vite-frontend en luistert meestal op poort 3001.

### Database / auth

Belangrijkste suite:

- [src/lib/supabase.ts](../src/lib/supabase.ts): Supabase client voor browser
- [server/index.js](../server/index.js): service-role client via SUPABASE_SERVICE_ROLE_KEY

Supabase wordt gebruikt voor:

- authenticatie
- gebruikersprofielen
- rollen (student/docent/admin)
- documenten en chunks
- conversations en messages
- course memberships
- course access / document permissions

## 3) Hoe de login en rollen werken

De login-flow is in [src/contexts/AuthContext.tsx](../src/contexts/AuthContext.tsx):

1. Supabase haalt de sessie op.
2. De app valideert de sessie met getUser().
3. Als de sessie ongeldig is, logt het automatisch uit.
4. Het profiel van de gebruiker wordt geladen.
5. De UI bepaalt rollen op basis van de profile row.

Er is een speciaal superuser mechanisme:

- het e-mailadres l.d.j.kuijper@vu.nl krijgt automatisch admin-status
- de code roept Edge Function / RPC aan om die status af te dwingen

De route-guards in [src/App.tsx](../src/App.tsx) controleren of een user is ingelogd voordat een pagina wordt geopend.

## 4) Hoe een chat-gesprek werkt

De gebruiker spreekt met de chatbot via [src/pages/ChatPage.tsx](../src/pages/ChatPage.tsx).

De frontend stuurt een request naar:

- /api/chat

via de service [src/services/llm.service.ts](../src/services/llm.service.ts).

Dat is de algemene flow:

1. De UI bouwt een lijst van messages.
2. De frontend post deze naar /api/chat.
3. De Express server ontvangt het request.
4. De server haalt relevante document-chunks op uit de vector database (RAG).
5. De server bouwt een prompt met cursuscontext.
6. De server roept Azure OpenAI aan.
7. De response wordt teruggestuurd naar de React UI.
8. De UI toont de assistant reply plus de opgehaalde bronnen.

Belangrijk:

- de backend verwerkt de echte LLM-call, niet de browser
- het request bevat ook Authorization: Bearer token voor auth
- de app gebruikt Azure OpenAI in plaats van een losse OpenAI-browser key

## 5) Hoe RAG werkt

RAG is een grote kern van de app.

In [server/index.js](../server/index.js) zie je dat de server:

- zoekt naar document chunks met vector similarity
- past match_count, similarity_threshold en rag_strict_mode toe
- verzamelt relevante bronnen
- bouwt een context-block die in de prompt gaat

Typische variabelen in de app:

- similarity_threshold
- match_count
- rag_strict_mode

Deze worden per module gebruikt:

- chat
- explain
- quiz
- project

De code doet dus niet alleen een losse LLM-call: het gebruikt eerst een info-retrieval stap op basis van het cursusmateriaal. De chatbot is daardoor veel meer "context-aware" dan een simpele chat-interface.

## 6) Hoe de "Ik leg uit"-module werkt

De app heeft een module voor begrippenuitleg, waarschijnlijk gebaseerd op concepten en student explanations.

De code verwijst naar concept- en explanation-data in de database, met tabellen als:

- concepts
- student_explanations

De server heeft helper-logica rond concept-extraction en concept-evidence, en de admin heeft routes voor begrippen, document-uploads en verwerking. De interface is waarschijnlijk bedoeld om een student een concept te laten uitleggen en door een AI-model te laten beoordelen.

## 7) Hoe documenten en inhoud worden verwerkt

Er is een grote document pipeline in de backend:

- upload document
- detecteer type (PDF, PPTX, DOCX, plain text)
- extract text
- split into chunks
- generate embeddings
- store chunks en metadata in Supabase

Dit is cruciaal voor RAG. De repo bevat veel modules zoals:

- [server/ragProcessing.js](../server/ragProcessing.js)
- [server/documentRender.js](../server/documentRender.js)
- [server/chunking.js](../server/chunking.js)
- [server/pptxExtract.js](../server/pptxExtract.js)
- [server/pdfPages.js](../server/pdfPageText.js)

Dus: documenten worden niet alleen opgeslagen, maar ook geindexeerd om later te kunnen zoeken.

## 8) Hoe deze app in de praktijk wordt gebruikt

### Voor een student

- inloggen via Supabase auth
- kiezen van een cursus
- binnen de cursus: chat, begrippen uitleggen, quiz, resources, feedback
- de AI gebruikt de documentcontext van die cursus

### Voor een docent / admin

- uploaden van documenten
- beheren van folders / assignments / cursusbronnen
- beoordelen van concept- en uitlegresultaten
- toegangscijfers, rollen, toegangscapaciteit controleren

### Voor de admin

- user-rollen aanpassen
- volledige toegang over document pools en cursus-opstellingen
- controle over document- and RAG-configuratie

## 9) De belangrijkste dataflow in één zin

De app werkt in grote lijnen zo:

User -> React UI -> Supabase Auth + profiles -> Express API -> vector search over document_chunks -> Azure OpenAI -> antwoord terug naar de UI.

## 10) Hoe je hier mee kunt experimenteren

### Stap 1: lokaal draaien

```bash
npm install
npm run dev
```

Dit start waarschijnlijk zowel de Express backend als de Vite-frontend.

### Stap 2: check de environment

Zorg dat in .env de juiste variabelen staan, waaronder typisch:

- VITE_PUBLIC_SUPABASE_URL
- VITE_PUBLIC_SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- Azure OpenAI-configuratie voor chat en embeddings

### Stap 3: begin met de juiste bestanden

Als je de app wilt begrijpen, begin hier:

1. [src/App.tsx](../src/App.tsx)
2. [src/contexts/AuthContext.tsx](../src/contexts/AuthContext.tsx)
3. [src/pages/ChatPage.tsx](../src/pages/ChatPage.tsx)
4. [src/services/llm.service.ts](../src/services/llm.service.ts)
5. [server/index.js](../server/index.js)
6. [server/ragProcessing.js](../server/ragProcessing.js)

### Stap 4: experimenteer met één flow

Probeer één van de volgende zaken:

- login en role-flow
- het /api/chat request in de browser DevTools
- een document uploaden en daarna vector retrieval testen
- de "Ik leg uit"-module volgen

## 11) Mijn interpretatie van de app

Mijn eerste indruk: dit is geen simpele chatbot-demo, maar een op onderwijs gericht AI-platform met:

- authenticatie en autorisatie
- cursuscontext
- document-indexering
- prompt-engineering
- AI-assisted learning tasks
- docent/admin tooling

Op architectuur-niveau is het een goed voorbeeld van een "full-stack educational LLM application":

- frontend = React + TypeScript
- auth/data = Supabase
- AI + RAG = Express + Azure OpenAI
- storage = Supabase Storage + Postgres vector tables

## 12) Wat ik als volgende stap zou doen

Als je wilt experimenteren, zou ik het volgende aanraden:

1. start de app lokaal
2. log in als student en bekijk de route flow
3. open DevTools en volg een chat request naar /api/chat
4. upload een document en controleer of de chunks in de database verschijnen
5. inspect vervolgens de AI prompt en het RAG-contextblok in de backend

Als je wilt, kan ik hierna ook een tweede, meer technische versie maken met:

- een request/response diagram
- een overzicht van de belangrijkste database tabellen
- een checklist van de env-variabelen die je nodig hebt
- een "hoe te debuggen in deze app"-handleiding
