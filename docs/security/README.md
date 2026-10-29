# Beveiliging van LEAP

Dit document beschrijft hoe LEAP beveiligd is, wat er in de beveiligingsronde
van oktober 2026 is aangepast, en hoe je veilig verder werkt. Het is bedoeld
voor de beheerder van LEAP en voor Claude Code.

> Deze repository is openbaar. Schrijf hier (en in issues, PR's en commits)
> nooit details over een lek dat nog niet is opgelost. Open punten staan in
> een niet-openbaar overzicht bij de beheerders.

## Het beveiligingsmodel in het kort

| Laag | Wat het doet | Waar |
|---|---|---|
| Inloggen | Supabase Auth (GoTrue) op Azure; de server controleert elk verzoek met `requireAuthUser` / `authUser` (met korte cache) | `server/lib/auth.js` |
| Toegang tot een cursus | lidmaatschap (`course_members`) of docent van de cursus; beheerders zien alles | `userHasCourseAccess`, `isStaffForCourse` in `server/lib/auth.js` |
| Groepsinhoud (projecten) | alleen groepsleden en LEAP-beheerders, nooit "docent van de cursus" | `isLeapAdmin` + `isGroupMember`; `server/__tests__/teacherPrivacy.test.js` |
| Database | Row Level Security op elke tabel; de browser schrijft alleen wat de regels toestaan, de rest gaat via de server (service role) | `supabase/migrations/` |
| Geheimen | alleen in Azure Key Vault (`kv-vu-leap`); lokaal in `.env` (nooit in git) | `.gitignore`, `azure/README.md` |
| HTTP | CORS alleen voor het eigen adres, één vertrouwde proxy (Azure-ingress), veilige standaardheaders | `server/lib/httpSecurity.js` |
| Canvas (LTI 1.3) | ondertekende berichten, eenmalige state + nonce, alleen cursusrollen tellen, koppelen op e-mail alleen aan een bevestigd inlogadres | `server/lti/lti.js` |
| AI-kosten | tokenbudget voor open accounts, limieten per route | `server/account/tokenBudget.js` |

## Aangepast in de beveiligingsronde (oktober 2026)

- **Database**: de browser kan geen projectgroepen of groepslidmaatschappen
  meer zelf aanmaken of wijzigen (de server doet dat met alle controles);
  projectdocumenten zijn alleen zichtbaar voor beheerders, docenten van die
  cursus en groepsleden (zonder verborgen documenten en rubric); het
  e-mailadres in `profiles` kan alleen een beheerder of de server wijzigen.
  Migratie `20261030100000_security_hardening.sql` + rollback, getest met
  `scripts/local-db/tests/security-hardening.sql`.
- **Canvas**: alleen rollen in de cursus zelf geven docentrechten (geen
  instellingsrollen); koppelen op e-mail alleen aan een account met hetzelfde,
  bevestigde inlogadres; een Canvas-docent krijgt ook het docentprofiel; het
  state-cookie werkt ook in een Canvas-iframe (Chrome, Edge, Firefox).
- **Privacy**: een docent komt via de server niet in een groep met
  studenten (aansluiten of indelen), en groepsbeheer geeft geen
  uitnodigingscodes meer terug. Codes komen uit een cryptografische bron.
- **Server**: `/api/embeddings` vereist inloggen en heeft limieten; de chat
  begrenst `max_tokens` en accepteert uit de browser alleen gespreksbeurten;
  snelheidslimieten gebruiken het echte IP-adres.
- **Afhankelijkheden**: pdf.js (kritiek lek bij het openen van een pdf),
  officeparser, multer, undici, react-router en andere bijgewerkt.
- **Repository**: geplakte schermafdrukken en teksten (`attached_assets/`) en
  resten van Replit verwijderd; `.gitignore` sluit meer geheime bestanden uit.

## Veilig verder werken

- **Elke wijziging aan inloggen, routes, databaseregels, uploads, Canvas,
  externe adressen of geheimen**: volg de skill `.claude/skills/secure-change`
  en laat de agent `security-reviewer` meekijken voordat het naar `main` gaat.
- **Nieuwe of gewijzigde databaseregels**: altijd een migratie mét rollback,
  en eerst testen op de lokale testdatabase (`npm run db:local`,
  `scripts/local-db/test.sh`). Nooit rechtstreeks in de productiedatabase.
- **Een push naar `main` zet de app live** (inclusief migraties). Werk op een
  branch en open een pull request; laat beveiligingsgevoelige wijzigingen door
  een tweede persoon bekijken.
- **Geheimen**: nooit in code, chat, e-mail of commit. Is een geheim toch
  gedeeld, vervang het dan (roteren) in Key Vault.
- **Afhankelijkheden**: draai af en toe `npm audit --omit=dev` en werk hoge en
  kritieke meldingen bij; test daarna de documentviewer en het inlezen.

## Bronnen

- OWASP Top 10 (2025): https://owasp.org/Top10/2025/
- OWASP ASVS 5.0: https://owasp.org/www-project-application-security-verification-standard/
- OWASP API Security Top 10: https://owasp.org/API-Security/
- Supabase Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- 1EdTech Security Framework / LTI 1.3: https://www.imsglobal.org/spec/security/v1p0/
- Microsoft: Container Apps, Key Vault en Postgres beveiligen: https://learn.microsoft.com/azure/container-apps/managed-identity, https://learn.microsoft.com/azure/key-vault/general/rbac-access-policy
