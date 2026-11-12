// Wat een student van een persona krijgt (besluit 2026-11-12). Hoe een persona
// is ingericht (instructies, kennis, gedragsregels van een rolspeler) is voor
// de docent. Een vaste lijst van wat de projectruimte toont, zodat een nieuwe
// kolom vanzelf bij de docent blijft.

export const STUDENT_PERSONA_FIELDS = ['id', 'name', 'avatar_emoji', 'avatar', 'persona_type', 'sort_order', 'visible_from_phase', 'deliverable_label', 'reputation_enabled', 'max_consultations', 'max_reviews', 'rag_enabled'];

/** Alleen de velden uit STUDENT_PERSONA_FIELDS. Puur. */
export function studentPersonaView(p) {
  return Object.fromEntries(STUDENT_PERSONA_FIELDS.filter((k) => k in p).map((k) => [k, p[k]]));
}
