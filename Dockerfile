# LEAP-VU — container voor hosting (bv. binnen het VU-domein).
#
# Eén container met de Express-server (server/index.js) die ook de gebouwde
# frontend (dist/) serveert. LibreOffice zit IN de container: de server zet
# Word/PowerPoint-bronnen bij het uploaden om naar pdf (weergaveversie +
# paginanummers). Gebruikers hebben alleen een browser nodig.
#
# Bouwen (de twee VITE_-waarden komen in de frontend-bundel; dat zijn de
# publieke Supabase-URL en de anon-key, geen geheimen):
#   docker build \
#     --build-arg VITE_PUBLIC_SUPABASE_URL=https://<project>.supabase.co \
#     --build-arg VITE_PUBLIC_SUPABASE_ANON_KEY=<anon-key> \
#     -t leap-vu .
# Starten (geheimen alleen als runtime-omgeving, nooit in de image):
#   docker run -p 3001:3001 --env-file .env leap-vu
# Zie README → "Hosting" voor de benodigde omgevingsvariabelen.

# ── 1. Frontend bouwen ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_PUBLIC_SUPABASE_URL
ARG VITE_PUBLIC_SUPABASE_ANON_KEY
# "off" waar Supabase Realtime niet draait (Azure): de app ververst dan periodiek.
ARG VITE_PUBLIC_REALTIME
ENV VITE_PUBLIC_SUPABASE_URL=$VITE_PUBLIC_SUPABASE_URL \
    VITE_PUBLIC_SUPABASE_ANON_KEY=$VITE_PUBLIC_SUPABASE_ANON_KEY \
    VITE_PUBLIC_REALTIME=$VITE_PUBLIC_REALTIME
RUN npm run build

# ── 2. Runtime: Node + LibreOffice (zonder grafische schil) ──────────────────
FROM node:22-bookworm-slim
# LibreOffice headless voor docx/pptx → pdf. Carlito/Caladea zijn
# maat-compatibel met Calibri/Cambria: zonder die lettertypen verschuift de
# paginering van Word-documenten en klopt "naar de juiste pagina" niet.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-impress-nogui \
      fonts-liberation fonts-dejavu fonts-crosextra-carlito fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3001 \
    SOFFICE_BIN=soffice \
    HOME=/tmp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY scripts ./scripts
# Migraties: scripts/migrate.mjs voert nieuwe uit bij het starten (MIGRATE_ON_START).
COPY supabase/migrations ./supabase/migrations
# De server leest de vertalingen voor e-mails uit de frontend-bestanden.
COPY src/i18n/locales ./src/i18n/locales
COPY --from=build /app/dist ./dist
# Niet als root draaien.
USER node
EXPOSE 3001
CMD ["sh", "-c", "node scripts/migrate.mjs --on-start && exec node server/index.js"]
