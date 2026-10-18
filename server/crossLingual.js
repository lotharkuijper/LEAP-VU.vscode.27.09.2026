// Zoeken in twee talen (2026-10-18).
//
// Aanleiding: Microbiologie heeft een Engels boek; studenten vragen in het
// Nederlands. text-embedding-3-small vindt over taalgrenzen heen minder: "Wat
// doet het complementsysteem?" scoorde 0,31, "What does the complement system
// do?" 0,64 (drempel 0,45). De tutor vond de stof dus niet.
//
// Nu: is de vraag in een andere taal dan het cursusmateriaal, dan vertaalt de
// server haar naar de taal van het materiaal; de browser zoekt met beide
// versies en neemt per passage de beste score (src/services/rag.service.ts).
// Kost per vraag één korte aanroep van het taalmodel; vertalingen worden
// onthouden. Faalt er iets, dan zoekt de browser gewoon met de originele vraag.

import { normalizeLang, languageEnglishName } from './languages.js';

const STOPWORDS = {
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'die', 'in', 'op', 'te', 'zijn', 'voor', 'met', 'niet', 'wat', 'hoe', 'waarom', 'ik', 'je', 'er', 'aan', 'ook', 'wordt', 'worden', 'deze', 'bij', 'naar', 'als', 'dan', 'of', 'kan', 'welke', 'wel'],
  en: ['the', 'a', 'an', 'and', 'of', 'is', 'are', 'that', 'in', 'on', 'to', 'for', 'with', 'not', 'what', 'how', 'why', 'it', 'this', 'by', 'as', 'be', 'from', 'which', 'can', 'do', 'does', 'these', 'was', 'were', 'or', 'at', 'have', 'has'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'von', 'zu', 'wie', 'was', 'warum', 'ich', 'sie', 'auf', 'für', 'dem', 'den'],
  fr: ['le', 'la', 'les', 'et', 'est', 'un', 'une', 'des', 'du', 'que', 'qui', 'pour', 'dans', 'pas', 'comment', 'pourquoi', 'avec', 'sur', 'au', 'ce'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'un', 'una', 'de', 'que', 'en', 'por', 'para', 'con', 'como', 'qué', 'cómo', 'por qué', 'del', 'se'],
};
const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v)]));

/** Pure: taal van een tekst op basis van functiewoorden; null als het niet duidelijk is. */
export function detectLanguage(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}']+/gu) || [];
  if (words.length < 3) return null;
  const scores = Object.fromEntries(Object.keys(SETS).map((k) => [k, 0]));
  for (const w of words) for (const [k, s] of Object.entries(SETS)) if (s.has(w)) scores[k] += 1;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] < 2 || best[1] < second[1] * 1.5 + 1) return null;
  return best[0];
}

/** Pure: meerderheidstaal van een reeks tekstfragmenten (null bij geen duidelijke meerderheid). */
export function majorityLanguage(texts) {
  const counts = {};
  let total = 0;
  for (const t of texts || []) {
    const l = detectLanguage(String(t).slice(0, 2000));
    if (!l) continue;
    counts[l] = (counts[l] || 0) + 1; total += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && total >= 3 && best[1] / total >= 0.6 ? best[0] : null;
}

/** Pure: moet er vertaald worden? */
export function needsTranslation(queryLang, materialLang) {
  return !!(queryLang && materialLang && queryLang !== materialLang);
}

export function buildTranslationMessages(query, targetLang) {
  const target = languageEnglishName(targetLang) || targetLang;
  return [
    { role: 'system', content: `Translate the student's question into ${target}, for searching ${target}-language course material. Use the technical terms as they are used in ${target}-language textbooks. Keep it a question; do not answer it, explain it or add anything. Output only the translation.` },
    { role: 'user', content: String(query).slice(0, 1000) },
  ];
}

/**
 * POST /api/rag/query-variants { courseId, query, lang } →
 * { materialLang, queryLang, translated: string | null }
 * deps: pgPool, requireAuthUser, userHasCourseAccess, translate(messages) → string.
 */
export function registerCrossLingualRoute(app, { pgPool, requireAuthUser, userHasCourseAccess, translate }) {
  const materialCache = new Map();   // courseId → { at, lang }
  const translationCache = new Map(); // `${lang}|${query}` → vertaling
  const MATERIAL_TTL_MS = 30 * 60 * 1000;

  async function materialLanguage(courseId) {
    const hit = materialCache.get(courseId);
    if (hit && Date.now() - hit.at < MATERIAL_TTL_MS) return hit.lang;
    // Het eerste fragment van (hoogstens) 40 leerstofdocumenten van de cursus.
    const r = await pgPool.query(
      `SELECT DISTINCT ON (d.id) c.content
         FROM documents d
         JOIN course_folder_assignments a ON a.folder_id = d.folder_id
         JOIN document_chunks c ON c.document_id = d.id
        WHERE a.course_id = $1 AND (d.purpose = 'course_material' OR d.purpose IS NULL)
        ORDER BY d.id, c.chunk_index
        LIMIT 40`,
      [courseId],
    );
    const lang = majorityLanguage(r.rows.map((x) => x.content));
    materialCache.set(courseId, { at: Date.now(), lang });
    return lang;
  }

  app.post('/api/rag/query-variants', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, query } = req.body || {};
    if (!courseId || typeof query !== 'string' || !query.trim()) return res.status(400).json({ error: 'courseId en query zijn vereist' });
    try {
      if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
      const materialLang = await materialLanguage(courseId);
      const queryLang = detectLanguage(query) || normalizeLang(req.body?.lang || req.get('x-leap-lang'));
      if (!needsTranslation(queryLang, materialLang)) return res.json({ materialLang, queryLang, translated: null });
      const key = `${materialLang}|${query.trim()}`;
      let translated = translationCache.get(key);
      if (!translated) {
        translated = String(await translate(buildTranslationMessages(query.trim(), materialLang)) || '').trim().slice(0, 1000);
        if (translated) {
          if (translationCache.size > 2000) translationCache.delete(translationCache.keys().next().value);
          translationCache.set(key, translated);
        }
      }
      return res.json({ materialLang, queryLang, translated: translated || null });
    } catch (err) {
      // Nooit de zoekopdracht blokkeren: zonder vertaling zoekt de browser gewoon met de vraag.
      console.warn('[zoeken in twee talen] overgeslagen:', err?.message || err);
      return res.json({ materialLang: null, queryLang: null, translated: null });
    }
  });
}
