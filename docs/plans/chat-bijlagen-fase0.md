# Bijlagen in de chat: resultaten fase 0 (16 oktober 2026)

Hoort bij `docs/plans/chat-bijlagen-plan.html`. Gemeten met
`node --env-file=.env scripts/eval-chat-attachments.mjs <uitvoermap> [map]`
tegen het live model (deployment `gpt-5.5`, api-version `2024-10-21`).

## Werkt het?

Ja. Het model accepteert afbeeldingen als `image_url` met een data-URL, zonder
andere API-versie of instelling.

## Kwaliteit

| Soort afbeelding | Lage stand | Hoge stand |
|---|---|---|
| Staafdiagram met getallen | alles juist | alles juist |
| Lijngrafiek, twee reeksen | trend juist, tussentijdse dip gemist | ook de dip juist |
| Tabel | alles juist | alles juist |
| Formule (KaTeX) | foutloos overgenomen | foutloos overgenomen |
| Stroomschema | juist, inclusief terugloop | juist |
| Alinea dichte tekst | juist | juist |
| Code | foutloos overgenomen | foutloos overgenomen |
| Klein en onscherp | eerlijk: "geen getallen leesbaar" | idem |
| Volle pagina kleine tekst (832x1178) | **verzint inhoud** (termen en opsommingen die er niet staan) | juist, met eerlijke kanttekening over kleine details |
| Schermvullende screenshot (1024x559) | juist | juist |

Het model begint netjes met "Dit zie ik:", zegt wat het niet kan lezen en
vraagt daarna wat de student zelf denkt.

**Besluit:** de hoge stand is de standaard. De lage stand verzint bij een volle
pagina tekst inhoud, en dat is precies wat LEAP niet wil. De beheerder kan de
lage stand kiezen om kosten te sparen, met die waarschuwing erbij.

## Kosten en duur

| | Prompt-tokens per afbeelding | Duur |
|---|---|---|
| Lage stand | 200–380 | 2–7 s |
| Hoge stand | 800–1.100 | 2–5 s |

Ter vergelijking: een gewone chatbeurt stuurt al cursusfragmenten mee (enkele
duizenden tokens). Omdat een afbeelding één keer beschreven wordt en daarna
alleen als tekst meegaat, kost een afbeelding in de hoge stand ongeveer een
derde van één gewone chatbeurt extra.

Bestand (PDF, 22 pagina's, 40.000 tekens meegestuurd): ongeveer 9.700
prompt-tokens per beurt. Bij herhaling kwam 98% uit de cache van Azure
(`cached_tokens` 9.472 van 9.684). Cache-tokens zijn goedkoper, maar een
bestand blijft bij elke beurt het duurste deel van het gesprek. Daarom blijft
de grens van 40.000 tekens staan en telt Analyse bestanden apart.

## Grenzen (startwaarden)

Zoals in het plan: 3 afbeeldingen per bericht, 10 bijlagen per gesprek, 20 per
student per dag per cursus, langste zijde 1600 px, bestanden tot 10 MB, 40.000
tekens tekst, 5 pagina's van een gescande PDF.

## Uitvoering (16 oktober 2026)

Gebouwd volgens het plan, op de branch `feature/chat-bijlagen` (terugvalpunt: tag
`pre-chat-bijlagen-2026-10-16`; database: `supabase/rollback/20261016100000_chat_attachments_down.sql`,
momentopname `db-backups/2026-10-16-09-17-16-chat-bijlagen`). Afwijkingen en keuzes:

- Een toelichting van de student is verplicht bij een bijlage (versturen kan pas met tekst).
  Dat past bij "met toelichting van de student", en zo telt alleen getypte tekst als eigen
  inbreng voor "Klaar voor een hoger niveau?".
- Geen aparte knop "kijk nog eens": wil de student dat de tutor opnieuw kijkt, dan plakt hij
  de afbeelding nog een keer.
- Zoeken in het cursusmateriaal: de beurt mét afbeelding zoekt op de toelichting; de beurt
  erna ook op de beschrijving die de tutor gaf. Bij een bestand ook op het begin van de tekst.
- De daggrens wordt in het geheugen van de server bijgehouden (LEAP draait als één replica).
- Gecontroleerd: 25 servertests, 14 browsertests, `scripts/check-chat-attachments.mjs`
  (12/12 tegen de API) en `scripts/check-chat-attachments-ui.mjs` (12/12 in Edge). Het
  testaccount is beheerder; dat een student zonder cursusschakelaar wordt geweigerd, is met
  de unittests gedekt.
