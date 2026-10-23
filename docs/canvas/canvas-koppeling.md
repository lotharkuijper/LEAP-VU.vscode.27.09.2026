# LEAP koppelen aan Canvas (LTI 1.3)

Voor de Canvas-beheerders van de VU en de beheerder van LEAP. Eenmalig per Canvas-omgeving.

## Wat het doet

Een docent zet in zijn Canvas-cursus een link naar zijn LEAP-cursus (Beheer → Cursussen beheren → **Canvas-link**). Een student of docent klikt erop en staat met één klik in die LEAP-cursus, zonder wachtwoord. LEAP maakt zo nodig het account aan. Wie in Canvas docent is, wordt docent in de LEAP-cursus.

LEAP vraagt alleen: een vast Canvas-id van de gebruiker, naam, e-mailadres, rol en cursus (id en naam). Geen cijfers, geen andere gegevens.

## Stap 1: LEAP-beheerder

1. Maak de sleutel van LEAP: `node scripts/lti-keygen.mjs`.
2. Zet de uitvoer in Key Vault als `LTI_TOOL_PRIVATE_JWK` (geheim).
3. Geef de Canvas-beheerders het adres van de configuratie: `https://leap.vu-edulab.nl/lti/config.json`.

## Stap 2: Canvas-beheerders

1. Admin → Developer Keys → **+ LTI Key** → Method: **Enter URL** → `https://leap.vu-edulab.nl/lti/config.json`.
2. Controleer: Privacy Level **Public** (anders stuurt Canvas geen e-mailadres en kan LEAP geen account maken). Placements: *Link Selection* (en eventueel *Course Navigation*), openen in een nieuw venster.
3. Zet de key **On** en installeer de tool in het account (Settings → Apps → + App → By Client ID).
4. Geef de LEAP-beheerder de **Client ID** en de **Deployment ID**.

## Stap 3: LEAP-beheerder

Zet in de instellingen van de app (Key Vault / containerinstellingen):

```
LTI_PLATFORMS=[{"issuer":"https://canvas.instructure.com","clientId":"<Client ID>","deploymentIds":["<Deployment ID>"],"authUrl":"https://sso.canvaslms.com/api/lti/authorize_redirect","jwksUrl":"https://sso.canvaslms.com/api/lti/security/jwks"}]
```

Controleer de adressen (`issuer`, `authUrl`, `jwksUrl`) met de Canvas-beheerders: bij een eigen of test-omgeving kunnen ze afwijken. Na een herstart meldt de serverlog `[lti] Canvas-koppeling actief`.

## Per cursus

1. De LEAP-beheerder zet de toegangsroute van de cursus op **Canvas** (of Canvas + open).
2. De docent kopieert de **Canvas-link** en zet die in Canvas als module-item → Externe tool → LEAP, met "In een nieuw tabblad laden".

## Daarna

Studenten die zo binnenkwamen, kunnen ook rechtstreeks naar LEAP: op de inlogpagina "Via Canvas in LEAP gekomen? Log in met een code per e-mail". Ze krijgen een eenmalige code en blijven daarna op dat apparaat ingelogd.

## Testen zonder Canvas

De koppeling is getest met een nagebootste Canvas-omgeving (eigen sleutel, zelfde berichten). De servertests staan in `server/__tests__/lti.test.js`.
