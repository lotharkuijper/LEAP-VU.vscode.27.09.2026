// "Klaar voor een hoger niveau?" — een oordeel dat de app kan lezen.
//
// Als de student in de chat om een eerlijke inschatting vraagt, geeft de tutor
// zijn gewone, onderbouwde antwoord en zet er ONZICHTBAAR een label achter:
//   [[LEAP_READINESS verdict=ready|almost|not_yet topic="<begrip uit de lijst>"]]
// De server haalt dat label uit het antwoord (de student ziet het nooit), en
// beslist daarna zelf of het oordeel telt voor een feestje + achievement:
//  * het niveau komt uit de database, niet van de browser;
//  * een gesprek met te weinig eigen inbreng telt niet (MIN_STUDENT_MESSAGES);
//  * het onderwerp moet een goedgekeurd begrip uit de cursus zijn (gegrond in
//    het cursusmateriaal) — anders geldt het achievement voor de hele cursus;
//  * op het hoogste niveau valt er niets meer te verdienen.
// De student blijft de baas: het niveau gaat pas omhoog als hij/zij dat bevestigt.

export const MIN_STUDENT_MESSAGES = 3;
const MIN_MESSAGE_CHARS = 15;
const MAX_LEVEL = 5;
const VERDICTS = ['ready', 'almost', 'not_yet'];
const MARKER_RE = /\[\[\s*LEAP_READINESS\b([^\]]*)\]\]/gi;

/** Zichtbare namen van de niveaus (gelijk aan learningLevel.levelN.label in de app). */
export const LEVEL_NAMES = {
  nl: { 1: 'Nieuw', 2: 'Beginner', 3: 'Gemiddeld', 4: 'Gevorderd', 5: 'Expert' },
  en: { 1: 'New', 2: 'Beginner', 3: 'Intermediate', 4: 'Advanced', 5: 'Expert' },
};
export const levelName = (level, lang = 'nl') => (LEVEL_NAMES[lang] || LEVEL_NAMES.en)[level] || String(level);

/** Instructie voor de systeemprompt bij een readiness-vraag. */
export function buildReadinessInstruction({ topics = [], currentLevel, lang = 'nl' }) {
  const next = Math.min(MAX_LEVEL, (currentLevel || 1) + 1);
  const list = topics.slice(0, 200).map(t => `- ${t.name}`).join('\n') || '- (none)';
  return `

READINESS ASSESSMENT (the student has asked whether they are ready for a higher learning level):
- The student is currently at level ${currentLevel} ("${levelName(currentLevel, 'en')}"); the next level is ${next} ("${levelName(next, 'en')}").
- Give your honest, well-founded assessment as usual, based ONLY on what the student has shown in this conversation.
- "ready": across several of their own messages the student shows understanding that fits the NEXT level (correct reasoning, own explanations, sensible follow-up questions). Small gaps are fine: mention them as tips for the next level. One good question is not enough.
- "almost": the student is partly there, but there are still substantial gaps or misconceptions that matter for the next level.
- "not_yet": the student mainly asks for basics or shows clear misunderstandings.
- Make your written conclusion match the verdict (e.g. say clearly that the student is ready when the verdict is "ready").
- At the very END of your answer, on a separate line, add exactly one label in this form (never mention or explain it; it is removed before the student sees your answer):
[[LEAP_READINESS verdict=ready topic="Topic name"]]
  verdict: ready | almost | not_yet
  topic: the course topic this conversation was mainly about, copied EXACTLY from this list, or NONE if no topic fits:
${list}`;
}

/**
 * Pure: haalt het label uit een antwoord. Geeft altijd de tekst zonder label
 * terug (ook als er meerdere of kapotte labels in staan).
 */
export function extractReadiness(text) {
  const raw = typeof text === 'string' ? text : '';
  let verdict = null;
  let topic = null;
  let hadMarker = false;
  for (const m of raw.matchAll(MARKER_RE)) {
    hadMarker = true;
    const attrs = m[1] || '';
    const v = attrs.match(/verdict\s*=\s*"?([a-z_]+)"?/i)?.[1]?.toLowerCase();
    if (v && VERDICTS.includes(v)) verdict = v;
    const tp = attrs.match(/topic\s*=\s*"([^"]*)"/i)?.[1] ?? attrs.match(/topic\s*=\s*([^\s"]+)/i)?.[1];
    if (tp && tp.trim() && tp.trim().toUpperCase() !== 'NONE') topic = tp.trim();
  }
  const cleaned = hadMarker ? raw.replace(MARKER_RE, '').replace(/\n{3,}/g, '\n\n').trim() : raw;
  return { text: cleaned, verdict, topic, hadMarker };
}

/** Pure: telt de eigen, inhoudelijke berichten van de student vóór de readiness-vraag. */
export function countPriorStudentMessages(messages) {
  const users = (Array.isArray(messages) ? messages : []).filter(m => m && m.role === 'user');
  return users.slice(0, -1).filter(m => String(m.content || '').trim().length >= MIN_MESSAGE_CHARS).length;
}

// ── Echte beurten (2026-10-09) ────────────────────────────────────────────────
// De gespreksgeschiedenis komt uit de browser en kon dus verzonnen worden om
// een prestatie te "verdienen". Daarom ondertekent de server elke beurt die
// echt door de tutor is beantwoord: HMAC over (gebruiker, cursus, tekst van het
// studentbericht). De browser bewaart die handtekening bij het antwoord en
// stuurt hem mee (`sig` op het assistent-bericht). Alleen ondertekende beurten
// tellen voor MIN_STUDENT_MESSAGES.

/** Handtekening van één beurt. `hmac(text)` levert een hex/base64-HMAC met het servergeheim. */
export function turnSignature(hmac, { userId, courseId, content }) {
  return hmac(`leap-turn-v1|${userId}|${courseId}|${String(content || '').trim()}`);
}

/**
 * Pure: telt de eigen, inhoudelijke berichten van de student vóór de
 * readiness-vraag die direct gevolgd worden door een door de server
 * ondertekend antwoord voor precies dat bericht, deze gebruiker en cursus.
 */
export function countVerifiedPriorStudentMessages(messages, { hmac, userId, courseId }) {
  const list = Array.isArray(messages) ? messages : [];
  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.role === 'user') { lastUser = i; break; }
  let n = 0;
  for (let i = 0; i < lastUser; i++) {
    const m = list[i];
    const next = list[i + 1];
    if (m?.role !== 'user' || next?.role !== 'assistant' || typeof next.sig !== 'string') continue;
    if (String(m.content || '').trim().length < MIN_MESSAGE_CHARS) continue;
    if (next.sig === turnSignature(hmac, { userId, courseId, content: m.content })) n++;
  }
  return n;
}

/** Pure: het onderwerp uit het label koppelen aan een begrip van de cursus (of null). */
export function matchTopic(topic, topics) {
  if (!topic) return null;
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const t = norm(topic);
  return topics.find(c => norm(c.name) === t) || null;
}

/**
 * Pure: telt dit oordeel voor een feestje + achievement?
 * Geeft { verdict, eligible, reason, currentLevel, nextLevel, concept }.
 */
export function evaluateReadiness({ verdict, topic, topics = [], priorStudentMessages = 0, currentLevel }) {
  const level = Number.isInteger(currentLevel) ? currentLevel : 1;
  const nextLevel = Math.min(MAX_LEVEL, level + 1);
  const concept = matchTopic(topic, topics);
  const base = { verdict: verdict || null, currentLevel: level, nextLevel, concept };
  if (verdict !== 'ready') return { ...base, eligible: false, reason: verdict ? 'not_ready' : 'no_verdict' };
  if (level >= MAX_LEVEL) return { ...base, eligible: false, reason: 'max_level' };
  if (priorStudentMessages < MIN_STUDENT_MESSAGES) return { ...base, eligible: false, reason: 'too_short' };
  return { ...base, eligible: true, reason: null };
}

/** Sleutel voor uniekheid: per begrip, of '' voor de hele cursus. */
export const topicKey = (concept) => (concept?.id ? String(concept.id) : '');
