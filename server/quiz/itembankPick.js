// ItemBank-vragen kiezen voor een quiz (uit /api/quiz/itembank-questions gehaald
// op 2026-11-12, toen de server de quiz ging samenstellen). Matcht de vragen op
// de secties die de docent aan de gekozen begrippen heeft gekoppeld, binnen de
// bronnen van deze cursus. Elke vraag krijgt het begrip mee waar hij bij hoort.

import { supabaseAdmin } from '../lib/supabase.js';
import { quizSourcesSchemaReady } from '../lib/schemaFlags.js';
import { itembankSourceOrFilter } from './itembankScope.js';

const normalizePath = (p) => (Array.isArray(p) ? p : []).map(s => String(s ?? '').toLowerCase().trim());

/** Pure: valt dit vraagpad onder dit sectiepad (hoofdletterongevoelig)? */
export function pathUnder(questionPath, sectionPath) {
  const q = normalizePath(questionPath);
  const target = normalizePath(sectionPath);
  if (q.length < target.length) return false;
  return target.every((s, i) => q[i] === s);
}

const parseNumberLoose = (raw) => {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).replace(/,/g, '.').trim().match(/-?\d+(?:\.\d+)?(?:[eE]-?\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
};

/** Pure: een rij uit quiz_questions in het formaat van de quiz (Task #67 voor open vragen). */
export function itembankRowToQuestion(q, conceptId = null) {
  if ((q.item_type || 'mcq') === 'open') {
    const meta = (q.metadata && typeof q.metadata === 'object') ? q.metadata : {};
    const extype = String(meta.extype || '').toLowerCase().trim() || undefined;
    const numericSolution = q.correct_answer || '';
    const writtenSolution = q.explanation || '';
    // Bij een numerieke vraag blijft het exacte getal apart voor de tolerantiecheck.
    const numericExpected = extype === 'num' ? parseNumberLoose(numericSolution) : null;
    // extol is meestal een absolute tolerantie; bij een lijst de grootste waarde.
    let numericTolerance = null;
    const extolRaw = meta.extol;
    if (Array.isArray(extolRaw)) {
      const nums = extolRaw.map(parseNumberLoose).filter(n => n !== null && n >= 0);
      if (nums.length > 0) numericTolerance = Math.max(...nums);
    } else if (extolRaw !== undefined && extolRaw !== null && String(extolRaw).trim() !== '') {
      const t = parseNumberLoose(extolRaw);
      if (t !== null && t >= 0) numericTolerance = t;
    }
    const modelAnswer = extype === 'num'
      ? writtenSolution
      : (numericSolution ? (writtenSolution ? `${numericSolution}\n\n${writtenSolution}` : numericSolution) : writtenSolution);
    return {
      type: 'open', question: q.question_text, modelAnswer, explanation: writtenSolution,
      extype, numericExpected: numericExpected ?? undefined, numericTolerance: numericTolerance ?? undefined, conceptId,
    };
  }
  return {
    type: 'mcq', question: q.question_text, options: q.answer_options || {},
    correctAnswer: q.correct_answer, explanation: q.explanation || '', conceptId,
  };
}

/**
 * Tot `limit` willekeurige ItemBank-vragen van het gevraagde type voor deze
 * begrippen. Toegang tot de cursus controleert de aanroeper. Casus → [].
 */
export async function pickItembankQuestions({ courseId, conceptIds, limit, questionType }) {
  const wanted = questionType === 'open' ? 'open' : (questionType === 'mcq' ? 'mcq' : null);
  if (!wanted || !courseId || !conceptIds?.length || limit <= 0 || !quizSourcesSchemaReady || !supabaseAdmin) return [];
  const { data: mappings, error: mapErr } = await supabaseAdmin
    .from('concept_itembank_sections')
    .select('concept_id, exsection_path, course_id')
    .in('concept_id', conceptIds)
    .or(`course_id.eq.${courseId},course_id.is.null`);
  if (mapErr) throw new Error(mapErr.message);
  const sections = (mappings || []).filter(m => Array.isArray(m.exsection_path) && m.exsection_path.length > 0);
  if (sections.length === 0) return [];

  // Zonder exacte-string-prefilter: de ShareStats-bank kent hoofdlettervarianten
  // en overlaps() in PostgREST is hoofdlettergevoelig; daarom matchen we hier.
  const { data: candidates, error: qErr } = await supabaseAdmin
    .from('quiz_questions')
    .select('id, question_text, answer_options, correct_answer, explanation, exsection_path, item_type, metadata')
    .or(itembankSourceOrFilter(courseId))
    .limit(5000);
  if (qErr) throw new Error(qErr.message);
  // item_type: oude rijen zonder type zijn meerkeuze.
  const typeMatches = (it) => (wanted === 'mcq' ? (it === 'mcq' || it == null) : it === 'open');
  const matches = [];
  for (const q of candidates || []) {
    if (!typeMatches(q.item_type)) continue;
    const hit = sections.find(s => pathUnder(q.exsection_path, s.exsection_path));
    if (hit) matches.push({ row: q, conceptId: hit.concept_id });
  }
  for (let i = matches.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [matches[i], matches[j]] = [matches[j], matches[i]];
  }
  return matches.slice(0, Math.min(limit, 50)).map(m => itembankRowToQuestion(m.row, m.conceptId));
}
