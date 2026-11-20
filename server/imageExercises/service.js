// Beeldoefeningen, docentkant (2026-11-20): foto's, beschrijvingen, koppelen en
// kenmerken. Alle functies krijgen de database (supabaseAdmin) en waar nodig het
// taalmodel mee, zodat ze zonder netwerk te testen zijn. De routes (routes.js)
// controleren eerst of de aanvrager docent van de cursus of admin is.
//
// Geheim: beschrijvingen en kenmerken zijn de antwoordsleutel. Ze gaan alleen naar
// de docent van de cursus; studenten krijgen ze in deze stap nergens.

import { planDocument } from './descriptions.js';
import { buildFeatureMessages, cleanTeacherFeatures, parseFeatureResponse } from './features.js';

export const BUCKET = 'image_exercises';
export const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_DESCRIPTION_CHARS = 20_000;
export const THUMB_URL_SECONDS = 600;
const SUGGEST_MAX_IMAGES = 10;

const fail = ({ status, error, code }) => Object.assign(new Error(error), { status, code });

// Herkent het echte bestandstype aan de eerste bytes; de naam of het opgegeven
// type is niet genoeg (een .jpg kan iets anders zijn).
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function loadExercise(db, courseId, id) {
  const { data, error } = await db.from('image_exercises').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.course_id !== courseId) throw fail({ status: 404, error: 'Foto niet gevonden in deze cursus' });
  return data;
}

/** Alle foto's van de cursus met beschrijving, kenmerken en een tijdelijke link naar het beeld. */
export async function listExercises(db, courseId) {
  const { data: rows, error } = await db.from('image_exercises').select('*').eq('course_id', courseId).order('position').order('created_at');
  if (error) throw new Error(error.message);
  const ids = (rows || []).map((r) => r.id);
  const featuresBy = new Map(ids.map((id) => [id, []]));
  if (ids.length) {
    const { data: feats, error: fErr } = await db.from('image_exercise_features').select('*').in('exercise_id', ids).order('position');
    if (fErr) throw new Error(fErr.message);
    for (const f of feats || []) featuresBy.get(f.exercise_id)?.push(f);
  }
  const urls = new Map();
  if (ids.length) {
    const { data: signed } = await db.storage.from(BUCKET).createSignedUrls((rows || []).map((r) => r.storage_path), THUMB_URL_SECONDS);
    for (const s of signed || []) if (s?.path && s?.signedUrl) urls.set(s.path, s.signedUrl);
  }
  return (rows || []).map((r) => ({
    id: r.id,
    filename: r.filename,
    position: r.position,
    imageUrl: urls.get(r.storage_path) || null,
    description: r.description || '',
    matchSource: r.match_source,
    confirmed: !!r.description_confirmed_at,
    depth: r.depth,
    countDisplay: r.count_display,
    featuresStatus: r.features_status,
    featuresUncertain: r.features_uncertain,
    featuresNote: r.features_note || '',
    featuresReviewed: !!r.features_reviewed_at,
    features: (featuresBy.get(r.id) || []).map((f) => ({
      id: f.id, label: f.label, observation: f.observation || '', interpretation: f.interpretation || '',
      is_core: f.is_core, open_interpretation: f.open_interpretation, source: f.source,
    })),
  }));
}

/** Eén foto opslaan in de private map en registreren. */
export async function addPhoto(db, { courseId, userId, filename, buffer, newId }) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  if (!IMAGE_TYPES[ext]) throw fail({ status: 400, error: 'Alleen foto’s in jpg, png of webp.', code: 'badImageType' });
  if (!buffer?.length || buffer.length > MAX_IMAGE_BYTES) throw fail({ status: 400, error: 'Een foto mag hooguit 20 MB zijn.', code: 'imageTooLarge' });
  const mime = sniffImageType(buffer);
  if (!mime) throw fail({ status: 400, error: 'Alleen foto’s in jpg, png of webp.', code: 'badImageType' });
  const { count } = await db.from('image_exercises').select('id', { count: 'exact', head: true }).eq('course_id', courseId);
  const id = newId();
  const path = `${courseId}/${id}.${ext === 'jpeg' ? 'jpg' : ext}`;
  const { error: upErr } = await db.storage.from(BUCKET).upload(path, buffer, { contentType: mime, upsert: false });
  if (upErr) throw new Error(`Opslaan mislukt: ${upErr.message}`);
  const name = String(filename).replace(/[\r\n]/g, ' ').slice(0, 200);
  const { data, error } = await db.from('image_exercises').insert({
    id, course_id: courseId, storage_path: path, filename: name, mime_type: mime,
    byte_size: buffer.length, position: count || 0, created_by: userId,
  }).select('id').single();
  if (error) {
    await db.storage.from(BUCKET).remove([path]);
    throw new Error(error.message);
  }
  return { id: data.id };
}

// Een (nieuwe) beschrijving opslaan als voorstel: onbevestigd, oude kenmerken weg.
async function storeDescription(db, id, text, source) {
  const { error } = await db.from('image_exercises').update({
    description: text.slice(0, MAX_DESCRIPTION_CHARS), match_source: source, description_confirmed_at: null,
    features_status: 'none', features_uncertain: false, features_note: null, features_reviewed_at: null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw new Error(error.message);
  await db.from('image_exercise_features').delete().eq('exercise_id', id);
}

/**
 * Een beschrijvingsdocument verwerken en koppelen aan foto's die nog geen bevestigde
 * beschrijving hebben (zie planDocument voor de volgorde van de manieren). Met
 * `exerciseId` hoort de hele tekst bij die ene foto: de docent koos hem zelf.
 * Alles wordt opgeslagen als voorstel; de docent bevestigt.
 */
export async function applyDescriptionText(db, { courseId, text, filename = '', exerciseId = null }) {
  if (!String(text || '').trim()) throw fail({ status: 400, error: 'In dit document staat geen tekst.', code: 'emptyDocument' });
  if (exerciseId) {
    await loadExercise(db, courseId, exerciseId);
    await storeDescription(db, exerciseId, String(text).trim(), 'manual');
    return { method: 'photo', sections: 1, matched: [{ id: exerciseId, source: 'manual' }], unmatchedSections: [], alreadyConfirmed: 0 };
  }
  const { data: rows, error } = await db.from('image_exercises')
    .select('id, filename, position, description, description_confirmed_at').eq('course_id', courseId).order('position').order('created_at');
  if (error) throw new Error(error.message);
  const open = (rows || []).filter((r) => !r.description_confirmed_at);
  const plan = planDocument(text, { filename, images: rows || [], open });
  for (const m of plan.matches) await storeDescription(db, m.imageId, plan.sections[m.section].text, m.source);
  return {
    method: plan.method,
    sections: plan.sections.length,
    matched: plan.matches.map((m) => ({ id: m.imageId, source: m.source })),
    unmatchedSections: plan.unmatchedSections.map((i) => ({ heading: plan.sections[i].heading, text: plan.sections[i].text.slice(0, MAX_DESCRIPTION_CHARS) })),
    alreadyConfirmed: (rows || []).length - open.length,
  };
}

/**
 * Beschrijving of instellingen van één foto aanpassen. Een nieuwe beschrijving
 * maakt de koppeling onbevestigd en gooit de kenmerken weg (de sleutel is veranderd).
 */
export async function updateExercise(db, { courseId, id, description, matchSource, depth, countDisplay }) {
  const row = await loadExercise(db, courseId, id);
  const patch = { updated_at: new Date().toISOString() };
  if (typeof description === 'string') {
    const d = description.trim().slice(0, MAX_DESCRIPTION_CHARS);
    if (d !== (row.description || '')) {
      Object.assign(patch, {
        description: d || null, match_source: d ? (matchSource === 'suggested' ? 'suggested' : matchSource === 'typed' ? 'typed' : 'manual') : null,
        description_confirmed_at: null, features_status: 'none', features_uncertain: false, features_note: null, features_reviewed_at: null,
      });
      await db.from('image_exercise_features').delete().eq('exercise_id', id);
    }
  }
  if (depth !== undefined) {
    if (!['name', 'describe', 'interpret'].includes(depth)) throw fail({ status: 400, error: 'Ongeldige diepgang' });
    patch.depth = depth;
  }
  if (countDisplay !== undefined) {
    if (!['exact', 'approx', 'none'].includes(countDisplay)) throw fail({ status: 400, error: 'Ongeldige instelling voor het aantal' });
    patch.count_display = countDisplay;
  }
  const { error } = await db.from('image_exercises').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

/** Koppelingen bevestigen; geeft de id's terug waarvoor kenmerken gemaakt moeten worden. */
export async function confirmExercises(db, { courseId, ids }) {
  if (!Array.isArray(ids) || ids.length === 0) return { confirmed: [] };
  const { data: rows, error } = await db.from('image_exercises')
    .select('id, course_id, description, description_confirmed_at').in('id', ids.slice(0, 500));
  if (error) throw new Error(error.message);
  const ok = (rows || []).filter((r) => r.course_id === courseId && (r.description || '').trim());
  const now = new Date().toISOString();
  const confirmed = [];
  for (const r of ok) {
    const { error: uErr } = await db.from('image_exercises')
      .update({ description_confirmed_at: now, features_status: 'pending', updated_at: now }).eq('id', r.id);
    if (!uErr) confirmed.push(r.id);
  }
  return { confirmed };
}

/**
 * Kenmerken maken uit de beschrijving. `llm(messages)` geeft het JSON-antwoord van
 * het taalmodel (object of tekst), of gooit bij een fout.
 */
export async function generateFeatures(db, llm, id) {
  const { data: row, error } = await db.from('image_exercises').select('id, description').eq('id', id).maybeSingle();
  if (error || !row) return { ok: false };
  const description = (row.description || '').trim();
  const setStatus = (p) => db.from('image_exercises').update({ ...p, updated_at: new Date().toISOString() }).eq('id', id);
  if (!description) { await setStatus({ features_status: 'failed', features_note: null }); return { ok: false }; }
  const { explicit, messages } = buildFeatureMessages(description);
  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try { parsed = parseFeatureResponse(await llm(messages), { explicit }); } catch (err) { console.warn('[image-exercises] kenmerken:', err.message); }
  }
  if (!parsed) { await setStatus({ features_status: 'failed' }); return { ok: false }; }
  // Is de beschrijving intussen veranderd, dan horen deze kenmerken er niet meer bij.
  const { data: now } = await db.from('image_exercises').select('description').eq('id', id).maybeSingle();
  if ((now?.description || '').trim() !== description) return { ok: false, stale: true };
  await db.from('image_exercise_features').delete().eq('exercise_id', id);
  const { error: insErr } = await db.from('image_exercise_features').insert(parsed.features.map((f, i) => ({ exercise_id: id, position: i, source: 'auto', ...f })));
  if (insErr) { await setStatus({ features_status: 'failed' }); return { ok: false }; }
  await setStatus({ features_status: 'ready', features_uncertain: parsed.uncertain, features_note: parsed.note || null, features_reviewed_at: null });
  return { ok: true, count: parsed.features.length, uncertain: parsed.uncertain };
}

/** De docent slaat de hele lijst op (na aanpassen): die geldt dan als nagelopen. */
export async function saveFeatures(db, { courseId, id, features }) {
  await loadExercise(db, courseId, id);
  const clean = cleanTeacherFeatures(features);
  if (clean.length === 0) throw fail({ status: 400, error: 'Er moet minstens één kenmerk overblijven.', code: 'noFeatures' });
  const { error: dErr } = await db.from('image_exercise_features').delete().eq('exercise_id', id);
  if (dErr) throw new Error(dErr.message);
  const { error } = await db.from('image_exercise_features').insert(clean.map((f, i) => ({ exercise_id: id, position: i, source: 'teacher', ...f })));
  if (error) throw new Error(error.message);
  const now = new Date().toISOString();
  await db.from('image_exercises').update({ features_status: 'ready', features_uncertain: false, features_note: null, features_reviewed_at: now, updated_at: now }).eq('id', id);
  return { ok: true, count: clean.length };
}

/** Eén kenmerk snel van kern naar extra (of terug), met één klik op het overzicht. */
export async function setFeatureCore(db, { courseId, featureId, isCore }) {
  const { data: f, error } = await db.from('image_exercise_features').select('id, exercise_id').eq('id', featureId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!f) throw fail({ status: 404, error: 'Kenmerk niet gevonden' });
  await loadExercise(db, courseId, f.exercise_id);
  const { error: uErr } = await db.from('image_exercise_features').update({ is_core: !!isCore, source: 'teacher' }).eq('id', featureId);
  if (uErr) throw new Error(uErr.message);
  return { ok: true };
}

/** Foto en alles wat erbij hoort verwijderen. */
export async function deleteExercise(db, { courseId, id }) {
  const row = await loadExercise(db, courseId, id);
  const { error } = await db.from('image_exercises').delete().eq('id', id);
  if (error) throw new Error(error.message);
  const { error: sErr } = await db.storage.from(BUCKET).remove([row.storage_path]);
  if (sErr) console.warn('[image-exercises] foto niet uit opslag verwijderd:', sErr.message);
  return { ok: true };
}

/** Alle foto's van een (verwijderde) cursus uit de opslag halen. */
export async function removeCoursePhotos(db, courseId) {
  if (!db?.storage) return { removed: 0 };
  let removed = 0;
  for (let round = 0; round < 50; round++) {
    const { data, error } = await db.storage.from(BUCKET).list(courseId, { limit: 1000 });
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    const paths = data.map((o) => `${courseId}/${o.name}`);
    const { error: rErr } = await db.storage.from(BUCKET).remove(paths);
    if (rErr) throw new Error(rErr.message);
    removed += paths.length;
    if (data.length < 1000) break;
  }
  return { removed };
}

/**
 * Voorstel van LEAP voor foto's zonder beschrijving: welke van de losse stukken
 * tekst hoort bij welke foto? Het taalmodel kijkt naar de foto en de tekst; de
 * docent bevestigt altijd zelf. `vision(messages)` geeft {"index": n|null, "confidence": "high"|"low"}.
 */
export async function suggestMatches(db, vision, { courseId, sections }) {
  const texts = (Array.isArray(sections) ? sections : []).map((s) => String(s || '').slice(0, 1500)).filter(Boolean).slice(0, 30);
  if (texts.length === 0) return { suggestions: [] };
  const { data: rows, error } = await db.from('image_exercises')
    .select('id, storage_path, mime_type, description').eq('course_id', courseId).order('position');
  if (error) throw new Error(error.message);
  const todo = (rows || []).filter((r) => !(r.description || '').trim()).slice(0, SUGGEST_MAX_IMAGES);
  const list = texts.map((t, i) => `[${i}] ${t.slice(0, 600)}`).join('\n\n');
  const suggestions = [];
  for (const r of todo) {
    const { data: blob, error: dErr } = await db.storage.from(BUCKET).download(r.storage_path);
    if (dErr || !blob) continue;
    const b64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
    const messages = [
      { role: 'system', content: 'Je helpt een docent foto\'s te koppelen aan zijn eigen beschrijvingen. Kies de beschrijving die het best bij de foto past, of null als geen enkele duidelijk past. Antwoord uitsluitend met JSON: {"index": <nummer of null>, "confidence": "high" of "low"}.' },
      { role: 'user', content: [
        { type: 'text', text: `Beschrijvingen:\n${list}` },
        { type: 'image_url', image_url: { url: `data:${r.mime_type};base64,${b64}`, detail: 'low' } },
      ] },
    ];
    try {
      const out = await vision(messages);
      const data = typeof out === 'string' ? JSON.parse(out) : out;
      const idx = Number.isInteger(data?.index) && data.index >= 0 && data.index < texts.length ? data.index : null;
      if (idx !== null) suggestions.push({ id: r.id, section: idx, confidence: data.confidence === 'high' ? 'high' : 'low' });
    } catch (err) {
      console.warn('[image-exercises] voorstel:', err.message);
    }
  }
  return { suggestions };
}
