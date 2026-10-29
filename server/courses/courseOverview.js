// Cursusoverzicht voor de tutor (2026-10-18).
//
// Aanleiding: in Microbiologie vroeg een student "Waar gaat deze cursus over?
// Ik wil helemaal bij het begin beginnen". Geen enkel hoofdstuk beschrijft "de
// cursus" (beste score 0,32, ook in het Engels maar 0,34), en de tutor kreeg de
// naam en opbouw van de cursus niet mee: hij antwoordde dat hij niet wist welke
// cursus het was.
//
// Nu krijgt de tutorchat altijd een kort overzicht: naam, beschrijving, de
// onderdelen van de leerlijn (of anders de titels van de leerstof) en de
// goedgekeurde begrippen. Daarmee beantwoordt hij oriëntatievragen ("waar gaat
// het over", "waar begin ik", "wat komt er aan bod"). Inhoudelijke uitleg blijft
// op de bronnen gebaseerd: het overzicht is geen bron.

import { orderKeyFromName, titleFromName } from './courseUnits.js';

export const OVERVIEW_MAX_TITLES = 60;
export const OVERVIEW_MAX_CONCEPTS = 60;

const cmpKey = (a, b) => {
  const ka = orderKeyFromName(a) || [];
  const kb = orderKeyFromName(b) || [];
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const x = ka[i] ?? -1; const y = kb[i] ?? -1;
    if (x !== y) return x - y;
  }
  return String(a).localeCompare(String(b));
};

/** Pure: het blok voor de systeeminstructie, of '' als er niets te melden is. */
export function buildCourseOverviewBlock({ course, units = [], documentNames = [], concepts = [] }) {
  if (!course?.name) return '';
  const lines = ['', '', '────────── OVER DEZE CURSUS ──────────', `Cursus: ${course.name}`];
  const desc = String(course.description || '').trim();
  if (desc) lines.push(`Beschrijving: ${desc.slice(0, 800)}`);
  if (units.length) {
    const sorted = [...units].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    lines.push('Opbouw (leerlijn, in volgorde; gelijke nummers staan naast elkaar):');
    for (const u of sorted.slice(0, OVERVIEW_MAX_TITLES)) lines.push(`${u.position}. ${u.title}`);
  } else if (documentNames.length) {
    const sorted = [...documentNames].sort(cmpKey);
    lines.push(`Leerstof (${documentNames.length} bestanden, in volgorde van nummering${sorted.length > OVERVIEW_MAX_TITLES ? `; de eerste ${OVERVIEW_MAX_TITLES}` : ''}):`);
    for (const n of sorted.slice(0, OVERVIEW_MAX_TITLES)) lines.push(`- ${titleFromName(n) || n}`);
  }
  if (concepts.length) {
    lines.push(`Kernbegrippen (${concepts.length}${concepts.length > OVERVIEW_MAX_CONCEPTS ? `, eerste ${OVERVIEW_MAX_CONCEPTS}` : ''}): ${concepts.slice(0, OVERVIEW_MAX_CONCEPTS).join(', ')}`);
  }
  lines.push('Gebruik dit overzicht alleen voor vragen over de cursus zelf: waar de cursus over gaat, hoe hij is opgebouwd, waar je kunt beginnen en wat er aan bod komt. Noem de cursus dan bij naam en stel een concreet beginpunt voor. Voor inhoudelijke uitleg is dit overzicht GEEN bron: daarvoor gelden de passages uit het cursusmateriaal en de regels daarover.');
  return lines.join('\n');
}

/**
 * Loader met cache (5 min per cursus). deps: supabaseAdmin, loadLeerlijn(courseId)
 * → { units }, materialDocuments(courseId) → [{ title, filename }].
 */
export function createCourseOverview({ supabaseAdmin, loadLeerlijn, materialDocuments, ttlMs = 5 * 60 * 1000 }) {
  const cache = new Map();
  return async function courseOverviewBlock(courseId) {
    if (!courseId || !supabaseAdmin) return '';
    const hit = cache.get(courseId);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    try {
      const { data: course } = await supabaseAdmin.from('courses').select('name, description').eq('id', courseId).maybeSingle();
      const [leerlijn, docs, conceptsRes] = await Promise.all([
        loadLeerlijn(courseId).catch(() => ({ units: [] })),
        materialDocuments(courseId).catch(() => []),
        supabaseAdmin.from('concepts').select('name').eq('course_id', courseId).eq('review_status', 'approved').order('name').limit(500),
      ]);
      const value = buildCourseOverviewBlock({
        course,
        units: leerlijn?.units || [],
        documentNames: (docs || []).map((d) => d.title || d.filename).filter(Boolean),
        concepts: (conceptsRes?.data || []).map((c) => c.name).filter(Boolean),
      });
      cache.set(courseId, { at: Date.now(), value });
      return value;
    } catch (err) {
      console.warn('[cursusoverzicht] overgeslagen:', err?.message || err);
      return '';
    }
  };
}
