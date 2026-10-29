---
paths:
  - "server/system/systemMessages.js"
  - "src/lib/systemMessages.ts"
  - "src/components/SystemMessages.tsx"
  - "src/pages/admin/SystemMessagesAdminTab.tsx"
  - "src/pages/DashboardPage.tsx"
  - "src/components/Layout.tsx"
---

# System messages (2026-10-16)

- The admin sends one-way messages (Beheer → Berichten, admin only) to all users, all students (profile role student), all teachers (profile role docent), or one course (students only, or everyone in it). Optional start and end time; kind info or warning. Code: `server/system/systemMessages.js` (one `registerSystemMessageRoutes` call in `server/system/routes.js`), migration `20261016120000_system_messages` (+ rollback).
- Messages show at the top of the Dashboard until dismissed; while one is open, "Dashboard" in the menu shows a red exclamation mark (not on the Dashboard itself). One shared store, `src/lib/systemMessages.ts`, polls every 2 minutes and on tab focus (no Realtime on Azure). Text is translated on display (`useContentTranslation`), not in the admin preview.
- Privacy: only the fact that a user dismissed a message is stored (`system_message_dismissals`, in My data export); the admin sees totals only (recipients, dismissed), never names.
