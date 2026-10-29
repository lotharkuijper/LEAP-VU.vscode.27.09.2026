import { supabaseAdmin } from './supabase.js';

export let conceptsHasCourseId = false;

export async function detectConceptsCourseIdColumn() {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin.from('concepts').select('course_id').limit(1);
    conceptsHasCourseId = !error || !error.message.includes('course_id');
    console.log(`[API Server] concepts.course_id: ${conceptsHasCourseId ? 'beschikbaar' : 'niet gemigreerd — key_points fallback actief'}`);
  } catch (e) {
    conceptsHasCourseId = false;
    console.warn('[API Server] Column detectie mislukt:', e.message);
  }
}

// Task #270: courses.student_visible bepaalt of een cursus zichtbaar/bruikbaar
// is voor studenten. Detecteer defensief of de migratie is toegepast, zodat een
// oude DB blijft werken (dan gedragen alle cursussen zich als zichtbaar) en de
// server-side toegangscheck (userHasCourseAccess) de kolom alleen raadpleegt
// wanneer hij bestaat.
export let coursesHasStudentVisible = false;

export async function detectCoursesStudentVisibleColumn() {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin.from('courses').select('student_visible').limit(1);
    coursesHasStudentVisible = !error || !/student_visible/.test(error.message || '');
    console.log(`[API Server] courses.student_visible: ${coursesHasStudentVisible ? 'beschikbaar' : 'niet gemigreerd — alle cursussen zichtbaar'}`);
  } catch (e) {
    coursesHasStudentVisible = false;
    console.warn('[API Server] courses.student_visible detectie mislukt:', e.message);
  }
}

// Task #52 (Quiz-omgeving herontwerp fase 1) breidt quiz_attempts uit met
// nieuwe kolommen (topics text[], difficulty, question_type, questions_data,
// answers, score_percentage, created_at). Detecteer of de migratie
// `20260430120000_extend_quiz_attempts_for_multi_type.sql` is toegepast,
// zodat /api/quiz/delete en de nieuwe insert-flow vroegtijdig en duidelijk
// kunnen falen als dat niet het geval is.
export let quizAttemptsHasNewSchema = false;

export async function detectQuizAttemptsSchema() {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin
      .from('quiz_attempts')
      .select('topics, question_type, questions_data, answers, score_percentage, created_at')
      .limit(1);
    quizAttemptsHasNewSchema = !error;
    if (error) {
      console.warn(`[API Server] quiz_attempts nieuw schema NIET gevonden: ${error.message}`);
      console.warn('[API Server] Pas migratie 20260430120000_extend_quiz_attempts_for_multi_type.sql toe in Supabase.');
    } else {
      console.log('[API Server] quiz_attempts nieuw schema beschikbaar.');
    }
  } catch (e) {
    quizAttemptsHasNewSchema = false;
    console.warn('[API Server] quiz_attempts schema detectie mislukt:', e.message);
  }
}

// Task #391: documents.content_hash maakt de website-import een goedkope top-up:
// een ongewijzigde pagina wordt bij her-import overgeslagen i.p.v. opnieuw
// geëmbed. Detecteer defensief of de migratie is toegepast; zonder de kolom valt
// de import terug op het oude gedrag (altijd opnieuw embedden).
export let documentsHasContentHash = false;

export async function detectDocumentsContentHash() {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin.from('documents').select('content_hash').limit(1);
    documentsHasContentHash = !error || !/content_hash/.test(error.message || '');
    console.log(`[API Server] documents.content_hash: ${documentsHasContentHash ? 'beschikbaar' : 'niet gemigreerd — web-import embedt altijd opnieuw'}`);
  } catch (e) {
    documentsHasContentHash = false;
    console.warn('[API Server] documents.content_hash detectie mislukt:', e.message);
  }
}

// Websitebronnen (migratie 20260926100000_web_sources): groeperen de pagina's
// van één website zodat de docent ze in één keer kan bijwerken, van doel
// wisselen of verwijderen. Zonder de migratie werkt de web-import als voorheen
// (losse pagina's), maar krijgen pagina's wél een bevestigd doel.
export let webSourcesAvailable = false;

export async function detectWebSources() {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin.from('web_sources').select('id').limit(1);
    const { error: colErr } = await supabaseAdmin.from('documents').select('web_source_id').limit(1);
    webSourcesAvailable = !error && !colErr;
    console.log(`[API Server] web_sources: ${webSourcesAvailable ? 'beschikbaar' : 'niet gemigreerd — webpagina\'s verschijnen als losse bestanden'}`);
  } catch (e) {
    webSourcesAvailable = false;
    console.warn('[API Server] web_sources detectie mislukt:', e.message);
  }
}

// =============================================================================
// Task #57 — Beheer voor 3 quiz-bronnen (RAG, ItemBank, LLM-creatief)
// =============================================================================

// Defensieve schema-detectie voor de tabellen uit migratie
// 20260430160000_quiz_sources_management.sql. De server blijft draaien als
// de migratie nog niet is toegepast; endpoints geven dan een 503 met
// duidelijke uitleg.
export let quizSourcesSchemaReady = false;

// Task #243: concept_evidence koppelt elk begrip aan zijn ondersteunende
// RAG-bronfragmenten bij extractie. Detecteer defensief of de migratie is
// toegepast, zodat extractie en "Ik leg uit" zonder de tabel blijven werken.
export let conceptEvidenceSchemaReady = false;

export async function detectConceptEvidenceSchema() {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin.from('concept_evidence').select('id').limit(1);
    conceptEvidenceSchemaReady = !error;
    if (error) {
      console.warn('[init] concept_evidence schema NIET gevonden:', error.message);
      console.warn('[init] Pas migratie 20260605100000_concept_evidence.sql toe in Supabase.');
    } else {
      console.log('[init] concept_evidence schema beschikbaar.');
    }
  } catch (e) {
    conceptEvidenceSchemaReady = false;
    console.warn('[init] concept_evidence schema detectie mislukt:', e.message);
  }
}

export async function detectQuizSourcesSchema() {
  if (!supabaseAdmin) return;
  try {
    const checks = await Promise.all([
      supabaseAdmin.from('concept_itembank_sections').select('id').limit(1),
      supabaseAdmin.from('concept_rag_sources').select('id').limit(1),
      supabaseAdmin.from('quiz_sources_mix').select('course_id').limit(1),
      supabaseAdmin.from('quiz_questions').select('exsection_path').limit(1),
    ]);
    const firstError = checks.find(c => c.error);
    quizSourcesSchemaReady = !firstError;
    if (firstError) {
      console.warn('[init] quiz_sources schema NIET gevonden:', firstError.error.message);
      console.warn('[init] Pas migratie 20260430160000_quiz_sources_management.sql toe in Supabase.');
    } else {
      console.log('[init] quiz_sources schema beschikbaar.');
    }
  } catch (e) {
    quizSourcesSchemaReady = false;
    console.warn('[init] quiz_sources schema detectie mislukt:', e.message);
  }
}
