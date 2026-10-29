---
paths:
  - "src/lib/backgroundTasks.ts"
  - "src/components/TaskTray.tsx"
  - "src/lib/conceptExtractionJob.ts"
  - "src/components/{WebImportPanel,ShareStatsImportPanel,ImportsHubPanel,DocumentManagement,DatasetManagement}.tsx"
  - "src/components/concepts/**"
  - "src/components/material/**"
  - "src/pages/admin/**"
---

# Background tasks

- Admin actions that take longer than a few seconds run as a background task via `startTask` (`src/lib/backgroundTasks.ts`), not only inside the component. Examples: extracting concepts, uploading files, importing or updating websites, and ShareStats imports.
- A task keeps running when the user moves to another part of the app. The task tray (`TaskTray`, `src/components/TaskTray.tsx`, bottom right) shows progress and a "… is done — View result" notice with a link back.
- Work that runs on the server gets `where: 'server'` and a resumer, so it also survives a page reload. Work the browser does itself gets `where: 'browser'`, and the app warns before the tab is closed.
- Report progress as `{ done, total, labelKey }`. Components read a task that is still running through `useTask(kind, key)`, so they show its progress again when the user comes back.
- Server-side job state lives in process memory (e.g. `conceptJobs`); see `azure-hosting.md` (single replica).
