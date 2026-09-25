// Bestandsdoelen (herinrichting docentenbeheer, 2026-09-25) — PURE helpers,
// gedeeld door server en client (src importeert dit bestand rechtstreeks), zodat
// het voorstel bij uploaden en bij de eenmalige controle identiek is.
//
// Doelen:
//   course_material  Leerstof — RAG voor chat, Ik leg uit en quiz; bron voor begrippen
//   course_info      Cursusinformatie — alleen chat (praktische vragen); geen begrippen/quiz
//   project          Projectmateriaal — hoort bij één project (project_documents)
//   shared           Alleen delen — download voor studenten, geen AI
//   teacher_only     Alleen voor docenten — nooit AI, nooit zichtbaar voor studenten
//
// In de database: documents.purpose bevat course_material/course_info/shared/
// teacher_only; projectmateriaal leeft in project_documents (met material_kind).

export const PURPOSES = ['course_material', 'course_info', 'project', 'shared', 'teacher_only'];
export const DOCUMENT_PURPOSES = ['course_material', 'course_info', 'shared', 'teacher_only'];
export const MATERIAL_KINDS = ['assignment', 'data', 'literature', 'other'];

/** Wat een doel betekent — één bron van waarheid voor server-logica en UI-uitleg. */
export const PURPOSE_RULES = {
  course_material: { rag: true, chat: true, explain: true, quiz: true, concepts: true, studentVisible: true },
  course_info: { rag: true, chat: true, explain: false, quiz: false, concepts: false, studentVisible: true },
  project: { rag: false, chat: false, explain: false, quiz: false, concepts: false, studentVisible: true },
  shared: { rag: false, chat: false, explain: false, quiz: false, concepts: false, studentVisible: true },
  teacher_only: { rag: false, chat: false, explain: false, quiz: false, concepts: false, studentVisible: false },
};

/** Doelen waarvan de bytes in de RAG-opslag moeten staan en die worden verwerkt tot tekstfragmenten. */
export const isRagPurpose = (p) => p === 'course_material' || p === 'course_info';

/**
 * Mag een document met dit (effectieve) doel meedoen in RAG voor deze module?
 * module: 'general' (chat) | 'explain' | 'quiz' | 'project' | 'concepts'.
 * Een onbekend/leeg doel = oud gedrag: alles in de RAG-map is leerstof.
 */
export function purposeAllowsModule(purpose, module) {
  const p = purpose || 'course_material';
  const rules = PURPOSE_RULES[p];
  if (!rules) return false;
  if (module === 'general' || module === 'chat') return rules.chat;
  if (module === 'explain') return rules.explain;
  if (module === 'quiz') return rules.quiz;
  if (module === 'concepts') return rules.concepts;
  if (module === 'project') return rules.rag;
  return false;
}

const DATA_EXT = new Set(['csv', 'xlsx', 'xls', 'sav', 'omv', 'omt', 'jasp', 'rdata', 'rds', 'sps', 'do', 'dta', 'json', 'zip', 'tsv']);
const TEXT_EXT = new Set(['pdf', 'docx', 'doc', 'pptx', 'ppt', 'txt', 'md', 'web']);

// Naampatronen (NL + EN). Volgorde = prioriteit: veiligheid eerst.
const TEACHER_ONLY_RE = /(antwoord(en|model|sleutel)?|uitwerking(en)?|nakijk|beoordelingsmodel|correctiemodel|answer(s|\s?key)?|solution(s)?|tentamen|exam(en)?\b|toetsvragen|proeftentamen.*antwoord|docentenhandleiding|teacher'?s?\s?(guide|notes))/i;
const COURSE_INFO_RE = /(studiehandleiding|studiegids|cursushandleiding|handleiding|course\s?(guide|manual|information)|study\s?guide|rooster|schedule|timetable|planning|toetsinformatie|toetsschema|reglement|onderwijs-?\s?en\s?examen|oer\b)/i;
const ASSIGNMENT_RE = /(opdracht|briefing|assignment|casusbeschrijving|project(plan|beschrijving|opdracht)|rubric|beoordelingscriteria|inleveren)/i;
const LITERATURE_RE = /(artikel|article|paper|et\s?al|doi|journal|review|lancet|bmj|jama)/i;

// Kenmerkende woorden in de tekst zelf (eerste stuk tekst van het document).
const COURSE_INFO_TEXT = /\b(deadline|herkansing|ects|aanwezigheidsplicht|rooster|werkgroep(en)?|inleverdatum|toetsmoment|studielast|cijferbepaling|resit|attendance|grading)\b/gi;
const LITERATURE_TEXT = /\b(abstract|doi:|et al\.|references|introduction|methods|conclusions?)\b/gi;
const ANSWER_TEXT = /\b(antwoordmodel|uitwerking|correct antwoord|answer key|model answer|puntentelling)\b/gi;

const countMatches = (re, text) => ((text || '').match(re) || []).length;

/**
 * Stel een doel voor op basis van bestandsnaam, extensie en (optioneel) een
 * stukje tekst. Geeft { purpose, materialKind?, confidence: 'high'|'medium'|'low', reason }.
 * `reason` is een i18n-sleutelsuffix (filePurpose.reason.<reason>) zodat de UI het
 * in de taal van de docent kan tonen.
 */
export function suggestPurpose({ filename = '', title = '', fileType = '', textSample = '' } = {}) {
  const name = `${title} ${filename}`.toLowerCase();
  const ext = (fileType || filename.split('.').pop() || '').toLowerCase().replace(/^\./, '');

  if (TEACHER_ONLY_RE.test(name) || countMatches(ANSWER_TEXT, textSample) >= 2) {
    return { purpose: 'teacher_only', confidence: TEACHER_ONLY_RE.test(name) ? 'high' : 'medium', reason: 'answersOrExam' };
  }
  if (DATA_EXT.has(ext)) {
    return { purpose: 'project', materialKind: 'data', confidence: 'high', reason: 'dataFile' };
  }
  if (COURSE_INFO_RE.test(name)) {
    return { purpose: 'course_info', confidence: 'high', reason: 'courseInfoName' };
  }
  if (ASSIGNMENT_RE.test(name)) {
    return { purpose: 'project', materialKind: 'assignment', confidence: 'medium', reason: 'assignmentName' };
  }
  if (countMatches(COURSE_INFO_TEXT, textSample) >= 3) {
    return { purpose: 'course_info', confidence: 'medium', reason: 'courseInfoText' };
  }
  if (LITERATURE_RE.test(name) || countMatches(LITERATURE_TEXT, textSample) >= 4) {
    // Een artikel kan leerstof óf projectliteratuur zijn: stel leerstof voor
    // (het veiligste voor de AI-functies), maar laat de twijfel zien.
    return { purpose: 'course_material', confidence: 'low', reason: 'looksLikeLiterature' };
  }
  if (TEXT_EXT.has(ext)) {
    return { purpose: 'course_material', confidence: 'medium', reason: 'textDocument' };
  }
  return { purpose: 'shared', confidence: 'low', reason: 'otherFile' };
}

/**
 * Effectief doel van een bestaand document: het opgeslagen doel, of — als het
 * nog niet is beoordeeld — wat het oude systeem er feitelijk mee deed (afgeleid
 * uit map/bucket). Zo verandert er niets totdat de docent iets bevestigt.
 */
export function effectivePurpose(doc, folder) {
  if (doc?.purpose && DOCUMENT_PURPOSES.includes(doc.purpose)) return doc.purpose;
  if (doc?.bucket === 'rag_sources' || folder?.folder_type === 'rag_sources') return 'course_material';
  if (folder?.folder_type === 'data') return 'project';
  return 'shared';
}

/** Bestanden die er naar hun naam/inhoud uitzien als antwoorden/tentamen maar voor studenten zichtbaar zijn. */
export function looksSensitive({ filename = '', title = '' } = {}) {
  return TEACHER_ONLY_RE.test(`${title} ${filename}`);
}
