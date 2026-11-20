// Beeldoefeningen, stap 2: het speelbord voor studenten (2026-11-21). De database-
// kant: oefeningen voor de student, een poging starten of hervatten, een antwoord
// nakijken, een hint geven en afronden. Het nakijken zelf staat in play.js.
//
// De antwoordsleutel (beschrijving en kenmerken) blijft hier: de student krijgt
// alleen de labels van wat hij of zij al gevonden heeft, en pas na afronden alles.
// Docenten krijgen pogingen nooit te zien (alleen later totalen).

import {
  PLAY_LIMITS, boardFor, buildClosingMessages, buildGradeMessages, buildHintMessages,
  leaksUnfound, mergeProgress, parseGrade, pickHint, stateOf,
} from './play.js';
import { fail, signedUrlMap } from './common.js';
const MAX_TURNS = 80;

async function playableExercises(db, courseId) {
  const { data, error } = await db.from('image_exercises')
    .select('id, storage_path, position, depth, count_display, description, description_confirmed_at, features_status, created_at')
    .eq('course_id', courseId).eq('features_status', 'ready').order('position').order('created_at');
  if (error) throw new Error(error.message);
  const rows = (data || []).filter((r) => r.description_confirmed_at && (r.description || '').trim());
  if (!rows.length) return { rows: [], features: new Map() };
  const { data: feats, error: fErr } = await db.from('image_exercise_features')
    .select('id, exercise_id, position, label, observation, interpretation, is_core, open_interpretation')
    .in('exercise_id', rows.map((r) => r.id)).order('position');
  if (fErr) throw new Error(fErr.message);
  const features = new Map(rows.map((r) => [r.id, []]));
  for (const f of feats || []) features.get(f.exercise_id)?.push(f);
  return { rows: rows.filter((r) => features.get(r.id).length > 0), features };
}

/** De oefeningen die een student kan doen, met de eigen voortgang. Geen bestandsnamen (die kunnen het antwoord verraden). */
export async function listForStudent(db, { courseId, userId }) {
  const { rows, features } = await playableExercises(db, courseId);
  if (!rows.length) return [];
  const { data: attempts } = await db.from('image_exercise_attempts')
    .select('exercise_id, status, progress, created_at').eq('user_id', userId).in('exercise_id', rows.map((r) => r.id));
  const latest = new Map();
  for (const a of (attempts || []).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))) {
    if (!latest.has(a.exercise_id)) latest.set(a.exercise_id, a);
  }
  const urls = await signedUrlMap(db, rows.map((r) => r.storage_path));
  return rows.map((r, i) => {
    const a = latest.get(r.id);
    const board = a ? boardFor(features.get(r.id), a, r.count_display) : null;
    return {
      id: r.id,
      number: i + 1,
      imageUrl: urls.get(r.storage_path) || null,
      status: !a ? 'new' : a.status,
      coreDone: board?.coreDone || false,
      found: board ? board.tiles.length : 0,
    };
  });
}

async function loadPlayable(db, courseId, id) {
  const { rows, features } = await playableExercises(db, courseId);
  const index = rows.findIndex((r) => r.id === id);
  if (index < 0) throw fail({ status: 404, error: 'Deze beeldoefening is niet beschikbaar.', code: 'notAvailable' });
  return { ex: rows[index], number: index + 1, features: features.get(id) };
}

async function currentAttempt(db, { ex, userId, courseId, create }) {
  const { data, error } = await db.from('image_exercise_attempts').select('*')
    .eq('exercise_id', ex.id).eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  if (data?.[0]) return data[0];
  if (!create) return null;
  const { data: created, error: insErr } = await db.from('image_exercise_attempts')
    .insert({ exercise_id: ex.id, user_id: userId, course_id: courseId }).select('*').single();
  if (insErr) throw new Error(insErr.message);
  return created;
}

async function stateResponse(db, { ex, number, features, attempt, reveal = false, extra = {} }) {
  const urls = await signedUrlMap(db, [ex.storage_path]);
  return {
    exercise: { id: ex.id, number, imageUrl: urls.get(ex.storage_path) || null, depth: ex.depth },
    board: boardFor(features, attempt, ex.count_display, { reveal }),
    turns: (attempt?.turns || []).map(({ role, text, code, kind }) => ({ role, text: text || '', code: code || null, kind: kind || null })),
    answersLeft: Math.max(0, PLAY_LIMITS.MAX_ANSWERS - (attempt?.answers || 0)),
    finished: attempt?.status === 'finished',
    ...(reveal ? { description: ex.description } : {}),
    ...extra,
  };
}

const now = () => new Date().toISOString();
const turn = (role, text, more = {}) => ({ role, text, at: now(), ...more });

async function saveAttempt(db, attempt, patch) {
  const turns = (patch.turns || attempt.turns || []).slice(-MAX_TURNS);
  const { error } = await db.from('image_exercise_attempts').update({ ...patch, turns, updated_at: now() }).eq('id', attempt.id);
  if (error) throw new Error(error.message);
  return { ...attempt, ...patch, turns };
}

/**
 * Een foto openen: de lopende poging hervatten; is die er niet maar wel een
 * afgeronde, dan het resultaat daarvan laten zien; anders een nieuwe beginnen.
 */
export async function startAttempt(db, { courseId, userId, id }) {
  const loaded = await loadPlayable(db, courseId, id);
  const active = await currentAttempt(db, { ...loaded, userId, courseId, create: false });
  if (active) return stateResponse(db, { ...loaded, attempt: active });
  const { data: done } = await db.from('image_exercise_attempts').select('*')
    .eq('exercise_id', id).eq('user_id', userId).eq('status', 'finished').order('finished_at', { ascending: false }).limit(1);
  if (done?.[0]) return stateResponse(db, { ...loaded, attempt: done[0], reveal: true });
  const attempt = await currentAttempt(db, { ...loaded, userId, courseId, create: true });
  return stateResponse(db, { ...loaded, attempt });
}

/** Opnieuw beginnen: de lopende poging sluiten (zonder terugblik) en een nieuwe maken. */
export async function restartAttempt(db, { courseId, userId, id }) {
  const loaded = await loadPlayable(db, courseId, id);
  const active = await currentAttempt(db, { ...loaded, userId, courseId, create: false });
  if (active) await saveAttempt(db, active, { status: 'finished', finished_at: now() });
  const attempt = await currentAttempt(db, { ...loaded, userId, courseId, create: true });
  return stateResponse(db, { ...loaded, attempt });
}

/**
 * Een antwoord nakijken. `llm(messages)` geeft het JSON-antwoord van het taalmodel.
 * Verraadt de feedback toch een nog niet gevonden kenmerk, dan krijgt de student
 * een algemene aanmoediging (code 'generic') in plaats van die tekst.
 */
export async function answer(db, llm, { courseId, userId, id, text, languageInstruction = '' }) {
  const clean = String(text || '').trim().slice(0, PLAY_LIMITS.MAX_ANSWER_CHARS);
  if (!clean) throw fail({ status: 400, error: 'Schrijf eerst wat je ziet.', code: 'emptyAnswer' });
  const loaded = await loadPlayable(db, courseId, id);
  const attempt = await currentAttempt(db, { ...loaded, userId, courseId, create: true });
  if ((attempt.answers || 0) >= PLAY_LIMITS.MAX_ANSWERS) {
    throw fail({ status: 429, error: 'Je hebt bij deze foto het maximum aantal antwoorden bereikt. Rond af om alles te zien.', code: 'tooManyAnswers' });
  }
  const previous = (attempt.turns || []).filter((t) => t.role === 'student').map((t) => t.text);
  const messages = buildGradeMessages({
    features: loaded.features, progress: attempt.progress, depth: loaded.ex.depth, answer: clean, previous, languageInstruction,
  });
  let grade = null;
  for (let i = 0; i < 2 && !grade; i++) {
    try { grade = parseGrade(await llm(messages), loaded.features, [...previous, clean]); } catch (err) { console.warn('[image-play] nakijken:', err.message); }
  }
  if (!grade) throw fail({ status: 502, error: 'Nakijken lukte even niet. Probeer het opnieuw.', code: 'gradeFailed' });
  const { progress, newly } = mergeProgress(attempt.progress, grade.updates, attempt.hints);
  const safe = grade.feedback && !leaksUnfound(grade.feedback, loaded.features, progress, [...previous, clean]);
  const leap = safe ? turn('leap', grade.feedback) : turn('leap', '', { code: 'generic' });
  const saved = await saveAttempt(db, attempt, {
    progress, answers: (attempt.answers || 0) + 1, turns: [...(attempt.turns || []), turn('student', clean), leap],
  });
  return stateResponse(db, {
    ...loaded, attempt: saved,
    extra: { newly: newly.map((n) => ({ id: n.id, state: n.state })) },
  });
}

/** De volgende hint (zie pickHint). Niveau 3 laat het kenmerk zien en telt het als gevonden met hint. */
export async function hint(db, llm, { courseId, userId, id, languageInstruction = '' }) {
  const loaded = await loadPlayable(db, courseId, id);
  const attempt = await currentAttempt(db, { ...loaded, userId, courseId, create: true });
  const pick = pickHint(loaded.features, attempt.progress, attempt.hints);
  if (!pick) throw fail({ status: 400, error: 'Je hebt alles al gevonden.', code: 'nothingLeft' });
  const { feature, level } = pick;
  const state = stateOf(attempt.progress, feature.id);
  const hints = { ...(attempt.hints || {}), [feature.id]: level };
  let progress = attempt.progress || {};
  let leap;
  if (level >= 3 && state !== 'half') {
    progress = { ...progress, [feature.id]: { state: 'full', how: 'hint' } };
    leap = turn('leap', [feature.label, feature.observation].filter(Boolean).join(': '), { kind: 'reveal' });
  } else {
    let text = '';
    try {
      const out = await llm(buildHintMessages(feature, level, state, languageInstruction));
      text = typeof out?.hint === 'string' ? out.hint.trim().slice(0, 600) : '';
    } catch (err) { console.warn('[image-play] hint:', err.message); }
    const studentTexts = (attempt.turns || []).filter((t) => t.role === 'student').map((t) => t.text);
    const leaks = state !== 'half' && leaksUnfound(text, loaded.features, progress, studentTexts);
    leap = text && !leaks ? turn('leap', text, { kind: 'hint' }) : turn('leap', '', { kind: 'hint', code: 'hintGeneric' });
  }
  const saved = await saveAttempt(db, attempt, { hints, progress, turns: [...(attempt.turns || []), leap] });
  return stateResponse(db, { ...loaded, attempt: saved, extra: { hintLevel: level } });
}

/** Afronden: alles zichtbaar, met de beschrijving van de docent en een korte terugblik. */
export async function finish(db, llm, { courseId, userId, id, languageInstruction = '' }) {
  const loaded = await loadPlayable(db, courseId, id);
  const attempt = await currentAttempt(db, { ...loaded, userId, courseId, create: true });
  const p = attempt.progress || {};
  const found = loaded.features.filter((f) => stateOf(p, f.id) !== 'none' && p[f.id]?.how !== 'hint').map((f) => f.label);
  const hinted = loaded.features.filter((f) => p[f.id]?.how === 'hint').map((f) => f.label);
  const missed = loaded.features.filter((f) => stateOf(p, f.id) === 'none').map((f) => f.label);
  let closing = '';
  try {
    const out = await llm(buildClosingMessages({ found, missed, hinted, languageInstruction }));
    closing = typeof out?.closing === 'string' ? out.closing.trim().slice(0, 800) : '';
  } catch (err) { console.warn('[image-play] terugblik:', err.message); }
  const leap = closing ? turn('leap', closing, { kind: 'closing' }) : turn('leap', '', { kind: 'closing', code: 'closingGeneric' });
  const saved = await saveAttempt(db, attempt, { status: 'finished', finished_at: now(), turns: [...(attempt.turns || []), leap] });
  return stateResponse(db, { ...loaded, attempt: saved, reveal: true });
}
