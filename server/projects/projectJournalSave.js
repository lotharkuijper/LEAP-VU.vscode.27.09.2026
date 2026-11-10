// Project → leerdagboek op verzoek van de student (2026-10-27). Pure helpers.
//
// Tussenstanden, de eindreflectie, feedback van een beoordelaar en "Beoordeling
// opvragen" staan bij de groep (projectruimte). Elk groepslid bewaart zelf wat
// het in het EIGEN leerdagboek wil ("Bewaar in mijn leerdagboek"). Eén
// source_ref per onderdeel en gebruiker: twee keer bewaren geeft geen dubbele
// regel (unieke index op user_id + source_ref). Regels die vóór 2026-10-27
// automatisch in het dagboek kwamen, hebben een oudere source_ref; die tellen
// ook als "al bewaard".

export const SAVE_SOURCES = ['checkpoint', 'assessment', 'review'];
export const NOTE_MAX_CHARS = 4000;

const EMPTY_SECTIONS = { summary: '', went_well: [], to_improve: [], next_steps: [] };

/** Onderdelen van een tussenstand; oude tussenstanden hebben alleen samenvatting/reflectie. */
export function checkpointItems(cp, { lang = 'nl', projectTitle = '' } = {}) {
  if (Array.isArray(cp?.journal_items) && cp.journal_items.length) return cp.journal_items;
  const content = String(cp?.ai_summary || cp?.reflection || '').trim();
  if (!content) return [];
  const label = cp?.kind === 'final'
    ? (lang === 'nl' ? 'Eindreflectie' : 'Final reflection')
    : (lang === 'nl' ? 'Projectreflectie' : 'Project reflection');
  return [{ key: 'main', title: projectTitle ? `${label}: ${projectTitle}` : label, content, sections: null }];
}

/** De source_refs die gelden als "dit onderdeel staat al in het dagboek" (nieuw eerst, daarna oud). */
export function checkpointItemRefs(cp, item) {
  const refs = [`group_checkpoint:${cp.id}:${item.key}`];
  if (item.key === 'main') refs.push(`group_checkpoint:${cp.id}`);
  else if (item.key === 'synthesis') refs.push(`group_checkpoint_synthesis:${cp.id}`);
  else if (String(item.key).startsWith('thread:')) refs.push(`group_thread_checkpoint:${cp.id}:${String(item.key).slice(7)}`);
  return refs;
}

export function assessmentRefs(a) {
  const refs = [`group_assessment:${a.id}`];
  if (a.request_id) refs.push(`group_evaluate:${a.group_id}:${a.persona_id}:${a.request_id}`);
  return refs;
}

export function reviewRefs(r) {
  return [`document_review:${r.id}`, `document_review:${r.document_id || r.product_id}:${r.persona_id}:${r.id}`];
}

export const isSaved = (refs, savedSet) => refs.some((ref) => savedSet.has(ref));

/** Dagboektekst bij feedback van een beoordelaar: zuiver formatief, zonder cijfer of oordeel (2026-11-10). */
export function formativeJournalEntry({ personaName = '', emoji = '', title = '', feedback = '', feedForward = '' } = {}) {
  const head = [personaName, title ? `"${title}"` : ''].filter(Boolean).join(' over ');
  const parts = [`Feedback: ${feedback}`];
  if (feedForward) parts.push(`Volgende stap: ${feedForward}`);
  return {
    title: `${emoji || '🧑‍⚖️'} Feedback${head ? ` — ${head}` : ''}`,
    content: parts.join('\n\n'),
    sections: { ...EMPTY_SECTIONS, feedback, next_steps: feedForward ? [feedForward] : [] },
    formative: true,
  };
}

/**
 * Dagboekregel voor feedback van een beoordelaar. Feedback van vóór 2026-11-10
 * had een cijfer, oordeel en soms een badge in de opgeslagen tekst; die bouwen
 * we opnieuw op uit de feedback zelf, zodat er nergens meer een cijfer staat.
 */
export function reviewEntry(r) {
  const je = r.journal_entry;
  if (je && je.formative && je.title) {
    return { title: je.title, content: je.content, sections: je.sections || null };
  }
  const { title, content, sections } = formativeJournalEntry({ feedback: r.reasoning || '', feedForward: r.feed_forward || '' });
  return { title, content, sections };
}

/** Eigen reflectie van de student bij een tussenstand of de eindreflectie. */
export function noteEntry(note, { lang = 'nl', projectTitle = '' } = {}) {
  const text = String(note || '').replace(/\r\n/g, '\n').trim().slice(0, NOTE_MAX_CHARS);
  if (!text) return null;
  const label = lang === 'nl' ? 'Mijn eigen reflectie' : 'My own reflection';
  return {
    title: projectTitle ? `${label}: ${projectTitle}` : label,
    content: text,
    sections: { ...EMPTY_SECTIONS, summary: text },
  };
}
