// Leerdossier om af te drukken of als PDF te bewaren (2026-10-09).
// Bouwt een zelfstandige HTML-pagina uit de export van /api/me/export:
// prestaties, leerniveaus en het leerdagboek. Alle tekst wordt ge-escaped.

type Row = Record<string, unknown>;

export interface DossierLabels {
  title: string;
  exportedOn: string;          // bv. "Gemaakt op {date}"
  achievements: string;
  noAchievements: string;
  levels: string;
  level: string;               // bv. "Niveau {n}"
  journal: string;
  noJournal: string;
  levelNames: Record<number, string>;
  courseUnknown: string;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

export function buildDossierHtml(
  data: { exportedAt: string; user: { email: string | null }; sources: Record<string, Row[]> },
  labels: DossierLabels,
  { locale = 'nl-NL', courseNames = {} as Record<string, string> } = {},
): string {
  const date = (iso: unknown) => {
    try { return new Date(String(iso)).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return ''; }
  };
  const course = (id: unknown) => (id && courseNames[String(id)]) || (id ? labels.courseUnknown : '');
  const s = data.sources || {};
  const profile = (s.profiles || [])[0] || {};
  const name = (profile.full_name as string) || data.user.email || '';

  const achievements = [...(s.student_achievements || [])].sort((a, b) => String(b.earned_at).localeCompare(String(a.earned_at)));
  const levels = s.student_course_levels || [];
  const journal = [...(s.learning_journal_entries || [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const achHtml = achievements.length
    ? `<ul>${achievements.map(a => `<li><strong>${escapeHtml(a.topic_label || a.topic_key || a.kind)}</strong>${a.level ? ` · ${escapeHtml(labels.levelNames[Number(a.level)] || fill(labels.level, { n: String(a.level) }))}` : ''} <span class="muted">${escapeHtml(date(a.earned_at))}${a.course_id ? ` · ${escapeHtml(course(a.course_id))}` : ''}</span></li>`).join('')}</ul>`
    : `<p class="muted">${escapeHtml(labels.noAchievements)}</p>`;
  const levelHtml = levels.length
    ? `<ul>${levels.map(l => `<li>${escapeHtml(course(l.course_id))}: ${escapeHtml(labels.levelNames[Number(l.level)] || fill(labels.level, { n: String(l.level) }))}</li>`).join('')}</ul>`
    : '';
  const journalHtml = journal.length
    ? journal.map(j => `<article><h3>${escapeHtml(j.title || '')}</h3><p class="muted">${escapeHtml(date(j.created_at))}${j.course_id ? ` · ${escapeHtml(course(j.course_id))}` : ''}</p><div class="body">${escapeHtml(j.content || '')}</div></article>`).join('')
    : `<p class="muted">${escapeHtml(labels.noJournal)}</p>`;

  return `<!doctype html><html lang="${escapeHtml(locale.slice(0, 2))}"><head><meta charset="utf-8"><title>${escapeHtml(labels.title)} – ${escapeHtml(name)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:black;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
h1{margin-bottom:.2rem}h2{margin-top:2rem;border-bottom:1px solid lightgray;padding-bottom:.3rem}h3{margin:1.2rem 0 .1rem}
.muted{color:dimgray;font-size:.9em}.body{white-space:pre-wrap}article{break-inside:avoid}
@media print{body{margin:0}}
</style></head><body>
<h1>${escapeHtml(labels.title)}</h1>
<p class="muted">${escapeHtml(name)} · ${escapeHtml(fill(labels.exportedOn, { date: date(data.exportedAt) }))}</p>
<h2>${escapeHtml(labels.achievements)}</h2>${achHtml}
${levelHtml ? `<h2>${escapeHtml(labels.levels)}</h2>${levelHtml}` : ''}
<h2>${escapeHtml(labels.journal)}</h2>${journalHtml}
</body></html>`;
}
